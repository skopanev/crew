import {createHash} from 'node:crypto';
import {checkRepair, repairPublication} from './repair-plan.mjs';
import {retirementBinding} from './retirement-proof.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const settings = JSON.parse(fs.readFileSync(new URL("config.example.json", import.meta.url), "utf8")).vars;

test('the machine-check CLI refuses body estimates for new Tasks and READY, and rejects changed AC repairs', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tasker-repair-main-'));
  try {
    const repo=path.join(root,'repo'),artifacts=path.join(root,'artifacts');fs.mkdirSync(repo);fs.mkdirSync(artifacts);
    fs.writeFileSync(path.join(repo,'file.ts'),'export {};\n');
    const env={...process.env,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',
      GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid',GIT_CONFIG_GLOBAL:'/dev/null'};
    const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',env});
    git('init','-q');git('add','.');git('commit','-q','-m','Base');const sha=git('rev-parse','HEAD').trim();
    const node=(address,data)=>({address,kind:address.split(':')[0],current_revision:4,document:{data,present:true}});
    const criterion=node('ac:a',{title:'Current AC',body:'Required outcome'}),task=node('task:t',{title:'Existing Task',body:'Old work'});
    const input={selected:task,claim_revision:5,schema:{types:{task:{role:'task',field_max_length:4096},ac:{role:'ac'},test:{role:'test'}}},
      context:{parent:criterion,children:[],references:{},incoming:[]}};
    const draft={verdict:'READY',reason:'The same bounded work is still needed',task:{id:'t',title:'Existing Task',repository:'app',
      files:[{path:'file.ts',change:'edit',lines:4}],tests:[],depends_on:[],
      body:'Criterion: ac:a@4. Required outcome\nRepository: app\nFiles: file.ts\nTests:'}};
    const write=(name,value)=>fs.writeFileSync(path.join(artifacts,name),JSON.stringify(value));
    write('input.json',input);write('draft.json',draft);write('trees.json',{app:{path:repo,sha}});
    const here=path.dirname(fileURLToPath(import.meta.url));
    const execute=changed=>{
      write('repair.json',{ac_text_changed:changed});
      return spawnSync(process.execPath,[path.join(here,'check.mjs'),artifacts],{encoding:'utf8',env:{...env,
        CREW_WORKFLOW_DIR:path.resolve(here,'../workflow'),PLAN_MAX_FILES:'8',PLAN_MAX_LINES:'300'}});
    };
    const ready=execute(false);assert.equal(ready.status,0,ready.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(artifacts,'check.json'),'utf8')).ok,true);
    const cleanBody=draft.task.body+'\nDo:\n- Edit file.ts.\n- Keep the payload unchanged.';
    const acDraft={verdict:'OK',reason:draft.reason,tasks:[{...draft.task,id:'t1'}]};
    for (const [assignment,value,planned] of [[input,draft,draft.task],
      [{selected:criterion,children:[],schema:input.schema},acDraft,acDraft.tasks[0]]]) {
      write('input.json',assignment);planned.body=cleanBody;write('draft.json',value);
      assert.equal(execute(false).status,0,'Keep real file paths and the Tests header');
      for (const line of ['Size: three files, about 179 lines','Gate: 12 Test files','Line count: 179','file.ts (~179 lines)']) {
        planned.body=cleanBody+'\n'+line;write('draft.json',value);
        const refused=execute(false);assert.equal(refused.status,1,refused.stderr);
        const result=JSON.parse(fs.readFileSync(path.join(artifacts,'check.json'),'utf8'));
        assert.equal(result.ok,false);assert.match(result.problems.join(),/restriction/i);
      }
      for (const line of ['Reporter name: file.test.ts > case','Expected: result','Command: bun run test']) {
        planned.body=cleanBody+'\n'+line;write('draft.json',value);
        const refused=execute(false);assert.equal(refused.status,1,refused.stderr);
        assert.match(JSON.parse(fs.readFileSync(path.join(artifacts,'check.json'),'utf8')).problems.join(), /keep Reporter names, Expected and command/);
      }
    }
    draft.task.body=cleanBody;write('input.json',input);write('draft.json',draft);
    const stale=execute(true);assert.equal(stale.status,1,stale.stderr);
    assert.match(JSON.parse(fs.readFileSync(path.join(artifacts,'check.json'),'utf8')).problems.join(),/pinned AC contract changed/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('the workflow review join gates all repair verdicts on two exact reviews and keeps dry runs empty', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tasker-repair-review-'));
  try {
    const artifacts=path.join(root,'artifacts');fs.mkdirSync(artifacts);
    const here=path.dirname(fileURLToPath(import.meta.url));
    const workflow=fs.readFileSync(path.join(here,'workflow.yaml'),'utf8');
    const shell=workflow.split('  review_join:\n')[1].split('    shell: |\n')[1].split('    on_signal:')[0];
    const node=(address,data)=>({address,kind:address.split(':')[0],current_revision:4,document:{data,present:true}});
    const input={selected:node('task:t',{title:'Existing',body:'Old'}),claim_revision:5,schema:{types:{task:{role:"task",fields:{stage:{values:[settings.TASKER_TASK_REVIEW_STAGE]}}}}},
      context:{parent:node('ac:a',{title:'Current',body:'Outcome'}),children:[],references:{},incoming:[]}};
    const write=(name,value)=>fs.writeFileSync(path.join(artifacts,name),JSON.stringify(value));
    write('input.json',input);write('repair.json',{ac_text_changed:true});write('trees.json',{});
    const keys=['gate','size','reporter_names','outside_files','already_in_develop','ac_test_consistency','ac_scope'];
    const execute=(draft,{dry=false,oldDigest=false}={})=>{
      write('draft.json',draft);
      const digest=execFileSync('shasum',['-a','256',path.join(artifacts,'draft.json')],{encoding:'utf8'}).split(' ')[0];
      const review={draft_digest:digest,verdict:'APPROVE',checks:Object.fromEntries(keys.map(k=>[k,{ok:true,evidence:'Verified'}])),findings:[]};
      write('critic-codex.json',review);write('critic-second.json',{...review,draft_digest:oldDigest?'old':digest});
      const file=path.join(artifacts,'operations.json');if(fs.existsSync(file))fs.unlinkSync(file);
      const log=execFileSync('sh',['-c',shell],{encoding:'utf8',env:{...process.env,...settings,MEDULLA_RUN_DIR:root,
        MEDULLA_WORKFLOW_DIR:here,FLOW_PUBLICATION:JSON.stringify({file:'operations.json'}),DRY_RUN:String(dry),
        TASK_STAGE:'to_implement',TASKER_RETURN_LIMIT:'3',REWORK_LIMIT:'3',round:'4'}});
      return {log,publication:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null};
    };
    const ready={verdict:'READY',reason:'Still needed',task:{id:'t',title:'Existing',body:'Updated'}};
    const current=execute(ready);assert.match(current.log,/<signal:APPROVED>/);
    assert.equal(current.publication.operations[0].command.id,'t');
    assert.equal(current.publication.outcome.reason_code,'READY');
    const stale=execute({verdict:'STALE',reason:'Changed AC',needs_code:true});
    assert.deepEqual(stale.publication.operations.map(x=>x.command.op),['save_object','archive_object']);
    assert.equal(stale.publication.operations[0].command.id,'a');
    const decision=execute({verdict:'DECISION_REQUIRED',reason:'Missing choice',gap:{owner:'cto',question:'A or B?',a:'A.',b:'B.',recommended:'A'}});
    assert.deepEqual(decision.publication.operations.map(x=>x.command.op),['save_object','note']);
    assert.equal(decision.publication.operations[0].command.revision,5);
    assert.deepEqual(decision.publication.operations[0].command.data,{stage:'to_review',tags:[JSON.parse(settings.TASKER_GAP_TAGS).cto]});
    const dryDecision=execute({verdict:'DECISION_REQUIRED',reason:'Missing choice',gap:{owner:'cto',question:'A or B?',a:'A.',b:'B.',recommended:'A'}},{dry:true});
    assert.deepEqual(dryDecision.publication.operations,[]);
    const dry=execute(ready,{dry:true});assert.deepEqual(dry.publication.operations,[]);
    assert.equal(dry.publication.outcome.reason_code,'DRY_RUN');
    const noProof=execute({verdict:'STALE',reason:'Existing parent behavior',needs_code:false,done_commit:'abc1234'});
    assert.equal(noProof.publication,null);assert.match(noProof.log,/<signal:REJECTED>/);
    const refused=execute(ready,{oldDigest:true});assert.equal(refused.publication,null);
    assert.match(refused.log,/<signal:REJECTED>/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});


test('a live Task rejection publishes to_review and exact critic reasons, while a dry run publishes no changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-rejected-task-'));
  try {
    const artifacts = path.join(root, 'artifacts'); fs.mkdirSync(artifacts);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const workflow = fs.readFileSync(path.join(here, 'workflow.yaml'), 'utf8');
    const shell = workflow.split('  rejected:\n')[1].split('    shell: |\n')[1].split('    on_signal:')[0];
    const input = {selected: {address: 'task:t', kind: 'task', document: {data: {body: 'Work\nRepository: repo'}}}, claim_revision: 8,
      schema: {types: {task: {role: 'task', fields: {stage: {values: [settings.TASKER_TASK_REVIEW_STAGE]}, repository: {type: 'enum', values: ['repo','other']}}}}}};
    fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify(input));
    const reason = 'codex: the prerequisite is missing. second: the caller is missing.\n' + 'я'.repeat(2000) + 'END';
    fs.writeFileSync(path.join(artifacts, 'failure.txt'), reason);
    const execute = (dry, config = settings) => {
      const log = execFileSync('sh', ['-c', shell], {encoding: 'utf8', env: {...process.env, ...config,
        MEDULLA_RUN_DIR: root, MEDULLA_WORKFLOW_DIR: here, DRY_RUN: String(dry), TASKER_RETURN_LIMIT: '3',
        FLOW_PUBLICATION: JSON.stringify({file: 'operations.json'})}});
      assert.match(log, /<signal:DECISION>/);
      return JSON.parse(fs.readFileSync(path.join(artifacts, 'operations.json'), 'utf8'));
    };
    const live = execute(false);
    assert.deepEqual(live.operations[0].command, {op: 'save_object', kind: 'task', id: 't', revision: 8,
      data: {stage: 'to_review', repository: 'repo'}, reason: reason.slice(0, 1000)});
    assert.equal(live.operations[1].command.op, 'note');
    assert.equal(live.operations[1].command.target, 'task:t');
    assert.equal(live.operations[1].command.text, reason);
    assert.equal(live.outcome.reason_code, 'REJECTED');
    const legacy = JSON.parse(execFileSync('jq', ['-n', '--arg', 'dry', 'false', '--arg', 'run', 'old-snapshot', "--arg", "task_review_stage", settings.TASKER_TASK_REVIEW_STAGE,
      '--slurpfile', 'input', path.join(artifacts, 'input.json'), '--rawfile', 'reason', path.join(artifacts, 'failure.txt'),
      '-f', path.join(here, 'rejected.jq')], {encoding: 'utf8'}));
    assert.deepEqual(legacy.operations[0].command.data, {stage: 'to_review'});
    input.schema.types.task.fields.stage.values.push("review-again");
    fs.writeFileSync(path.join(artifacts, "input.json"), JSON.stringify(input));
    assert.equal(execute(false, {...settings, TASKER_TASK_REVIEW_STAGE: "review-again"}).operations[0].command.data.stage, "review-again");
    const dry = execute(true);
    assert.deepEqual(dry.operations, []);
    assert.equal(dry.outcome.reason_code, 'DRY_RUN');
    for (const data of [{body:'No code needed'}, {body:'Repository: repo\nRepository: other'},
      {repository:'conflict',body:'Repository: repo'}]) {
      input.selected.document.data=data;
      fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify(input));
      const unresolved=execute(false);
      assert.deepEqual(unresolved.operations[0].command.data,{stage:'to_review'});
      assert.equal(unresolved.outcome.reason_code,'REJECTED');
      assert.equal(unresolved.operations[1].command.text,reason);
    }
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('the configured Tasker inputs admit review Tasks and never select people-owned decisions', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(fs.readFileSync(path.join(here, 'config.example.json'), 'utf8'));
  const inputs = config.inputs.filter(input => input.selection.kind === 'task');
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0].selection.data, {stage: 'to_review'});
  assert.equal(inputs[0].selection.assignee, '');
  assert.equal(Object.hasOwn(inputs[0],'exclude_tags'),false);
  assert.ok(config.exclude_tags.includes(JSON.parse(config.vars.TASKER_GAP_TAGS).cto));
  assert.ok(config.exclude_tags.includes(JSON.parse(config.vars.TASKER_GAP_TAGS).ceo));
});

