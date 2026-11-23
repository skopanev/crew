import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decision, inspect} from './completion.mjs';
const stages = {ready:'prepare',implement:'build',done:'finished'};
const ac = () => ({address:'criterion:a',kind:'criterion',historical:false,document:{present:true,data:{stage:'build'}},status:{tone:'green'}});
const input = () => ({workspace:'example',selected:ac(),schema:{types:{criterion:{role:'ac'},check:{role:'test'},work:{role:'task'}}}});
const check = () => ({address:'check:a',kind:'check',historical:false,document:{present:true,parent:'criterion:a'},status:{tone:'green'},result:{status:'pass',commit:'a'.repeat(40)}});
test('host completion requires current recorded passing Tests and no live Tasks or held lanes',()=>{
  const i=input(),a=ac(),t=check();assert.equal(decision(i,a,[t],false,stages),'DONE');
  for(const edit of [t=>{delete t.result;},t=>{t.result.status='fail';},t=>{t.result.commit='';},t=>{t.status.tone='blue';}]){
    const t=check();edit(t);assert.equal(decision(i,a,[t],false,stages),'CONTINUE');
  }
  assert.equal(decision(i,a,[],false,stages),'CONTINUE');
  assert.equal(decision(i,a,[t],true,stages),'WAIT');
  const task={kind:'work',document:{present:true}};
  assert.equal(decision(i,a,[t,task],false,stages),'WAIT');task.document.present=false;
  assert.equal(decision(i,a,[t,task],false,stages),'DONE');
});
test('only blue yellow orange done ACs return to normal Tasker; red and green do not',()=>{
  const a=ac();a.document.data.stage=stages.done;
  for(const tone of ['blue','yellow','orange','red','green']){a.status.tone=tone;
    assert.equal(decision(input(),a,[],false,stages),['blue','yellow','orange'].includes(tone)?'CONTINUE':'WAIT');}
  const task={kind:'work',document:{present:true,data:{stage:'to_implement'}}};
  for(const color of ['blue','yellow','orange']){a.status.tone=color;
    assert.equal(decision(input(),a,[],true,stages),'WAIT');
    assert.equal(decision(input(),a,[task],false,stages),'WAIT');
  }
  a.document.data.stage='audit';assert.equal(decision(input(),a,[],false,stages),'WAIT');
});
test('fresh reads detect changed results and lanes on archived Tasks before publication',async()=>{
  let t=check(),a=ac();const old={address:'work:old',kind:'work',historical:false,document:{present:false,parent:'criterion:a'}};
  const read=async(tool,args)=>args.address==='criterion:a'?a:args.address==='work:old'?old:args.address?t:{items:[{address:'check:a'}]};
  const holds=run=>run.held,tasks=run=>run.tasks;
  assert.equal(await inspect(input(),read,[],stages,holds,tasks),'DONE');
  t={...t,result:{status:'fail',commit:'b'.repeat(40)}};
  assert.equal(await inspect(input(),read,[],stages,holds,tasks),'CONTINUE');t=check();
  assert.equal(await inspect(input(),read,[{held:true,tasks:[{address:'work:old'}]}],stages,holds,tasks),'WAIT');
  assert.equal(await inspect(input(),read,[{held:false,tasks:[{address:'work:old'}]}],stages,holds,tasks),'DONE');
  a.document.data.stage=stages.done;
  for(const color of ['blue','yellow','orange']){a.status.tone=color;
    assert.equal(await inspect(input(),read,[{held:true,tasks:[{address:'work:old'}]}],stages,holds,tasks),'WAIT');
  }

});
test('native profiles preserve Task repair and host completion precedes trees and models',()=>{
  const config=JSON.parse(fs.readFileSync(new URL('./config.example.json',import.meta.url)));
  assert.equal(config.inputs.length,4);assert.equal(config.inputs[3].selection.kind,'task');
  assert.deepEqual(config.inputs[2].selection.status,['blue','yellow','orange']);
  for(const index of [1,2])assert.deepEqual(config.inputs[index].exclude_children,{kind:'task'});
  const workflow=fs.readFileSync(new URL('./workflow.yaml',import.meta.url),'utf8');
  assert.ok(workflow.indexOf('completion.mjs" preclaim')<workflow.indexOf('FLOW_ASSIGNMENT_INLINE=false'));
  assert.ok(workflow.indexOf('completion.mjs" prepare')<workflow.indexOf('trees.sh" add'));
  assert.ok(workflow.indexOf('completion.mjs" verify')<workflow.indexOf('"$CREW_FLOW_STAGES" publish'));
});

