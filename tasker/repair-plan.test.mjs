import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {contractHash} from './test-bindings.mjs';
import {changedText, repairView, checkRepair, repairPublication as publishRepair, repositoryData} from './repair-plan.mjs';
const repairPublication = options => publishRepair({stages:{task:'to_implement',ready:'to_task',review:'to_review'},...options});
import {bodyProblems, captureRepair} from './repair-context.mjs';
import {fileURLToPath} from 'node:url';
const node = (address, data, extra = {}) => ({address, kind: address.split(':')[0], current_revision: 4,
  document: {data, parent: null, present: true}, ...extra});
const parent = node('ac:a', {title:'Current AC', body:'Current condition', stage:'to_implement'});
const task = node('task:t', {title:'Existing Task', body:'Old work', stage:'to_review'});
const group = {title:'Prerequisites', color:'#123456', facts:{why:'keep'}, edges:[{to:'task:t',revision:2},{to:'task:other',revision:3}]};
const consumer = node('task:consumer', {body:'Dependent work', stage:'to_implement'}, {relations:{depends_on:group,related:{edges:[{to:'ac:elsewhere'}]}}});
const gapTags = {cto:'ask-engineering',ceo:'ask-policy'};
const gap = {owner:'cto',question:'A or B?',a:'A.',b:'B.',recommended:'A'};
const input = () => ({selected:structuredClone(task),claim_revision:5,schema:{types:{ac:{},task:{},test:{}}},
  context:{parent:structuredClone(parent),children:[],references:{},incoming:[structuredClone(consumer)]}});
const checked = (draft, repair = {ac_text_changed:false}) => checkRepair({input:input(),repair,draft,trees:{},
  maxFiles:8,maxLines:300,forecast:()=>null,checkPlan:()=>({ok:true,problems:[],tasks:[]})});

test('metadata revisions do not change AC text, title and body changes do', () => {
  assert.equal(changedText(parent,{...parent,current_revision:1}),false);
  assert.equal(changedText(parent,node('ac:a',{title:'Old title',body:'Current condition'})),true);
  assert.equal(changedText(parent,node('ac:a',{title:'Current AC',body:'Old condition'})),true);
});
test('READY preserves the Task id and title; changed AC requires retirement', () => {
  const draft={verdict:'READY',reason:'Current work',task:{id:'t',title:'Existing Task',repository:'repo',tests:[],body:'Repository: repo'}};
  assert.equal(checked(draft).ok,true);
  assert.equal(checked({...draft,task:{...draft.task,id:'new'}}).ok,false);
  assert.equal(checked(draft,{ac_text_changed:true}).ok,false);
  const output=repairPublication({gapTags,input:input(),draft,run:'run'}).publication;
  assert.equal(output.operations.length,1);
  assert.deepEqual(output.operations[0].command.data,{body:draft.task.body,repository:'repo',stage:'to_implement',
    ac_contract_hash:contractHash({selected:parent,children:[],schema:input().schema})});
  assert.equal(output.operations[0].command.id,'t');
  assert.equal(output.operations[0].command.revision,5);
});
test('STALE keeps prerequisite edges while work remains and refuses retirement without proof', () => {
  const original=input();const before=structuredClone(original);
  const build=needs_code=>repairPublication({gapTags,input:original,repair:{ac_text_changed:true},draft:{verdict:'STALE',reason:'Old AC',needs_code},run:'run'}).publication;
  const work=build(true);
  assert.deepEqual(work.operations.map(row=>row.command.op),['save_object','archive_object']);
  assert.ok(work.operations.every(row=>!row.command.relations&&row.command.id!=='consumer'));
  assert.deepEqual(work.operations[0].command.data,{stage:'to_task'});
  assert.equal(work.operations[1].command.op,'archive_object');
  assert.equal(work.operations[1].command.target,'task:t');
  const refused=repairPublication({input:original,repair:{ac_text_changed:true},draft:{verdict:'STALE',reason:'Old AC',needs_code:false},run:'run'});
  assert.equal(refused.approved,false);assert.equal(refused.publication,undefined);
  assert.deepEqual(original,before);
});
test('DECISION_REQUIRED tags only the claimed Task and records the typed owner question', () => {
  const original=input();
  original.schema.types.task.fields={repository:{type:'enum',values:['repo','other']}};
  original.selected.document.data.body='Old work\nRepository: repo';
  const frozen=structuredClone(original);
  const draft={verdict:'DECISION_REQUIRED',reason:'No decision',gap};
  const output=repairPublication({gapTags,input:original,draft,run:'run'}).publication;
  assert.equal(output.operations.length,2);
  assert.deepEqual(output.operations[0].command,{op:'save_object',kind:'task',id:'t',revision:5,
    data:{stage:'to_review',repository:'repo',tags:['ask-engineering']},reason:'No decision'});
  assert.equal(output.operations[1].command.op,'note');
  assert.equal(output.operations[1].command.target,'task:t');
  assert.equal(output.operations[1].command.text,'OPEN QUESTION\nOwner: cto\nQuestion: A or B?\n★ A: A.\nB: B.\nRecommended: A\nReason: No decision');
  assert.equal(output.outcome.reason_code,'DECISION_REQUIRED');
  assert.deepEqual(original,frozen);
  assert.deepEqual(repairPublication({gapTags,input:original,draft,run:'run',dry:true}).publication.operations,[]);
});

