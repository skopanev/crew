import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {input, draft, review, kind} from './test-support/reconcile.fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflow = fs.readFileSync(path.join(here, 'workflow.yaml'), 'utf8');
const body = name => workflow.split('  ' + name + ':\n')[1].split('    shell: |\n')[1].split('    on_signal:')[0];
const updates = output => Object.fromEntries([...output.matchAll(/^<signal:var key=([A-Za-z_]+)>(.*?)<\/signal:var>$/gm)]
  .map(([, key, value]) => [key, value]));
function fixture(t, {mode = 'reconcile', dry = false, plan = draft()} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writer-flow-'))), a = path.join(root, 'artifacts');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(a);
  const write = (name, value) => fs.writeFileSync(path.join(a, name), JSON.stringify(value));
  const read = name => JSON.parse(fs.readFileSync(path.join(a, name), 'utf8'));
  write('input.json', input()); write('draft.json', plan);
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({selection: {kind: 'ac'}, failure_notes: false, exclude_tags: ['source-gap-cto', 'stuck']}));
  const engine = path.join(root, 'stages.mjs');
  fs.writeFileSync(engine, `import fs from 'node:fs';import path from 'node:path';
const a=path.join(process.env.MEDULLA_RUN_DIR,'artifacts');
fs.appendFileSync(path.join(a,'engine-calls'),' '+process.argv[2]);
if(process.argv[2]==='publish')fs.copyFileSync(path.join(a,'operations.json'),path.join(a,'captured.json'));
if(process.argv[2]==='prepare') {
  if(process.env.PREPARE_BLOCKED==='true'){console.log('<signal:BLOCKED>No item</signal:BLOCKED>');process.exit(0);}
  if(process.env.PREPARE_FAILED==='true'){console.error('shared prepare failed');process.exit(2);}
  if((process.env.FLOW_ASSIGNMENT_INLINE??'true')==='true') {
    const assignment=JSON.stringify(JSON.parse(fs.readFileSync(path.join(a,'input.json'),'utf8')));
    if(Buffer.byteLength(assignment)>=100000){console.error('assignment: context too large');process.exit(2);}
    if(assignment.includes('</signal:var>')){console.error('reserved signal delimiter in context');process.exit(2);}
    console.log('<signal:var key=assignment>'+assignment+'</signal:var>');
  }
  console.log('<signal:var key=author_contract>Author contract</signal:var>');
  console.log('<signal:var key=critic_contract>Critic contract</signal:var>');
}
console.log('<signal:PREPARED>Ready</signal:PREPARED>');`);
  const publication = {file: 'operations.json', allowed_operations: ['save_object', 'archive_object', 'note'],
    create_kinds: mode === 'update' ? [] : [kind], update_kinds: ['ac', kind]};
  const env = {...process.env, PLANNING_PYTHON: process.execPath, CREW_FLOW_STAGES: engine,
    FLOW_PUBLICATION: JSON.stringify(publication), PLANNING_JOPPA_CONFIG: config, MEDULLA_RUN_DIR: root,
    MEDULLA_WORKFLOW_DIR: here, TEST_KIND: kind, TEST_OPERATION: mode, DRY_RUN: String(dry),
    REWORK_LIMIT: '3', round: '4', SOURCE_GAP_TAG: 'source-gap-cto', RETURNS_LIMIT: '3', STUCK_TAG: 'stuck',
    READY_STAGE: 'to_task', RETURN_STAGE: 'to_decide', FINDING_CRITERIA: 'G A U M V R',
    AUTHOR_MODEL: 'author', CRITIC_CODEX_MODEL: 'first', CRITIC_SECOND_MODEL: 'second', CRITIC_SECOND_HARNESS: 'claude-code'};
  const critics = (change = value => value) => {
    const digest = createHash('sha256').update(fs.readFileSync(path.join(a, 'draft.json'))).digest('hex');
    write('critic-codex.json', review(plan, digest)); write('critic-second.json', change(review(plan, digest)));
  };
  const run = name => execFileSync('bash', ['-c', body(name)], {env, encoding: 'utf8'});
  return {root, a, config, env, write, read, critics, run, engine};
}

