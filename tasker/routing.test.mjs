import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {metadataFindings} from './test-bindings.mjs';
import {genericRejectedCount} from './repair-context.mjs';
import {repairPublication} from './repair-plan.mjs';
const here = path.dirname(new URL(import.meta.url).pathname);
const node = (address, data, parent) => ({address, kind: address.split(':')[0], historical: false, current_revision: 4,
  document: {present: true, parent, data}});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-routing-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const target = path.join(root, 'current/artifacts'); fs.mkdirSync(target, {recursive:true});
  const input = {workspace:'fixture', selected:node('task:t', {body:'Tests: test:x',tags:['keep']}, 'ac:a'), claim_revision:5,
    schema:{types:{task:{role:'task',fields:{stage:{values:['review-task']}}},
      ac:{role:'ac',fields:{stage:{values:['prepare-tests','decide-ac']},returns:{type:'number',from:'own'},tags:{type:'list',from:'own'}}},test:{role:'test'}}},
    context:{parent:node('ac:a',{body:'Required behavior',returns:2,tags:['parent-keep','existing-question']}),
      children:[node('test:x',{body:'Required Test',command:''},'ac:a')],
      references:{sources:[node('source:s',{body:'Approved rule'})]}}};
  const config = {url:'fixture-url',workspace:'fixture',runs_folder:root,publication:{file:'operations.json'},
    vars:{TASKER_TEST_RETURN_STAGE:'prepare-tests',TASKER_RETURN_LIMIT:'3',STUCK_TAG:'configured-stuck',FINDING_CRITERIA:'A'}};
  const write = (file,value) => fs.writeFileSync(file, JSON.stringify(value));
  return {root,target,input,config,write};
}

test('metadata findings cover missing command and malformed Reporter while preserving acceptance text', t => {
  const {input} = fixture(t), before = structuredClone(input);
  assert.equal(metadataFindings(input)[0].target,'test:x'); assert.deepEqual(input,before);
  const d = input.context.children[0].document.data;
  d.body += '\nRepository: repo. Reporter name: src/x.test.ts > required case';
  assert.equal(metadataFindings(input).length,1);
  d.command='bun test src/x.test.ts'; assert.deepEqual(metadataFindings(input),[]);
  d.body='Repository: repo. Reporter name: ../x.test.ts > case'; assert.equal(metadataFindings(input).length,1);
  input.selected.document.data.body='Tests: test:other'; assert.deepEqual(metadataFindings(input),[]);
});