test('repository metadata uses the captured enum and preserves nonempty fields', () => {
  const assignment=input();assignment.schema.types.task.fields={repository:{type:'enum',values:['repo','other']}};
  const resolve=data=>repositoryData(assignment,node('task:t',data));
  assert.deepEqual(resolve({repository:'repo',body:'Repository: other'}),{repository:'repo'});
  for(const repository of [undefined,null,'']) assert.deepEqual(resolve({repository,body:'Work\r\nRepository: other\r\nEnd'}),{repository:'other'});
  for(const repository of ['wrong',' ',false,0]) assert.deepEqual(resolve({repository,body:'Repository: repo'}),{});
  for(const body of ['No code needed','src/repo/file.ts','Repository: unknown','Repository: repo.',
    ' Repository: repo','Repository: repo ','Repository: repo\nRepository: other','Repository: repo\nRepository: repo']) {
    assert.deepEqual(resolve({body}),{},body);
  }
  assert.deepEqual(repositoryData({schema:{types:{task:{}}}},node('task:t',{body:'Repository: repo'})),{});
});

test('unresolved decision metadata keeps the existing refusal and dry behavior', () => {
  const assignment=input();assignment.selected.document.data.repository='conflicting-value';
  assignment.selected.document.data.body='Repository: repo';
  assignment.schema.types.task.fields={repository:{type:'enum',values:['repo']}};
  const draft={verdict:'DECISION_REQUIRED',reason:'No decision',gap};
  const before=structuredClone(assignment);
  assert.deepEqual(repairPublication({gapTags,input:assignment,draft,run:'run'}).publication.operations[0].command.data,{stage:'to_review',tags:['ask-engineering']});
  assert.deepEqual(repairPublication({gapTags,input:assignment,draft,run:'run',dry:true}).publication.operations,[]);
  assert.deepEqual(assignment,before);
});

test('READY cannot overwrite a nonempty conflicting repository', () => {
  const assignment=input();assignment.selected.document.data.repository='other';
  const draft={verdict:'READY',reason:'Current work',task:{id:'t',title:'Existing Task',repository:'repo',tests:[],body:'Repository: repo'}};
  assert.throws(()=>repairPublication({gapTags,input:assignment,draft,run:'run'}),/cannot replace a nonempty Task repository/);
  const result=checkRepair({input:assignment,repair:{ac_text_changed:false},draft,trees:{},maxFiles:8,maxLines:300,
    forecast:()=>null,checkPlan:()=>({ok:true,problems:[],tasks:[]})});
  assert.equal(result.ok,false);assert.match(result.problems.join(),/cannot replace a nonempty Task repository/);
});
test('dry run emits no business writes and a held dependent refuses the whole retirement', () => {
  const draft={verdict:'STALE',reason:'Old work',needs_code:true};
  const output=repairPublication({gapTags,input:input(),repair:{ac_text_changed:true},draft,run:'run',dry:true});
  assert.deepEqual(output.publication.operations,[]);
  assert.equal(output.would_publish.operations.length,2);
  const held=input();held.context.incoming[0].document.data.assignee='a-lane';
  assert.throws(()=>repairPublication({gapTags,input:held,repair:{ac_text_changed:true},draft,run:'run'}),/held/);
});