test('a three-part AC finding returns the AC to to_decide with returns + 1 and no Test change, in reconcile and create', t => {
  for (const mode of ['reconcile', 'create']) {
    const plan = mode === 'create' ? {tests: [{id: 'n1', title: 'spec/n.test.ts > new', data: {body: 'New text.'}}], retire: [], coverage: 'c'} : draft();
    const f = fixture(t, {mode, plan});
    const state = input(); state.selected.document.data.returns = 1;
    state.references.sources.push({address: 'source:s1', kind: 'source', document: {data: {body: 'The Source says x.'}}});
    f.write('input.json', state);
    assert.match(f.run('draft_check'), /<signal:DRAFTED>/);
    const findings = [{criterion: 'G', ac_quote: 'correct u', source_quote: 'The Source says x.', source: 'source:s1'}];
    f.critics(value => ({...value, coverage: 'incomplete', missing: ['m'], ac_findings: findings}));
    assert.match(f.run('review_join'), /<signal:MISSING>/);
    const result = f.read('operations.json'), commands = result.operations.map(row => row.command);
    assert.equal(result.outcome.reason_code, 'AC_DEFECT');
    assert.deepEqual(commands.map(row => row.op), ['save_object', 'note']);
    assert.deepEqual(commands[0].data, {stage: 'to_decide', returns: 2});
    assert.match(commands[1].text, /- G: "correct u" breaks "The Source says x\." \(source:s1\)/);
  }
});

test('a critic rejection without a three-part finding keeps the AC stage, and the third return adds stuck', t => {
  const f = fixture(t);
  const state = input(); state.selected.document.data.returns = 2; f.write('input.json', state);
  assert.match(f.run('draft_check'), /<signal:DRAFTED>/);
  f.critics(value => ({...value, coverage: 'incomplete', missing: ['m'],
    ac_findings: [{criterion: 'G', ac_quote: 'a paraphrase of the AC', source_quote: 'x', source: 'source:none'}]}));
  assert.match(f.run('review_join'), /<signal:REJECTED>/);
  assert.match(f.run('rejected'), /<signal:RETURN>/);
  const commands = f.read('operations.json').operations.map(row => row.command);
  assert.deepEqual(commands[0].data, {returns: 3, tags: ['keep', 'stuck']});
  assert.equal(commands.some(row => row.data?.stage), false);
  assert.match(commands.at(-1).text, /^OPEN QUESTION \(Owner, tag stuck\): Writer failed on this AC 3 times in a row/);
  assert.equal(f.read('operations.json').outcome.reason_code, 'REJECTED');
});

test('a disputed rewrite of a covering Test reaches rejection with the critic evidence and changes no Test', t => {
  const f = fixture(t);
  assert.match(f.run('draft_check'), /<signal:DRAFTED>/);
  f.critics(value => ({...value, updates: [{id: 'u', agree: false, evidence: 'The captured Test u already covers the AC.'}]}));
  assert.match(f.run('review_join'), /<signal:REJECTED>/);
  assert.match(fs.readFileSync(path.join(f.a, 'failure.txt'), 'utf8'), /\nsecond:\n- Update u: The captured Test u already covers the AC\./);
  f.run('rejected');
  assert.ok(f.read('operations.json').operations.every(row => row.command.kind !== kind));
});

test('a rejection keeps every reason of every failing Test of both critics in failure.txt and in the AC note', t => {
  const f = fixture(t);
  assert.match(f.run('draft_check'), /<signal:DRAFTED>/);
  const reasons = id => ['First ' + id + ' reason ' + 'r'.repeat(500), 'Second ' + id + ' reason.'];
  f.critics(value => ({...value, tests: value.tests.map(row => ({...row, score: '01111', reasons: reasons(row.id)})),
    coverage: 'incomplete', missing: ['The refusal outcome.'], summary: 'Two critics disagree.'}));
  assert.match(f.run('review_join'), /<signal:REJECTED>/);
  const failure = fs.readFileSync(path.join(f.a, 'failure.txt'), 'utf8');
  for (const id of ['k', 'u', 'new_1']) for (const text of reasons(id)) assert.ok(failure.includes(text), text.slice(0, 20));
  assert.match(failure, /\nsecond:\n- Test k score 01111: First k reason/);
  assert.match(failure, /- Missing: The refusal outcome\.\n- Two critics disagree\./);
  f.run('rejected');
  assert.ok(f.read('operations.json').operations[1].command.text.endsWith(failure));
});

test('approved create Tests end with the configured ready stage and returns 0', t => {
  const plan = {tests: [{id: 'n1', title: 'spec/n.test.ts > new', data: {body: 'New text.'}}], retire: [], coverage: 'c'};
  const f = fixture(t, {mode: 'create', plan});
  assert.match(f.run('draft_check'), /<signal:DRAFTED>/);
  f.critics();
  assert.match(f.run('review_join'), /<signal:APPROVED>/);
  const commands = f.read('operations.json').operations.map(row => row.command);
  assert.deepEqual(commands.map(row => row.kind), [kind, 'ac']);
  assert.deepEqual(commands.at(-1).data, {stage: 'to_task', returns: 0});
});
