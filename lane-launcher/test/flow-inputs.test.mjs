// Ordered native inputs keep their own context and publication policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {flowSettings, nextConfiguredItem} from '../../planning-joppa/queue.mjs';
import {plannerFixture} from '../test-support/config-reload.fixture.mjs';
import {contextAdmission} from '../../planning-joppa/context-admission.mjs';
import {repairPublication} from '../../tasker/repair-plan.mjs';
import {retryFilter} from '../../planning-joppa/retry.mjs';

test('ordered profiles retain scalar filters, skip excluded parents and select later inputs', async t => {
  const f = await plannerFixture(t);
  f.queue.push('task:t1', 'task:t2');
  f.objects.get('ac:a1').document.data.stage = 'to_task';
  f.objects.get('task:t1').document.data.stage = 'to_review';
  f.objects.get('task:t2').document.data.stage = 'to_decide';
  const task = {children: {}, references: [], exclude_children: null,
    related: {limit: 90, parent: {kind: 'ac', exclude_tags: ['hold']}},
    publication: {update_kinds: ['task']}};
  const config = {...f.config, workflow: '/tmp/workflow.yaml', exclude_children: {kind: 'task'}, inputs: [
    {selection: {kind: 'ac', data: {stage: 'to_task'}}, exclude_children: null},
    {...task, selection: {kind: 'task', data: {stage: 'to_review'}}},
    {...task, selection: {kind: 'task', data: {stage: 'to_decide'}}}]};
  const next = skip => nextConfiguredItem(config, config.token_file, undefined, row => skip.includes(row.address));
  assert.equal((await next([])).next.input, 0);
  assert.deepEqual([(await next(['ac:a1'])).next.address, (await next(['ac:a1'])).next.input], ['task:t1', 1]);
  f.objects.get('ac:a1').document.data.tags = ['hold'];
  assert.equal((await next(['ac:a1'])).next.address, 'task:t2');
  f.objects.get('ac:a2').document.data.assignee = 'another-run';
  assert.equal((await next(['ac:a1'])).next, null);
  const queries = f.calls.filter(call => call.name === 'joppa_objects' && !call.args.address);
  assert.ok(queries.every(call => !Array.isArray(call.args.data?.stage)));
  assert.ok(queries.some(call => call.args.data?.stage === 'to_decide'));
  for (const input of [{selection: {kind: 'task'}, workspace: 'foreign'}, {}, null]) {
    assert.throws(() => flowSettings({...config, inputs: [input]}), /native selection profiles/);
  }
});

test('the dispatcher passes the selected profile index without editing its config', async t => {
  const pass = '#!/bin/sh\nprintf \'start %s %s\\n\' "$5" "$PLANNING_JOPPA_INPUT" >> "$TEST_PASSES"\n';
  const f = await plannerFixture(t, {}, 0, pass);
  f.queue.push('task:t2');
  const workflow = path.join(f.root, 'workflow.yaml');
  fs.writeFileSync(workflow, 'nodes: {}\n');
  const config = {...f.config, workflow, inputs: [
    {selection: {kind: 'ac', data: {stage: 'absent'}}},
    {selection: {kind: 'task', data: {stage: 'ready'}}, children: {}, references: [], exclude_children: null}]};
  f.write(config);
  const bytes = fs.readFileSync(f.configFile);
  const run = f.start();
  await run.until(() => f.passes().length > 0);
  assert.equal(f.passes()[0], 'start task:t2 1');
  assert.deepEqual(fs.readFileSync(f.configFile), bytes);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
  assert.equal(await run.stop(), 130);
});