test('body checks reuse the lane Tests-line and restriction-line checks', () => {
  const checker=fileURLToPath(new URL('./reporter-names.mjs',import.meta.url));
  assert.deepEqual(bodyProblems('Repository: repo\nTests: none. Helper-only change.',checker),[]);
  assert.match(bodyProblems('Repository: repo',checker).join(),/no "Tests:" line/);
  assert.match(bodyProblems('Tests: test:a\nRead only: other.ts',checker).join(),/restriction line/);
});

test('the Reporter CLI checks typed bindings and refuses missing results or invalid fields', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reporter-cli-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/case.test.ts'), 'export {};\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', 'src/case.test.ts']);
  const ticketFile = path.join(root, 'ticket.json'), resultsFile = path.join(root, 'results.jsonl');
  const checker = fileURLToPath(new URL('./reporter-names.mjs', import.meta.url));
  const captured = {address: 'test:a', body: 'Keep the decision.', repository: 'repo', reporter_name: 'src/case.test.ts > exact case'};
  const run = (data, name = captured.reporter_name) => {
    fs.writeFileSync(ticketFile, JSON.stringify({body: 'Tests: test:a', acceptanceTests: [data]}));
    fs.writeFileSync(resultsFile, JSON.stringify({test: name, status: 'pass'}) + '\n');
    return spawnSync(process.execPath, [checker, 'check', ticketFile, 'repo', resultsFile], {cwd: root, encoding: 'utf8'});
  };
  const accepted = run(captured);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /1 Reporter name\(s\) of repo checked/);
  const missing = run(captured, 'src/case.test.ts > other case');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /has no such name/);
  for (const data of [{...captured, repository: null}, {...captured, reporter_name: 'x'.repeat(401)},
    {...captured, body: 'Repository: repo. Reporter name: other case'}]) {
    const refused = run(data);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Invalid Test|conflict/);
  }
});
test('the pinned AC read compares title and body rather than metadata revision', async () => {
  const selected=input();selected.selected.document.data.body='Criterion: ac:a@2. Old work';
  let called;
  const repair=await captureRepair(selected,async (address,revision)=>{called={address,revision};return {...parent,current_revision:2};});
  assert.deepEqual(called,{address:'ac:a',revision:2});
  assert.equal(repair.ac_text_changed,false);
  const changed=await captureRepair(selected,async ()=>node('ac:a',{title:'Old title',body:'Old body'}));
  assert.equal(changed.ac_text_changed,true);
});

test('the model sees legacy read-only files as context while the frozen Task remains exact', () => {
  const assignment=input();
  assignment.selected.document.data.body='Criterion: ac:a@4. Required behavior.\nRead only: existing.ts, existing.test.ts.\nDo not release held funds.';
  assignment.selected.data=structuredClone(assignment.selected.document.data);
  const before=structuredClone(assignment),view=repairView(assignment,{ac_text_changed:false,pinned_revision:4});
  assert.equal(view.repair.task.document.data.body,'Criterion: ac:a@4. Required behavior.\nContext: existing.ts, existing.test.ts.\nDo not release held funds.');
  assert.equal(view.repair.task.data.body,view.repair.task.document.data.body);
  assert.deepEqual(assignment,before);
  assert.deepEqual(view.repair.task.document.data.title,before.selected.document.data.title);
});

test('a stale critic commit cannot force a Task to retire unfinished work', () => {
  const options={input:input(),repair:{ac_text_changed:false},trees:{},maxFiles:8,maxLines:300,
    forecast:()=>null,checkPlan:()=>({ok:true,problems:[],tasks:[]}),requiredDoneCommit:'abc1234'};
  const ready={verdict:'READY',reason:'Exports are missing',task:{id:'t',title:'Existing Task',repository:'repo',tests:[],body:'Repository: repo'}};
  assert.equal(checkRepair({...options,draft:ready}).ok,true);
  assert.equal(checkRepair({...options,draft:{verdict:'DECISION_REQUIRED',reason:'Missing evidence',gap:{...gap,question:'Verify the required exports'}}}).ok,true);
});

