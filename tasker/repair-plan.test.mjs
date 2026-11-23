import test from 'node:test';
import assert from 'node:assert/strict';
import {changedText, repairView, checkRepair, repairPublication, repositoryData} from './repair-plan.mjs';
import {bodyProblems, captureRepair} from './repair-context.mjs';
import {fileURLToPath} from 'node:url';
const node = (address, data, extra = {}) => ({address, kind: address.split(':')[0], current_revision: 4,
  document: {data, parent: null, present: true}, ...extra});
const parent = node('ac:a', {title:'Current AC', body:'Current condition', stage:'to_implement'});
const task = node('task:t', {title:'Existing Task', body:'Old work', stage:'to_review'});
const group = {title:'Prerequisites', color:'#123456', facts:{why:'keep'}, edges:[{to:'task:t',revision:2},{to:'task:other',revision:3}]};
const consumer = node('task:consumer', {body:'Dependent work', stage:'to_implement'}, {relations:{depends_on:group,related:{edges:[{to:'ac:elsewhere'}]}}});
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
  const output=repairPublication({input:input(),draft,run:'run'}).publication;
  assert.equal(output.operations.length,1);
  assert.deepEqual(output.operations[0].command.data,{body:draft.task.body,repository:'repo',stage:'to_implement'});
  assert.equal(output.operations[0].command.id,'t');
  assert.equal(output.operations[0].command.revision,5);
});
test('STALE removes only its edge, preserves group metadata and queues AC only when code remains', () => {
  const original=input();const before=structuredClone(original);
  const build=needs_code=>repairPublication({input:original,repair:{ac_text_changed:true},draft:{verdict:'STALE',reason:'Old AC',needs_code},run:'run'}).publication;
  const work=build(true);
  assert.deepEqual(work.operations[1].command.relations,{depends_on:{...group,edges:[{to:'task:other',revision:3}]}});
  assert.equal(Object.hasOwn(work.operations[1].command,'data'),false);
  assert.deepEqual(work.operations[0].command.data,{stage:'to_task'});
  assert.equal(work.operations[2].command.op,'archive_object');
  assert.equal(work.operations[2].command.target,'task:t');
  assert.deepEqual(build(false).operations.map(row=>row.command.op),['save_object','note']);
  assert.equal(build(false).outcome.reason_code,'DECISION_REQUIRED');
  assert.deepEqual(original,before);
});
test('DECISION_REQUIRED changes only the claimed Task stage and records the decision', () => {
  const original=input();
  original.schema.types.task.fields={repository:{type:'enum',values:['repo','other']}};
  original.selected.document.data.body='Old work\nRepository: repo';
  const frozen=structuredClone(original);
  const draft={verdict:'DECISION_REQUIRED',reason:'No decision',gap:'A or B?'};
  const output=repairPublication({input:original,draft,run:'run'}).publication;
  assert.equal(output.operations.length,2);
  assert.deepEqual(output.operations[0].command,{op:'save_object',kind:'task',id:'t',revision:5,
    data:{stage:'to_review',repository:'repo'},reason:'No decision'});
  assert.equal(output.operations[1].command.op,'note');
  assert.equal(output.operations[1].command.target,'task:t');
  assert.equal(output.operations[1].command.text,'Decision required. A or B?');
  assert.equal(output.outcome.reason_code,'DECISION_REQUIRED');
  assert.deepEqual(original,frozen);
  assert.deepEqual(repairPublication({input:original,draft,run:'run',dry:true}).publication.operations,[]);
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
  const draft={verdict:'DECISION_REQUIRED',reason:'No decision',gap:'A or B?'};
  const before=structuredClone(assignment);
  assert.deepEqual(repairPublication({input:assignment,draft,run:'run'}).publication.operations[0].command.data,{stage:'to_review'});
  assert.deepEqual(repairPublication({input:assignment,draft,run:'run',dry:true}).publication.operations,[]);
  assert.deepEqual(assignment,before);
});

test('READY cannot overwrite a nonempty conflicting repository', () => {
  const assignment=input();assignment.selected.document.data.repository='other';
  const draft={verdict:'READY',reason:'Current work',task:{id:'t',title:'Existing Task',repository:'repo',tests:[],body:'Repository: repo'}};
  assert.throws(()=>repairPublication({input:assignment,draft,run:'run'}),/cannot replace a nonempty Task repository/);
  const result=checkRepair({input:assignment,repair:{ac_text_changed:false},draft,trees:{},maxFiles:8,maxLines:300,
    forecast:()=>null,checkPlan:()=>({ok:true,problems:[],tasks:[]})});
  assert.equal(result.ok,false);assert.match(result.problems.join(),/cannot replace a nonempty Task repository/);
});
test('dry run emits no business writes and a held dependent refuses the whole retirement', () => {
  const draft={verdict:'STALE',reason:'Old work',needs_code:true};
  const output=repairPublication({input:input(),repair:{ac_text_changed:true},draft,run:'run',dry:true});
  assert.deepEqual(output.publication.operations,[]);
  assert.equal(output.would_publish.operations.length,3);
  const held=input();held.context.incoming[0].document.data.assignee='a-lane';
  assert.throws(()=>repairPublication({input:held,repair:{ac_text_changed:true},draft,run:'run'}),/held/);
});

test('body checks reuse the lane Tests-line and restriction-line checks', () => {
  const checker=fileURLToPath(new URL('./reporter-names.mjs',import.meta.url));
  assert.deepEqual(bodyProblems('Repository: repo\nTests: none. Helper-only change.',checker),[]);
  assert.match(bodyProblems('Repository: repo',checker).join(),/no "Tests:" line/);
  assert.match(bodyProblems('Tests: test:a\nRead only: other.ts',checker).join(),/restriction line/);
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
  assert.equal(checkRepair({...options,draft:{verdict:'DECISION_REQUIRED',reason:'Missing evidence',gap:'Verify the required exports'}}).ok,true);
});