test('sample0001 cannot retire private exports or remove its consumer dependency', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tasker-own-deliverables-'));
  try {
    const repo=path.join(root,'repo');fs.mkdirSync(repo);
    const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',
      GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
    const git=(...args)=>execFileSync('git',['-C',repo,'-c','core.hooksPath=/dev/null',...args],{encoding:'utf8',env}).trim();
    git('init','-q');
    const file=path.join(repo,'party-entry.ts');
    fs.writeFileSync(file,'const Body = {}; function strict() {} export function registerTravelRulePartyEntryRoute() {}\n');
    git('add','.');git('commit','-q','-m','Existing deposit behavior');
    const sha=git('rev-parse','HEAD');
    const node=(address,data)=>({address,kind:address.split(':')[0],current_revision:4,document:{data,present:true}});
    const input={selected:node('task:sample0001',{title:'Export staff entry checks',repository:'repo',
      body:'Repository: repo\nFiles: party-entry.ts\nDo:\n1. Export Body and strict for the dependent route.\nChecks: existing deposit cases.'}),
      claim_revision:5,schema:{types:{task:{role:'task',fields:{repository:{type:'enum',values:['repo']}}}}},
      context:{parent:node('ac:a',{title:'Staff entry',body:'Required behavior'}),children:[],references:{},
        incoming:[{...node('task:sample0002',{body:'Use the shared Body and strict',stage:'to_implement'}),
          relations:{depends_on:{edges:[{to:'task:sample0001'}]}}}]}};
    let trees={repo:{path:repo,repo,sha}};
    const repair={ac_text_changed:false},before=structuredClone(input);
    const proof=()=>({...retirementBinding(input,trees),files:[{path:'party-entry.ts',exports:['Body','strict']}]});
    const options=draft=>{const digest=createHash('sha256').update(JSON.stringify(draft)).digest('hex');return {input,repair,trees,draft,digest,run:'regression',
      reviews:[0,1].map(()=>({draft_digest:digest,verdict:'APPROVE',checks:{already_in_develop:{ok:true,task_deliverables_complete:true}}}))};};
    for (const needs_code of [false,true]) {
      const draft={verdict:'STALE',reason:'Deposit behavior exists',needs_code,done_commit:sha,retirement_proof:proof()};
      const checked=checkRepair({...options(draft),requiredDoneCommit:sha,maxFiles:8,maxLines:300,forecast:()=>null,
        checkPlan:()=>({ok:true,problems:[],tasks:[]})});
      assert.equal(checked.ok,false);assert.match(checked.problems.join(),/Body|strict/);
      const output=repairPublication(options(draft));
      assert.equal(output.approved,false);assert.equal(output.publication,undefined);
      assert.match(output.critique.host.invalid,/deliverables are not verified/);
    }
    assert.deepEqual(input,before);
    fs.writeFileSync(file,'export const Body = {}; export function strict() {} export function registerTravelRulePartyEntryRoute() {}\n');
    git('add','.');git('commit','-q','-m','Export the required staff checks');
    const done=git('rev-parse','HEAD');trees={repo:{path:repo,repo,sha:done}};
    const draft={verdict:'STALE',reason:'All Task deliverables exist',needs_code:false,done_commit:done,retirement_proof:proof()};
    const completed=repairPublication(options(draft)).publication;
    assert.equal(completed.outcome.reason_code,'STALE');
    const released=completed.operations.find(row=>row.command.relations);
    assert.ok(released,'A complete retirement releases its verified prerequisite');
    assert.deepEqual(released.command.relations.depends_on.edges,[]);
    assert.equal(completed.operations.at(-1).command.op,'archive_object');
    assert.equal(completed.operations.at(-1).command.target,'task:sample0001');
    const artifacts=path.join(root,'artifacts');fs.mkdirSync(artifacts);
    const current=options(draft);
    for (const [name,value] of Object.entries({input,repair,trees,draft,
      'critic-codex':current.reviews[0],'critic-second':current.reviews[1]})) {
      fs.writeFileSync(path.join(artifacts,name+'.json'),JSON.stringify(value));
    }
    const here=path.dirname(fileURLToPath(import.meta.url));
    const command=[path.join(here,'repair-context.mjs'),'publication',artifacts];
    const published=JSON.parse(execFileSync(process.execPath,command,{encoding:'utf8'}));
    assert.equal(published.publication.operations.at(-1).command.op,'archive_object');
    current.reviews[1].checks.already_in_develop.task_deliverables_complete=false;
    fs.writeFileSync(path.join(artifacts,'critic-second.json'),JSON.stringify(current.reviews[1]));
    const refused=JSON.parse(execFileSync(process.execPath,command,{encoding:'utf8'}));
    assert.equal(refused.approved,false);assert.equal(refused.publication,undefined);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