test('owner questions preserve tags and exact choices, reject unknown owners and never invent a question',()=>{
  const original=input();original.selected.document.data.tags=['wallet','ask-policy'];
  original.selected.document.data.returns=2;original.context.parent.document.data.returns=1;
  const frozen=structuredClone(original),question={...gap,owner:'ceo',question:'Choose the limit? '+ 'я'.repeat(900),recommended:'B'};
  const draft={verdict:'DECISION_REQUIRED',reason:'Missing approved limit',gap:question};
  const result=repairPublication({input:original,draft,run:'owner',gapTags});
  assert.deepEqual(result.publication.operations[0].command.data,{stage:'to_review',tags:['wallet','ask-policy']});
  assert.ok(result.publication.operations[1].command.text.includes(question.question));
  assert.match(result.publication.operations[1].command.text,/★ B: B[.]\nRecommended: B/);
  assert.deepEqual(original,frozen);
  assert.ok(result.publication.operations.every(row=>(row.command.id??row.command.target)==='t'||row.command.target==='task:t'));
  assert.deepEqual(repairPublication({input:original,draft,run:'dry',dry:true,gapTags}).publication.operations,[]);
  for(const invalid of ['old blocker',{}, {...gap,owner:'unknown'}, {...gap,question:''}, {...gap,recommended:'C'}]){
    assert.equal(checked({...draft,gap:invalid}).ok,false);
    assert.throws(()=>repairPublication({input:original,draft:{...draft,gap:invalid},run:'invalid',gapTags}),/gap owner/);
  }
  for(const invalid of [undefined,{}, {ceo:''}, {ceo:' ask-policy'}])assert.throws(()=>repairPublication({input:original,draft,run:'invalid',gapTags:invalid}),/Configure/);
});


test('new Task hashes detect Source and Test text changes but ignore lifecycle metadata and order', async () => {
  const original = input();
  original.selected.document.data.body = 'Criterion: ac:a@4. Work';
  original.context.parent.document.data.sources = ['source:b', 'source:a'];
  original.context.children = [node('test:a', {title: 'A', body: 'Expected A'}), node('test:b', {title: 'B', body: 'Expected B'})];
  original.selected.document.data.ac_contract_hash = contractHash({selected: original.context.parent,
    children: original.context.children, schema: original.schema});
  const capture = value => captureRepair(value, async () => { throw new Error('A new Task needs no historical pin read'); });
  assert.equal((await capture(original)).ac_text_changed, false);
  for (const change of [
    x => { x.context.parent.document.data.title += ' changed'; },
    x => { x.context.parent.document.data.body += ' changed'; },
    x => { x.context.parent.document.data.sources.push('source:c'); },
    x => { x.context.children[0].document.data.body += ' changed'; },
    x => { x.context.children[0].document.data.title += ' changed'; },
    x => { x.context.children.pop(); },
    x => { x.context.children.push(node('test:c', {body: 'New Expected'})); },
  ]) {
    const changed = structuredClone(original); change(changed);
    assert.equal((await capture(changed)).ac_text_changed, true);
  }
  const metadata = structuredClone(original);
  metadata.context.parent.current_revision++; metadata.context.parent.document.data.stage = 'done';
  metadata.context.parent.document.data.sources.reverse(); metadata.context.children.reverse();
  metadata.context.children[0].result = {status: 'pass'};
  metadata.context.children[0].current_revision++; metadata.context.children[0].at = 'later';
  assert.equal((await capture(metadata)).ac_text_changed, false);
  original.selected.document.data.ac_contract_hash = 'invalid';
  await assert.rejects(() => capture(original), /contract hash is invalid/);
});