test('metadata preclaim only reads, then claimed prepare routes the parent before models and verifies fresh evidence', t => {
  const f=fixture(t), runtime=path.join(f.root,'runtime'), launcher=path.join(runtime,'lane-launcher');
  fs.mkdirSync(launcher,{recursive:true}); fs.mkdirSync(path.join(runtime,'planning-joppa'));
  const nodes=path.join(f.root,'nodes.json'), configFile=path.join(f.root,'config.json');
  const save=()=>f.write(nodes,{schema:f.input.schema,task:f.input.selected,parent:f.input.context.parent,tests:f.input.context.children});save();
  fs.writeFileSync(path.join(launcher,'joppa-api.mjs'),`import fs from 'node:fs';export async function readJoppa(u,t,tool,args){
    const n=JSON.parse(fs.readFileSync(${JSON.stringify(nodes)}));if(tool==='joppa_tree')return {schema:n.schema};
    if(args.address)return [n.task,n.parent,...n.tests].find(x=>x.address===args.address);
    return {items:n.tests.map(x=>({address:x.address,revision:x.current_revision,parent:x.document.parent,...x.document.data}))};}`);
  for(const [file,source] of Object.entries({'joppa.mjs':'export const runHoldsTasks=()=>false;',
    'joppa-common.mjs':'export const runTasks=()=>[];','runtime.mjs':'export const runDirectories=()=>[];export const readRun=()=>({});',
    'scope.mjs':'export const scopeDirectory=x=>x;','dependencies.mjs':'export const dependencyCheck=()=>async()=>({ready:true});'})) fs.writeFileSync(path.join(launcher,file),source);
  f.write(configFile,f.config);f.write(path.join(f.target,'input.json'),f.input);
  const call=(mode,dry=false)=>spawnSync(process.execPath,[path.join(here,'completion.mjs'),mode],{encoding:'utf8',env:{...process.env,
    PLANNING_JOPPA_CONFIG:configFile,PLANNING_JOPPA_ITEM:'task:t',MEDULLA_RUN_DIR:path.dirname(f.target),DRY_RUN:String(dry),
    CREW_FLOW_STAGES:path.join(runtime,'planning-joppa/flow_stages.py')}});
  const pre=call('preclaim');assert.equal(pre.status,0,pre.stderr);assert.match(pre.stdout,/<signal:CONTINUE>/);
  assert.equal(fs.existsSync(path.join(f.target,'operations.json')),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target,'metadata-preclaim.json'))).findings.length,1);
  const prepared=call('prepare');assert.equal(prepared.status,0,prepared.stderr);assert.match(prepared.stdout,/<signal:DECISION>/);
  const out=JSON.parse(fs.readFileSync(path.join(f.target,'operations.json')));
  assert.deepEqual(out.operations[0].command.data,{stage:'prepare-tests',returns:3,tags:['parent-keep','existing-question','configured-stuck']});assert.equal(out.operations[0].command.revision,4);
  assert.equal(out.operations[1].command.target,'task:t');assert.equal(out.operations.length,2);
  assert.equal(out.outcome.reason_code,'TASK_TEST_METADATA');assert.equal(call('verify').status,0);
  const d=f.input.context.children[0].document.data;d.body+='\nRepository: repo. Reporter name: src/x.test.ts > case';d.command='bun test';save();
  assert.equal(call('verify').status,1);
  f.write(path.join(f.target,'input.json'),f.input);
  assert.match(call('prepare').stdout,/<signal:CONTINUE>/);
  d.command='';save();f.write(path.join(f.target,'input.json'),f.input);assert.equal(call('prepare',true).status,0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target,'operations.json'))).operations,[]);
  f.input.context.parent.document.data.assignee='another-run';f.write(path.join(f.target,'input.json'),f.input);
  assert.equal(call('prepare').status,1);
  delete f.input.context.parent.document.data.assignee;f.input.context.parent.document.data.stage='prepare-tests';save();
  const waiting=call('preclaim');assert.equal(waiting.status,0,waiting.stderr);assert.match(waiting.stdout,/<signal:BLOCKED>/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target,'result.json'))).claim_released,false);
  delete f.input.context.parent.document.data.stage;
  for (const [previous,tags,expected] of [[0,['parent-keep'],undefined],
    [2,['parent-keep','configured-stuck'],['parent-keep','configured-stuck']]]) {
    Object.assign(f.input.context.parent.document.data,{returns:previous,tags});
    f.write(path.join(f.target,'input.json'),f.input);
    assert.equal(call('prepare').status,0);
    const update=JSON.parse(fs.readFileSync(path.join(f.target,'operations.json'))).operations[0].command.data;
    assert.equal(update.returns,previous+1);assert.deepEqual(update.tags,expected);
  }
});

test('supported Task findings route only the parent stage and count one parent return and keep Test text', t => {
  const f=fixture(t), inputFile=path.join(f.target,'input.json'),reviewFile=path.join(f.target,'review.json');f.write(inputFile,f.input);
  const run=review=>{f.write(reviewFile,{critique:{critic:{verdict:'REWORK',...review}}});
    return JSON.parse(execFileSync('jq',['-n','--arg','dry','false','--arg','run','fixture','--arg','reason','Exact critic reason',
      '--arg','finding_criteria','A','--arg','return_stage','decide-ac','--arg','test_return_stage','prepare-tests',
      '--arg','task_review_stage','review-task','--arg','stuck_tag','configured-stuck','--argjson','generic_count','3',
      '--argjson','return_limit','3','--slurpfile','input',inputFile,'--slurpfile','review',reviewFile,'-f',path.join(here,'rejected.jq')],{encoding:'utf8'}));};
  for(const [review,stage] of [[{node_findings:[{target:'test:x',quote:'Required Test',reason_code:'out_of_parent_scope'}]},'prepare-tests'],
    [{ac_findings:[{criterion:'A',ac_quote:'Required behavior',source:'source:s',source_quote:'Approved rule'}]},'decide-ac']]) {
    const out=run(review);assert.equal(out.outcome.reason_code,'TASK_PARENT_RETURN');
    assert.deepEqual(out.operations[0].command.data,{stage,returns:3,tags:['parent-keep','existing-question','configured-stuck']});assert.equal(out.operations[0].command.revision,4);
    assert.deepEqual(out.operations[1].command.data,{stage:'review-task'});assert.equal(out.operations.length,3);
  }
  const generic=run({node_findings:[{target:'test:x',quote:'Invented quote',reason_code:'scope'}]});
  assert.equal(generic.outcome.reason_code,'STUCK');assert.deepEqual(generic.operations[0].command.data,{stage:'review-task',tags:['configured-stuck','keep']});
  assert.match(generic.operations[1].command.text,/Exact critic reason/);assert.doesNotMatch(generic.operations[1].command.text,/Owner:|Question:/);
});