test('native configured profiles exclude assigned items before claims and retain missing or null assignees', async t => {
  const f = await plannerFixture(t);
  f.queue.push('task:t1', 'task:t2');
  for (const kind of ['ac', 'task']) {
    const first = `${kind}:${kind === 'ac' ? 'a' : 't'}1`, second = `${kind}:${kind === 'ac' ? 'a' : 't'}2`;
    const config = {...f.config, workflow: '/tmp/workflow.yaml', inputs: [
      {selection: {kind, assignee: 'another-run', data: {stage: 'ready'}}},
      {selection: {kind: 'req', data: {stage: 'absent'}}}]};
    for (const address of [first, second]) f.objects.get(address).document.data.stage = 'ready';
    f.objects.get(first).document.data.assignee = 'another-run';
    delete f.objects.get(second).document.data.assignee;
    const before = structuredClone(config);
    const next = () => nextConfiguredItem(config, config.token_file);
    assert.equal((await next()).next.address, second);
    f.objects.get(second).document.data.assignee = null;
    assert.equal((await next()).next.address, second);
    f.objects.get(second).document.data.assignee = 'another-run';
    assert.equal((await next()).next, null);
    assert.deepEqual(config, before);
  }
  const selections = f.calls.filter(call => call.name === 'joppa_objects' && !call.args.address);
  assert.ok(selections.length > 0 && selections.every(call => call.args.assignee === ''));
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

test('the real configured queue skips conflicting contexts and selects a disjoint later profile', async t => {
  const f = await plannerFixture(t);
  f.queue.push('task:t1', 'task:t2');
  f.objects.get('ac:a1').document.data.stage = 'to_task';
  const related = {limit: 90, parent: {kind: 'ac'}};
  const config = {...f.config, workflow: '/tmp/workflow.yaml', inputs: [
    {selection: {kind: 'ac', data: {stage: 'to_task'}}, exclude_children: null},
    {selection: {kind: 'task', data: {stage: 'ready'}}, related, exclude_children: null}]};
  const skip = contextAdmission([{address: 'task:t1', config: {...config, inputs: undefined, related}}]);
  const result = await nextConfiguredItem(config, config.token_file, undefined, skip);
  assert.equal(result.next.address, 'task:t2');
  assert.equal(result.next.input, 1);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

test('the dispatcher skips a shared parent before input.json while disjoint workers keep their slots', async t => {
  const f = await plannerFixture(t, {concurrency: 3}, 0, '#!/bin/sh\nexec "$TEST_NODE" "$TEST_WORKER" "$5"\n');
  f.queue.push('task:t1', 'task:t2', 'task:t3');
  const third = structuredClone(f.objects.get('task:t1')); third.address = 'task:t3';
  f.objects.set(third.address, third);
  const workflow = path.join(f.root, 'workflow.yaml'), worker = path.join(f.root, 'startup.cjs');
  const release = path.join(f.root, 'release'); fs.mkdirSync(release); fs.writeFileSync(workflow, 'nodes: {}\n');
  fs.writeFileSync(worker, `const fs=require('node:fs'),path=require('node:path'),address=process.argv[2];
fs.appendFileSync(process.env.TEST_PASSES,JSON.stringify({address,input:process.env.PLANNING_JOPPA_INPUT})+'\\n');
process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));
setInterval(()=>{if(fs.existsSync(path.join(process.env.TEST_RELEASE,address)))process.exit(0);},20);`);
  Object.assign(f.env, {TEST_NODE: process.execPath, TEST_WORKER: worker, TEST_RELEASE: release});
  f.write({...f.config, workflow, inputs: [{selection: {kind: 'ac', data: {stage: 'absent'}}},
    {selection: {kind: 'task', data: {stage: 'ready'}}, related: {limit: 90, parent: {kind: 'ac'}}}]});
  const starts = () => f.passes().map(line => JSON.parse(line));
  const run = f.start();
  try {
    await run.until(() => starts().length === 2);
    const checked = f.calls.filter(call => call.name === 'joppa_objects' && !call.args.address).length;
    await run.until(() => f.calls.filter(call => call.name === 'joppa_objects' && !call.args.address).length > checked);
    assert.deepEqual(starts().map(row => row.address).sort(), ['task:t1', 'task:t2']);
    assert.ok(starts().every(row => row.input === '1'));
    fs.writeFileSync(path.join(release, 'task:t1'), '');
    await run.until(() => starts().length === 3);
    assert.equal(starts()[2].address, 'task:t3');
    assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
  } finally { if (run.child.exitCode === null) await run.stop(); }
});

test('either active child stage excludes an AC before a claim while done Tasks allow it', async t => {
  const f=await plannerFixture(t);f.queue.push('task:t1');
  f.objects.get('ac:a1').document.data.stage='to_task';
  const config={...f.config,workflow:'/tmp/workflow.yaml',selection:{kind:'ac',data:{stage:'to_task'}},
    exclude_children:['to_implement','to_review'].map(stage=>({kind:'task',data:{stage}}))};
  const task=f.objects.get('task:t1');
  for(const stage of ['to_implement','to_review','done']){
    task.document.data.stage=stage;
    const result=await nextConfiguredItem(config,config.token_file);
    assert.equal(result.next?.address??null,stage==='done'?'ac:a1':null);
  }
  assert.equal(f.calls.some(call=>call.name==='joppa_batch'),false);
  assert.ok(f.calls.filter(call=>call.args.parent==='ac:a1').every(call=>!Array.isArray(call.args.data?.stage)));
});

test('a typed owner question excludes its Task on the next selection without another claim',async t=>{
  const f=await plannerFixture(t);f.queue.push('task:t1');
  const config=JSON.parse(fs.readFileSync(new URL('../../tasker/config.example.json',import.meta.url)));
  const profile=config.inputs.find(input=>input.selection.kind==='task');
  assert.equal(Object.hasOwn(profile,'exclude_tags'),false);
  const candidate=f.objects.get('task:t1');candidate.document.data.stage='to_review';candidate.document.data.tags=['wallet'];
  const settings={...f.config,workflow:'/tmp/workflow.yaml',exclude_tags:config.exclude_tags,inputs:[{
    ...profile,selection:{kind:'task',data:{stage:'to_review'}},related:undefined}]};
  assert.equal((await nextConfiguredItem(settings,f.config.token_file)).next.address,candidate.address);
  const gapTags=JSON.parse(config.vars.TASKER_GAP_TAGS);
  const result=repairPublication({input:{selected:candidate,claim_revision:candidate.current_revision,schema:{types:{}},
    context:{parent:f.objects.get('ac:a1'),children:[],references:{},incoming:[]}},
    draft:{verdict:'DECISION_REQUIRED',reason:'An owner decision is missing',gap:{owner:'cto',question:'Which interface?',a:'Use A.',b:'Use B.',recommended:'A'}},run:'no-loop',gapTags});
  Object.assign(candidate.document.data,result.publication.operations[0].command.data);
  assert.deepEqual(candidate.document.data.tags,['wallet',gapTags.cto]);
  for(let pass=0;pass<3;pass++)assert.equal((await nextConfiguredItem(settings,f.config.token_file)).next,null);
  assert.equal(f.calls.some(call=>call.name==='joppa_batch'),false);
});

test('Tasker retries check current prerequisites before any claim, trees or models',async t=>{
  const f=await plannerFixture(t);f.queue.push('task:t1');
  const task=f.objects.get('task:t1'),prerequisite=f.objects.get('task:t2'),parent=f.objects.get('ac:a1');
  Object.assign(task.document.data,{stage:'to_review',tags:['wallet'],assignee:null});task.current_revision=5;
  prerequisite.document.present=false;delete prerequisite.document.data.commit;
  const link={relation:'depends_on',blocking:true,target:prerequisite.address};task.document.links=[link];
  const base=JSON.parse(fs.readFileSync(new URL('../../tasker/config.example.json',import.meta.url)));
  const profile=base.inputs.find(input=>input.selection.kind==='task');
  const config={...base,...f.config,mcp_command:f.config.mcp_command,workflow:base.workflow,retry:'always',inputs:[profile]};f.write(config);
  const definition=new URL('../../tasker/',import.meta.url).pathname;
  const workflow=fs.readFileSync(path.join(definition,'workflow.yaml'),'utf8');
  const prepare=workflow.split('  prepare:\n')[1].split('    shell: |\n')[1].split('    on_signal:')[0];
  const filter=retryFilter(config,[{attemptKey:JSON.stringify([task.address,task.current_revision])}],new Set(),new Map());
  const vars=Object.fromEntries(Object.entries(config.vars).map(([key,value])=>[key,typeof value==='string'?value:JSON.stringify(value)]));
  const invoke=async(index,command)=>{
    const run=path.join(f.root,'preclaim-'+index);
    const env={...process.env,...vars,MEDULLA_RUN_DIR:run,MEDULLA_WORKFLOW_DIR:definition,
      CREW_FLOW_STAGES:new URL('../../planning-joppa/flow_stages.py',import.meta.url).pathname,
      PLANNING_JOPPA_CONFIG:f.configFile,PLANNING_JOPPA_ITEM:task.address,TASKER_BUN:process.execPath,
      FLOW_PUBLICATION:JSON.stringify(profile.publication)};
    const child=Bun.spawn(command??['bash','-c',prepare],{env,stdout:'pipe',stderr:'pipe'});
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    return {code,stdout,stderr,run};
  };
  for(const inherited of [false,true]){
    task.document.links=inherited?[]:[link];parent.document.links=inherited?[link]:[];
    const frozen=structuredClone(f.objects);
    for(let pass=0;pass<3;pass++){
      assert.equal((await nextConfiguredItem(config,config.token_file,undefined,filter)).next.address,task.address);
      const result=await invoke(`${inherited}-${pass}`);
      assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/<signal:BLOCKED>/);
      assert.doesNotMatch(result.stdout,/<signal:READY_TO_WRITE>|<signal:var key=tasker_assignment_path>/);
      const artifacts=path.join(result.run,'artifacts');
      const outcome=JSON.parse(fs.readFileSync(path.join(artifacts,'result.json')));
      assert.equal(outcome.reason_code,'TASK_PREREQUISITE');assert.equal(outcome.claim_released,false);
      assert.equal(fs.existsSync(path.join(artifacts,'input.json')),false);
      assert.equal(fs.existsSync(path.join(artifacts,'tasker-assignment.json')),false);
      assert.equal(fs.existsSync(path.join(artifacts,'trees.json')),false);
    }
    assert.deepEqual(f.objects,frozen);
  }
  prerequisite.document.present=true;prerequisite.document.data.stage='ready';
  const command=[process.execPath,path.join(definition,'completion.mjs'),'preclaim'];
  const pending=await invoke('live',command);assert.equal(pending.code,0,pending.stderr);assert.match(pending.stdout,/<signal:BLOCKED>/);
  prerequisite.document.present=false;prerequisite.document.data.commit='a'.repeat(40);prerequisite.current_revision++;
  const delivered=await invoke('delivered',command);assert.equal(delivered.code,0,delivered.stderr);assert.match(delivered.stdout,/<signal:CONTINUE>/);
  assert.equal((await nextConfiguredItem(config,config.token_file,undefined,filter)).next.address,task.address);
  assert.equal(f.calls.some(call=>call.name==='joppa_batch'),false);
});
