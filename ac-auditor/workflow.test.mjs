import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const here=path.dirname(fileURLToPath(import.meta.url));
const workflow=fs.readFileSync(path.join(here,'workflow.yaml'),'utf8');
const shell=name=>workflow.split(`  ${name}:\n`)[1].split('    shell: |\n')[1].split('    on_signal:')[0];
const updates=output=>Object.fromEntries([...output.matchAll(/^<signal:var key=([a-z_]+)>(.*?)<\/signal:var>$/gm)]
  .map(([,key,value])=>[key,value]));

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'audit-specification-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const artifacts=path.join(root,'artifacts');fs.mkdirSync(artifacts);
  const helper=path.join(root,'context.sh');
  fs.writeFileSync(helper,`#!/bin/sh
if [ "$2" = prepare ]; then
  if [ "\${FLOW_ASSIGNMENT_INLINE:-true}" = true ]; then
    assignment="$(jq -c . "$MEDULLA_RUN_DIR/artifacts/input.json")"
    [ "$(printf '%s' "$assignment" | wc -c)" -lt 100000 ] || { echo 'assignment: context too large' >&2; exit 2; }
    case "$assignment" in *'</signal:var>'*) echo 'reserved signal delimiter in context' >&2; exit 2;; esac
    printf '<signal:var key=assignment>%s</signal:var>\n' "$assignment"
  fi
  echo '<signal:var key=auditor_contract>Frozen contract</signal:var>'
  echo '<signal:PREPARED>Ready</signal:PREPARED>'
fi
`,{mode:0o700});
  const env={...process.env,PLANNING_PYTHON:helper,CREW_FLOW_STAGES:'/absent/flow.py',MEDULLA_RUN_DIR:root,
      MEDULLA_WORKFLOW_DIR:here,REWORK_LIMIT:'2',AUDIT_FAIL_LIMIT:'3',AUDIT_FAIL_TAG:'manual-check',DRY_RUN:'false',STAGE_WRITES:'true',
      CRITIC_SECOND_HARNESS:'claude-code',AUDITOR_MODEL:'author',CRITIC_CODEX_MODEL:'first',CRITIC_SECOND_MODEL:'second',
      round:'3',shape_retries:'0',critique:JSON.stringify({codex:{verdict:'REWORK',findings:[{problem:'M needs review',advice:'Retain this finding'}]}}),
      FLOW_PUBLICATION:JSON.stringify({file:'operations.json',allowed_operations:['save_object','note'],create_kinds:[],update_kinds:['ac']})};
  const write=(name,value)=>fs.writeFileSync(path.join(artifacts,name),JSON.stringify(value));
  const read=name=>JSON.parse(fs.readFileSync(path.join(artifacts,name),'utf8'));
  const input={selected:{kind:'ac',address:'ac:a',current_revision:4,document:{data:{tags:[]}}},claim_revision:5,
    schema:{types:{ac:{},test:{},requirement:{},task:{}}},references:{},children:[{kind:'test',address:'test:existing'}]};
  const requirement={requirement:{address:'requirement:r'},siblings:[{address:'ac:sibling'}]};
  write('input.json',input);write('requirement.json',requirement);
  const run=name=>execFileSync('bash',['-c',shell(name)],{encoding:'utf8',env});
  return {root,artifacts,env,input,requirement,write,read,run};
}

test('prepare uses only the supplied specification and critics have no source readers', t => {
    const f=fixture(t),output=f.run('prepare');
    assert.match(output,/<signal:READY_TO_AUDIT>/);
    const assignmentPath=updates(output).audit_assignment_path;
    assert.equal(path.isAbsolute(assignmentPath),true);
    const assignment=JSON.parse(fs.readFileSync(assignmentPath,'utf8'));
    assert.equal(updates(output).auditor_contract,'Frozen contract');
    assert.equal(Object.hasOwn(updates(output),'assignment'),false);
    assert.equal(Object.hasOwn(updates(output),'audit_assignment'),false);
    assert.equal(assignment.requirement.address,'requirement:r');
    assert.equal(assignment.sibling_acs[0].address,'ac:sibling');
    assert.equal(Object.hasOwn(assignment,'develop_trees'),false);
    assert.deepEqual(assignment.children,[]);
    assert.equal(Object.hasOwn(assignment.schema.types,'test'),false);
    assert.equal(fs.existsSync(path.join(f.artifacts,'trees.json')),false);
    const critics=workflow.split('  critics:\n')[1].split('      shell: |\n')[1].split('    agent:')[0];
    const seats=JSON.parse(execFileSync('sh',['-c',critics],{encoding:'utf8',env:f.env}));
    const first=Object.values(seats[0]);assert.ok(first.includes('features.shell_tool=false'));
    assert.ok(first.includes('features.apps=false'));assert.ok(first.includes('--ignore-user-config'));
    const second=Object.values(seats[1]);assert.ok(second.includes('--tools='));
    assert.ok(second.includes('{"mcpServers":{}}'));
});