test('three generic rejections use confirmed same-server receipts, ignore technical failures and reset after success', t => {
  const f=fixture(t);let tick=1;
  const history=(name,code='REJECTED',change={})=>{
    const dir=path.join(f.root,name,'artifacts');fs.mkdirSync(dir,{recursive:true});
    f.write(path.join(dir,'input.json'),f.input);
    f.write(path.join(dir,'publication.json'),{status:'confirmed',server:f.config.url,arguments:{workspace:'fixture',request_id:name},...change});
    f.write(path.join(dir,'result.json'),{reason_code:code,claim_released:true,item_revisions:{'task:t':10}});
    fs.utimesSync(path.join(dir,'result.json'),tick,tick++);return dir;
  };
  assert.equal(genericRejectedCount(f.config,f.input,f.target),1);
  history('first');history('uncertain','REJECTED',{status:'uncertain'});history('foreign','REJECTED',{server:'another-url'});
  history('technical','FLOW_FAILED');history('refused','CLAIM_REFUSED');
  assert.equal(genericRejectedCount(f.config,f.input,f.target),2);
  history('second');fs.symlinkSync(path.join(f.root,'second'),path.join(f.root,'duplicate'),'dir');
  assert.equal(genericRejectedCount(f.config,f.input,f.target),3);
  history('success','READY');assert.equal(genericRejectedCount(f.config,f.input,f.target),1);
  const business=history('business');f.write(path.join(business,'rejected-review.json'),{critique:{critic:{verdict:'REWORK',
    node_findings:[{target:'test:x',quote:'Required Test',reason_code:'metadata'}]}}});
  assert.equal(genericRejectedCount(f.config,f.input,f.target),1);
});


test('repair stages come from configuration for READY, STALE and owner questions', t => {
  const f=fixture(t);f.input.context.incoming=[];
  const stages={task:'build-task',ready:'plan-ac',review:'review-task'};
  const call=draft=>repairPublication({input:f.input,stages,run:'configured-stages',
    repair:{ac_text_changed:draft.verdict==='STALE'},draft,gapTags:{cto:'ask-engineer'}}).publication;
  assert.equal(call({verdict:'READY',reason:'Missing implementation',task:{body:'Do the work',repository:'repo'}}).operations[0].command.data.stage,'build-task');
  assert.equal(call({verdict:'STALE',reason:'The AC changed',needs_code:true}).operations[0].command.data.stage,'plan-ac');
  assert.equal(call({verdict:'DECISION_REQUIRED',reason:'A real owner choice',gap:{owner:'cto',question:'Which interface?',a:'A',b:'B',recommended:'A'}}).operations[0].command.data.stage,'review-task');
});