test('legacy Tasks compare Source references and publish their Test history limitation without returns', async () => {
  const original = input(); original.selected.document.data.body = 'Criterion: ac:a@2. Work';
  original.context.parent.document.data.sources = ['source:new'];
  const repair = await captureRepair(original, async () => ({...parent,
    document: {...parent.document, data: {...parent.document.data, sources: ['source:old']}}}));
  assert.equal(repair.ac_text_changed, true);
  assert.match(repair.baseline_note, /Historical Test texts are unavailable/);
  const result = repairPublication({input: original, repair, draft: {verdict: 'STALE', reason: 'Source changed', needs_code: true}, run: 'legacy'}).publication;
  assert.deepEqual(result.operations[0].command.data, {stage: 'to_task'});
  assert.ok(result.operations.some(row => row.command.op === 'note' && row.command.target === 'task:t' && row.command.text.includes(repair.baseline_note)));
  assert.ok(result.operations.every(row => row.command.data?.returns === undefined));
  const same = structuredClone(original); same.context.children.push(node('test:a', {body: 'Changed Test'}));
  const unchanged = await captureRepair(same, async () => original.context.parent);
  assert.equal(unchanged.ac_text_changed, false);
  assert.match(unchanged.baseline_note, /were not compared/);
  assert.equal(changedText(node('ac:a', {title: 'A', body: 'B', sources: ['source:b', 'source:a']}),
    node('ac:a', {title: 'A', body: 'B', sources: ['source:a', 'source:b']})), false);
});

test('replanning keeps consumer dependencies and preserves any recorded commit as evidence',()=>{
  for(const commit of [undefined,'a'.repeat(40)]){
    const assignment=input();if(commit)assignment.selected.document.data.commit=commit;
    const frozen=structuredClone(assignment);
    const output=repairPublication({input:assignment,repair:{ac_text_changed:true},
      draft:{verdict:'STALE',reason:'The AC contract changed and work remains',needs_code:true},run:'replan'}).publication;
    assert.deepEqual(output.operations.map(row=>row.command.op),['save_object','archive_object']);
    assert.deepEqual(output.operations[0].command.data,{stage:'to_task'});
    assert.equal(output.operations[1].command.target,assignment.selected.address);
    assert.ok(output.operations.every(row=>!row.command.relations));
    assert.deepEqual(assignment,frozen);
  }
});

test('a consumer cannot return READY with an archived prerequisite without a delivered commit',async()=>{
  const assignment=input();
  assignment.selected.document.links=[{relation:'depends_on',blocking:true,target:'task:old'}];
  const predecessor=node('task:old',{title:'Old prerequisite',stage:'done'});
  predecessor.document.present=false;
  const frozen=structuredClone(assignment);
  const repair=await captureRepair(assignment,async address=>{
    assert.equal(address,'task:old');return predecessor;
  });
  assert.deepEqual(repairView(assignment,repair).repair.dependencies,[predecessor]);
  const draft={verdict:'READY',reason:'Continue the consumer',task:{id:'t',title:'Existing Task',repository:'repo',
    tests:[],depends_on:[],body:'Repository: repo'}};
  const options={input:assignment,repair,draft,trees:{},run:'consumer',maxFiles:8,maxLines:300,
    forecast:()=>null,checkPlan:()=>({ok:true,problems:[],tasks:[]})};
  for(let attempt=0;attempt<3;attempt++){
    assert.equal(checkRepair(options).ok,false);
    const refused=repairPublication(options);
    assert.equal(refused.approved,false);assert.equal(refused.publication,undefined);
    assert.match(refused.critique.host.invalid,/archived prerequisite without a delivered commit: task:old/);
  }
  assert.equal(repairPublication({...options,repair:{}}).approved,false);
  const decision=repairPublication({...options,gapTags,draft:{verdict:'DECISION_REQUIRED',reason:'Replacement needs an owner choice',gap}});
  assert.equal(decision.publication.outcome.reason_code,'DECISION_REQUIRED');
  assert.deepEqual(decision.publication.operations[0].command.data.tags,[gapTags.cto]);
  for(const data of [{present:true,commit:undefined},{present:false,commit:'a'.repeat(40)}]){
    predecessor.document.present=data.present;predecessor.document.data.commit=data.commit;
    assert.equal(checkRepair(options).ok,true);
    assert.equal(repairPublication(options).publication.outcome.reason_code,'READY');
  }
  assert.deepEqual(assignment,frozen);
  await assert.rejects(captureRepair(assignment,async()=>({...predecessor,address:'task:other'})),/dependency read/);
});