test('the full assignment exceeds the environment limit and preserves literal template tokens as JSON data', t => {
  const f=fixture(t),sentinel=path.join(f.root,'host-sentinel.txt');
  fs.writeFileSync(sentinel,'HOST_FILE_MUST_NOT_APPEAR');
  const literal=`{{file:${sentinel}}} {{var:auditor_contract}} {{input}} \\{{file:${sentinel}}}`;
  f.input.selected.annotations={comments:{note:{text:'x'.repeat(108000)+literal}}};
  f.input.help={unused:true};
  f.input.schema.types.source={};
  f.input.references.sources=[{kind:'source',body:literal}];
  f.requirement.siblings[0].body=literal+'</signal:var>'+'s'.repeat(60000);
  assert.ok(Buffer.byteLength(JSON.stringify(f.input))>100000);
  f.write('input.json',f.input);f.write('requirement.json',f.requirement);
  const output=f.run('prepare'),vars=updates(output),serialized=fs.readFileSync(vars.audit_assignment_path,'utf8');
  assert.ok(Buffer.byteLength(serialized)>100000);
  assert.ok(Buffer.byteLength(output)<2000);
  assert.equal(serialized.includes('{{'),false);
  assert.equal(serialized.includes('HOST_FILE_MUST_NOT_APPEAR'),false);
  const expected={...f.input,children:[],schema:{types:{ac:{},requirement:{},source:{}}},
    requirement:f.requirement.requirement,sibling_acs:f.requirement.siblings};
  delete expected.help;delete expected.claim_revision;
  assert.deepEqual(JSON.parse(serialized),expected);
  assert.equal((workflow.match(/Assignment: \{\{file:\{\{var:audit_assignment_path\}\}\}\}/g)||[]).length,2);
});

test('the shared producer refuses oversized input before the Auditor filter unless inline output is disabled', t => {
  const f=fixture(t); f.input.selected.document.data.body='я'.repeat(51000); f.write('input.json',f.input);
  const baseline=spawnSync(f.env.PLANNING_PYTHON,[f.env.CREW_FLOW_STAGES,'prepare'],
    {encoding:'utf8',env:{...f.env,FLOW_ASSIGNMENT_INLINE:'true'}});
  assert.equal(baseline.status,2); assert.match(baseline.stderr,/context too large/);
  assert.match(f.run('prepare'),/<signal:READY_TO_AUDIT>/);
});

test('one format retry survives an exhausted critic round and preserves its findings until both critics review the new digest', t => {
  const f=fixture(t),critique=f.env.critique;
  const draft={summary:'Audit',scores:Object.fromEntries(['G','A','U','M','V','R'].map(item=>[item,{score:1,evidence:'Quote'}]))};
  draft.scores.M.evidence='m'.repeat(1061);f.write('draft.json',draft);
  const original=fs.readFileSync(path.join(f.artifacts,'draft.json'),'utf8');
  const invalid=f.run('draft_check'),vars=updates(invalid);
  assert.match(invalid,/<signal:REVISE>/);
  assert.equal(vars.shape_retries,'1');
  assert.deepEqual(JSON.parse(vars.shape_feedback),['M: evidence has 1061 characters, at most 1000. Shorten it.']);
  assert.equal(Object.hasOwn(vars,'round'),false);assert.equal(Object.hasOwn(vars,'critique'),false);
  assert.equal(fs.readFileSync(path.join(f.artifacts,'draft.json'),'utf8'),original);
  Object.assign(f.env,vars);
  const exhausted=f.run('draft_check');assert.match(exhausted,/<signal:DISPUTED>/);
  assert.match(fs.readFileSync(path.join(f.artifacts,'failure.txt'),'utf8'),/1061 characters/);
  assert.equal(fs.existsSync(path.join(f.artifacts,'operations.json')),false);
  draft.scores.M.evidence='Exact quote';f.write('draft.json',draft);
  f.write('critic-codex.json',{draft_digest:'stale'});f.write('critic-second.json',{draft_digest:'stale'});
  const valid=f.run('draft_check'),checked=updates(valid);
  assert.match(valid,/<signal:CHECKED>/);
  assert.equal(checked.shape_retries,'0');assert.equal(checked.shape_feedback,'');
  assert.equal(checked.draft_digest,createHash('sha256').update(fs.readFileSync(path.join(f.artifacts,'draft.json'))).digest('hex'));
  assert.equal(fs.existsSync(path.join(f.artifacts,'critic-codex.json')),false);
  assert.equal(fs.existsSync(path.join(f.artifacts,'critic-second.json')),false);
  Object.assign(f.env,checked);
  assert.equal(f.env.critique,critique);assert.equal(f.env.round,'3');
  assert.match(workflow,/Critic findings[^\n]*\{\{var:critique\}\}/);
  assert.match(workflow,/Output format problems[^\n]*\{\{var:shape_feedback\}\}/);
  assert.match(workflow,/CHECKED: critics/);
  const review=digest=>({draft_digest:digest,verdict:'APPROVE',findings:[],summary:'Checked',
    scores:Object.fromEntries(['G','A','U','M','V','R'].map(item=>[item,{agree:true,evidence:'Quote'}]))});
  f.write('critic-codex.json',review(checked.draft_digest));f.write('critic-second.json',review('stale'));
  assert.match(f.run('review_join'),/<signal:DISPUTED>/);
  assert.equal(fs.existsSync(path.join(f.artifacts,'operations.json')),false);
  f.write('critic-second.json',review(checked.draft_digest));
  assert.match(f.run('review_join'),/<signal:APPROVED>/);
  assert.equal(f.read('operations.json').outcome.reason_code,'PASS');
});