test('CLI emits only guarded done and refuses a changed result immediately before native publication',async t=>{
  const os=await import('node:os'),path=await import('node:path'),{spawnSync}=await import('node:child_process');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tasker-completion-cli-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const runtime=path.join(root,'runtime'),launcher=path.join(runtime,'lane-launcher'),dir=path.join(root,'run/artifacts');
  fs.mkdirSync(launcher,{recursive:true});fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.join(runtime,'planning-joppa'));
  const nodes=path.join(root,'nodes.json'),state=path.join(root,'state');fs.mkdirSync(path.join(state,'runs'),{recursive:true});
  const save=()=>fs.writeFileSync(nodes,JSON.stringify({'criterion:a':ac(),'check:a':check()}));save();
  fs.writeFileSync(path.join(launcher,'joppa-api.mjs'),`import fs from 'node:fs';export async function readJoppa(u,t,tool,args){if(tool==='joppa_tree')return ${JSON.stringify({schema:input().schema})};const n=JSON.parse(fs.readFileSync(${JSON.stringify(nodes)}));return args.address?n[args.address]:{items:Object.keys(n).filter(address=>address!=='criterion:a').map(address=>({address}))};}`);
  fs.writeFileSync(path.join(launcher,'joppa.mjs'),'export const runHoldsTasks=r=>!r.result;');
  fs.writeFileSync(path.join(launcher,'joppa-common.mjs'),'export const runTasks=r=>r.tasks;');
  fs.writeFileSync(path.join(launcher,'scope.mjs'),'export const scopeDirectory=root=>root;');
  fs.writeFileSync(path.join(launcher,'runtime.mjs'),"import fs from 'node:fs';import path from 'node:path';export const runDirectories=root=>fs.readdirSync(path.join(root,'runs')).map(n=>path.join(root,'runs',n));export const readRun=p=>JSON.parse(fs.readFileSync(p));");
  const lane=path.join(root,'lane.json');fs.writeFileSync(lane,JSON.stringify({id:'fixture',stateDir:state,workspace:'example',joppa:{url:'fixture'}}));
  const config=path.join(root,'config.json');fs.writeFileSync(config,JSON.stringify({workspace:'example',url:'fixture',publication:{file:'operations.json'},vars:{TASKER_LANE_CONFIG:lane,TASKER_READY_STAGE:stages.ready,TASKER_IMPLEMENT_STAGE:stages.implement,TASKER_DONE_STAGE:stages.done}}));
  const i=input();i.claim_revision=9;fs.writeFileSync(path.join(dir,'input.json'),JSON.stringify(i));
  const call=mode=>spawnSync(process.execPath,[new URL('./completion.mjs',import.meta.url).pathname,mode],{encoding:'utf8',env:{...process.env,MEDULLA_RUN_DIR:path.dirname(dir),PLANNING_JOPPA_CONFIG:config,PLANNING_JOPPA_ITEM:'criterion:a',CREW_FLOW_STAGES:path.join(runtime,'planning-joppa/flow_stages.py')}});
  const prepared=call('prepare');assert.equal(prepared.status,0,prepared.stderr);assert.match(prepared.stdout,/<signal:DECISION>/);
  const command=JSON.parse(fs.readFileSync(path.join(dir,'operations.json'))).operations[0].command;
  assert.deepEqual(command.data,{stage:stages.done,returns:0});assert.equal(command.revision,9);assert.equal(command.id,'a');
  assert.equal(call('verify').status,0);
  const changed=JSON.parse(fs.readFileSync(nodes));changed['check:a'].result.status='fail';fs.writeFileSync(nodes,JSON.stringify(changed));
  const rejected=call('verify');assert.equal(rejected.status,1);assert.match(rejected.stderr,/evidence changed/);
  save();const task={address:'work:late',kind:'work',historical:false,document:{present:true,parent:'criterion:a'}};
  const withTask=JSON.parse(fs.readFileSync(nodes));withTask[task.address]=task;fs.writeFileSync(nodes,JSON.stringify(withTask));
  assert.equal(call('verify').status,1);
  task.document.present=false;withTask[task.address]=task;fs.writeFileSync(nodes,JSON.stringify(withTask));
  fs.mkdirSync(path.join(state,'runs','late'));fs.writeFileSync(path.join(state,'runs','late','launch.json'),JSON.stringify({tasks:[{address:task.address}]}));
  assert.equal(call('verify').status,1);
  fs.unlinkSync(path.join(dir,'input.json'));fs.unlinkSync(path.join(dir,'operations.json'));
  const blocked=call('preclaim');assert.equal(blocked.status,0,blocked.stderr);assert.match(blocked.stdout,/<signal:BLOCKED>/);
  assert.equal(fs.existsSync(path.join(dir,'operations.json')),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'result.json'))).claim_released,false);
});