test('host dependency replan requires fresh undelivered unheld evidence and preserves other Tasks', t => {
  const f=fixture(t), launcher=path.join(f.root,'runtime/lane-launcher');fs.mkdirSync(launcher,{recursive:true});
  fs.mkdirSync(path.join(f.root,'runtime/planning-joppa'));
  const predecessor=node('task:old',{stage:'done'},'ac:a');predecessor.document.present=false;
  const other=node('task:other',{stage:'to_implement'},'ac:a');
  f.input.selected.document.links=[{relation:'depends_on',blocking:true,target:'task:old'}];
  f.input.context.incoming=[node('task:consumer',{},'ac:a')];
  f.input.schema.types.ac.fields.stage.values.push('plan-again');
  const nodes=path.join(f.root,'nodes.json'),configFile=path.join(f.root,'config.json'),inputFile=path.join(f.target,'input.json');
  const state={schema:f.input.schema,nodes:[f.input.selected,f.input.context.parent,...f.input.context.children,predecessor,other],runs:[],dependencyReady:true};
  const save=()=>{f.write(nodes,state);f.write(inputFile,f.input);};
  fs.writeFileSync(path.join(launcher,'joppa-api.mjs'),`import fs from 'node:fs';export async function readJoppa(u,t,tool,args){
    const n=JSON.parse(fs.readFileSync(${JSON.stringify(nodes)}));return tool==='joppa_tree'?{schema:n.schema}:
    args.address?n.nodes.find(x=>x.address===args.address):{items:n.nodes.filter(x=>x.kind==='test').map(x=>({address:x.address}))};}`);
  fs.writeFileSync(path.join(launcher,'dependencies.mjs'),`import fs from 'node:fs';export const dependencyCheck=read=>async address=>{
    const selected=await read('joppa_objects',{address});for(const link of selected.document.links)await read('joppa_objects',{address:link.target});
    return {ready:JSON.parse(fs.readFileSync(${JSON.stringify(nodes)})).dependencyReady,blocker:'task:pending'};};`);
  fs.writeFileSync(path.join(launcher,'joppa.mjs'),'export const runHoldsTasks=(r,n)=>r.held&&!n?.every(x=>x.document.present===false);');
  fs.writeFileSync(path.join(launcher,'joppa-common.mjs'),'export const runTasks=r=>r.tasks;');
  fs.writeFileSync(path.join(launcher,'scope.mjs'),'export const scopeDirectory=x=>x;');
  fs.writeFileSync(path.join(launcher,'runtime.mjs'),`import fs from 'node:fs';const load=()=>JSON.parse(fs.readFileSync(${JSON.stringify(nodes)}));
    export const runDirectories=()=>load().runs.map((_,i)=>'/'+i);export const readRun=p=>load().runs[Number(p.split('/')[1])];`);
  const lane=path.join(f.root,'lane.json');f.write(lane,{id:'fixture',stateDir:f.root,workspace:'fixture',joppa:{url:'fixture-url'}});
  Object.assign(f.config.vars,{TASKER_LANE_CONFIG:lane,TASKER_READY_STAGE:'plan-again'});f.write(configFile,f.config);save();
  const call=(mode,dry=false)=>spawnSync(process.execPath,[path.join(here,'completion.mjs'),mode],{encoding:'utf8',env:{...process.env,
    PLANNING_JOPPA_CONFIG:configFile,PLANNING_JOPPA_ITEM:'task:t',MEDULLA_RUN_DIR:path.dirname(f.target),DRY_RUN:String(dry),
    CREW_FLOW_STAGES:path.join(f.root,'runtime/planning-joppa/flow_stages.py')}});
  const before=structuredClone(f.input);
  const pre=call('preclaim');assert.equal(pre.status,0,pre.stderr);assert.match(pre.stdout,/CONTINUE.*DEPENDENCY_REPLAN/);
  assert.equal(fs.existsSync(path.join(f.target,'operations.json')),false);
  state.runs=[{held:true,tasks:[{address:'task:other'}]}];save();
  const prepared=call('prepare');assert.equal(prepared.status,0,prepared.stderr);assert.match(prepared.stdout,/<signal:DECISION>/);
  const out=JSON.parse(fs.readFileSync(path.join(f.target,'operations.json')));
  assert.equal(out.outcome.reason_code,'DEPENDENCY_REPLAN');
  assert.deepEqual(out.operations.map(row=>row.command.op),['save_object','note','archive_object']);
  assert.deepEqual(out.operations[0].command.data,{stage:'plan-again'});assert.equal(out.operations[0].command.revision,4);
  assert.equal(out.operations[1].command.text,'plan obsolete: prerequisite archived without delivery');
  assert.equal(out.operations[2].command.target,'task:t');assert.equal(out.operations[2].command.revision,5);
  assert.ok(out.operations.every(row=>!row.command.relations));assert.deepEqual(f.input,before);
  assert.equal(call('verify').status,0);
  predecessor.current_revision++;save();assert.equal(call('verify').status,1);predecessor.current_revision--;
  predecessor.document.data.commit='a'.repeat(40);save();assert.equal(call('verify').status,1);delete predecessor.document.data.commit;
  for(const field of ['commit','assignee']){
    f.input.selected.document.data[field]=field==='commit'?'b'.repeat(40):'another-run';save();
    assert.match(call('preclaim').stdout,/<signal:BLOCKED>/);assert.equal(call('prepare').status,1);
    delete f.input.selected.document.data[field];
  }
  state.runs=[{held:true,tasks:[{address:'task:t'}]}];save();assert.match(call('preclaim').stdout,/<signal:BLOCKED>/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target,'result.json'))).reason_code,'ACTIVE_TASK');
  assert.equal(call('prepare').status,0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target,'operations.json'))).outcome.reason_code,'ACTIVE_TASK');
  state.runs=[];save();assert.equal(call('prepare',true).status,0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target,'operations.json'))).operations,[]);
  const pending=node('task:pending',{stage:'to_implement'},'ac:a');state.nodes.push(pending);state.dependencyReady=false;
  f.input.selected.document.links.push({relation:'depends_on',blocking:true,target:'task:pending'});save();
  assert.match(call('preclaim').stdout,/<signal:BLOCKED>/);assert.equal(call('prepare').status,1);
});
