import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {activeCount, dockerLanes, configFrom} from '../launcher.mjs';
import {scopeDirectory, laneRunFolder, validateId} from '../scope.mjs';
import {save, read, laneArgs, runDirectories} from '../runtime.mjs';
import {claimTask, finishTask, nextTask, executionId, runHoldsTasks, contractDigest, guardTaskClaims} from '../joppa.mjs';
import {cleanupBlockedTasks} from '../../planning-joppa/cleanup.mjs';
import {readyCriteria, groupRequirements} from '../../planning-joppa/dashboard.mjs';

import {launcher, worker, queueReads, execute, notificationEnv, setup, workerFixture} from './launcher.fixture.mjs';
import {packageFixture, blockedPackage, packageLanding} from './launcher-joppa.fixture.mjs';

test('Joppa selects one executable Task in plan order', async t => {
  const f = await packageFixture(t);
  f.queue.push('task:t1');
  const selected = await nextTask(f.run.config);
  assert.deepEqual(selected.candidate.tasks.map(task => task.address), ['task:t1']);
  assert.equal(selected.candidate.requirement, 'req:r');
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
  f.objects.get('task:t1').document.data.stage = 'done';
  assert.equal((await nextTask(f.run.config)).candidate.id, 'task:t2');
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /TASK_COMPLETED: task:t1/);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

test('Joppa selection shares object reads within one worker pass and reads again on the next pass', async t => {
  const f = await packageFixture(t);
  const detailCalls = () => f.calls.filter(call => call.name === 'joppa_objects' && call.args.address);
  const objectReads = () => detailCalls().flatMap(call => call.args.address.split(',')).sort();
  const treeReads = () => f.calls.filter(call => call.name === 'joppa_tree').length;
  // One call reads both Tasks, one reads both parents, and the Requirement two levels up stays a single read.
  const batched = () => detailCalls().map(call => call.args.address.split(',').sort().join(','));
  const once = ['ac:a1', 'ac:a2', 'req:r', 'task:t1', 'task:t2'];
  for (let pass = 0; pass < 2; pass++) {
    f.calls.length = 0;
    const selected = await nextTask(f.run.config);
    assert.deepEqual(selected.candidate.tasks.map(task => task.address), ['task:t1']);
    assert.equal(selected.available, 2);
    assert.equal(selected.held, 0);
    assert.deepEqual(selected.dependencyIssues, []);
    assert.deepEqual(objectReads(), once);
    assert.deepEqual(batched(), ['task:t1,task:t2', 'ac:a1,ac:a2', 'req:r']);
    assert.equal(treeReads(), 1);
  }
  // Each worker keeps its own reads. Blocked dependencies make both workers read the whole queue.
  f.run.config.joppa.workers = [f.run.joppaWorker, {...f.run.joppaWorker, actor: 'lane-2'}];
  f.objects.get('task:t1').document.links = [{relation: 'depends_on', blocking: true, target: 'task:t2'}];
  f.objects.get('task:t2').document.links = [{relation: 'depends_on', blocking: true, target: 'task:t1'}];
  f.calls.length = 0;
  const blocked = await nextTask(f.run.config);
  assert.equal(blocked.candidate, null);
  assert.equal(blocked.available, 0);
  assert.deepEqual(objectReads(), once.flatMap(address => [address, address]));
  assert.equal(detailCalls().length, 6);
  assert.equal(treeReads(), 2);
});

test('Joppa batch reads keep selection when Joppa refuses or shortens a batch', async t => {
  const select = async setup => {
    const f = await packageFixture(t);
    setup(f);
    const selected = await nextTask(f.run.config);
    return {f, selected: {candidate: selected.candidate?.id ?? null, available: selected.available, held: selected.held,
      issues: selected.dependencyIssues.length}};
  };
  const reads = f => f.calls.filter(call => call.name === 'joppa_objects' && call.args.address).map(call => call.args.address);
  const {selected: expected} = await select(() => {});
  // Oversized replies split down to single reads; an alias and a paged comment list stay single reads.
  for (const [name, setup, single] of [
    ['size cap', f => { f.batch.cap = 1; }, ['task:t1', 'task:t2', 'ac:a1', 'ac:a2']],
    ['alias', f => { f.batch.alias['task:t1'] = 'task:renamed'; }, ['task:t1']],
    ['comment pages', f => { f.batch.paged = ['task:t2']; }, ['task:t2']]]) {
    const {f, selected} = await select(setup);
    assert.deepEqual(selected, expected, name);
    for (const address of single) assert(reads(f).includes(address), `${name}: ${address} was read singly`);
  }
  // An unknown dependency target refuses its whole batch. The single reads then decide as before:
  // here the single read of the missing target fails the pass, exactly as without batches.
  const refused = await packageFixture(t);
  refused.objects.get('task:t1').document.links = [{relation: 'depends_on', blocking: true, target: 'task:ghost'}];
  await assert.rejects(nextTask(refused.run.config), /joppa_objects returned no object/);
  assert(reads(refused).some(address => address.includes(',') && address.split(',').includes('task:ghost')));
  assert(reads(refused).includes('task:ghost'));
  // Transport and service errors still fail the pass.
  const failing = await packageFixture(t);
  failing.batch.unavailable = true;
  await assert.rejects(nextTask(failing.run.config), /Joppa MCP HTTP 503/);
});

test('Joppa planner reads all compact pages and uses native criterion tones', async t => {
  const f = await packageFixture(t), sample = f.objects.get('ac:a1');
  f.queue.length = 0;
  for (let i = 0; i < 28; i++) f.objects.set(`ac:extra${i}`, {...structuredClone(sample), address: `ac:extra${i}`});
  f.objects.get('ac:extra27').document.data.assignee = 'crew-planning:another:run';
  f.objects.get('ac:extra4').document.data.hold = 'NEEDS_HUMAN';
  f.objects.get('ac:extra1').status.tone = 'green';
  f.objects.get('ac:extra2').status.tone = 'orange';
  f.objects.get('ac:extra3').status.tone = 'red';
  const rows = await readyCriteria({workspace: f.run.workspace, url: f.run.config.joppa.url}, f.run.joppaWorker.tokenFile);
  assert.equal(rows.length, 27);
  assert(rows.some(row => row.address === 'ac:extra26'));
  assert(!rows.some(row => row.address === 'ac:extra27'));
  assert(!rows.some(row => row.address === 'ac:extra1'));
  assert(!rows.some(row => row.address === 'ac:extra4'));
  assert(rows.some(row => row.address === 'ac:extra2'));
  assert.equal(rows[0].address, 'ac:extra3');
  const lists = f.calls.filter(call => call.name === 'joppa_objects' && !call.args.address);
  assert(lists.some(call => call.args.cursor === '25'));
  assert(lists.every(call => call.args.limit === 25 && call.args.fields.includes('data.hold')));
  assert(lists.filter(call => call.args.kind.includes('ac')).every(call => call.args.fields.includes('status')));
  assert(f.calls.every(call => ['joppa_objects', 'joppa_tree'].includes(call.name)));
});

test('Joppa selects structured Tasks and detects their remote repository holders', async t => {
  const f = await packageFixture(t);
  for (const index of [1, 2]) Object.assign(f.objects.get(`task:t${index}`).document.data, {
    body: `Goal: scoped change ${index}`, repository: 'app', module: `m${index}`,
    steps: ['Implement the scoped change.'], checks: [`Exercise the change => exact check ${index}`]});
  const before = contractDigest(f.objects.get('task:t1'));
  assert.equal((await nextTask(f.run.config)).candidate.id, 'task:t1');
  f.objects.get('task:t2').document.data.assignee = 'manual-worker';
  assert.equal((await nextTask(f.run.config)).candidate.id, 'task:t1');
  assert.equal(contractDigest(f.objects.get('task:t1')), before);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

test('Joppa planner excludes completed criteria but selects their failed remaining Tasks', async t => {
  const f = await packageFixture(t);
  const config = {workspace: f.run.workspace, url: f.run.config.joppa.url};
  const done = f.objects.get('task:t1');
  done.document.present = false;
  done.document.data.commit = 'a'.repeat(40);
  f.objects.get('task:t2').document.parent = 'ac:a1';
  f.objects.get('task:t2').document.present = false;
  const read = () => readyCriteria(config, f.run.joppaWorker.tokenFile);
  assert.deepEqual((await read()).map(row => row.address), ['ac:a2']);
  const failed = f.objects.get('task:t2');
  failed.document.present = true;
  failed.document.data.hold = 'GATE_FAIL';
  const rows = await read();
  assert.equal(rows[0].address, 'ac:a1');
  assert.equal(rows[0].failedTaskCount, 1);
  failed.document.data.assignee = 'another-run';
  assert.deepEqual((await read()).map(row => row.address), ['ac:a2']);
});

test('Joppa planner attempt identity stays current when a test child is added', async t => {
  const f = await packageFixture(t), ac = f.objects.get('ac:a1');
  f.queue.length = 0;
  const config = {workspace: f.run.workspace, url: f.run.config.joppa.url};
  const before = await readyCriteria(config, f.run.joppaWorker.tokenFile);
  f.objects.set('check:required', {address: 'check:required', kind: 'check',
    document: {parent: ac.address, data: {title: 'checks.test.js > required'}}});
  const after = await readyCriteria(config, f.run.joppaWorker.tokenFile);
  assert.equal(after.find(row => row.address === ac.address).revision, ac.current_revision);
  assert.deepEqual(after.map(row => row.attemptKey), before.map(row => row.attemptKey));
  const readObject = async (tool, args) => tool === 'joppa_tree' ?
    {schema: {types: {req: {role: 'requirement'}}}} : structuredClone(f.objects.get(args.address));
  assert.deepEqual(await groupRequirements(after, readObject), await groupRequirements(before, readObject));
  ac.current_revision++;
  assert.notDeepEqual((await readyCriteria(config, f.run.joppaWorker.tokenFile)).map(row => row.attemptKey),
    before.map(row => row.attemptKey));
});

test('one logged-in user can select independent work while another lane reserves capacity', async t => {
  const f = await packageFixture(t), config = f.run.config;
  const proxy = path.join(f.root, 'connector.mjs');
  const module = new URL('../joppa-api.mjs', import.meta.url).href;
  fs.writeFileSync(proxy, `import {callJoppa} from ${JSON.stringify(module)};
import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);if(!('id' in r))continue;
 const result=r.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:
  {structuredContent:await callJoppa(process.argv[2],process.argv[3],r.params.name,r.params.arguments)};
 console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
}`);
  config.joppa.mcpCommand = [process.execPath, proxy, config.joppa.url, config.joppa.workers[0].tokenFile];
  delete config.joppa.workers[0].tokenFile;
  const reserved = path.join(f.root, 'runs', 'active');
  fs.mkdirSync(reserved, {recursive: true});
  save(path.join(reserved, 'launch.json'), {...f.run, task: 'task:other', tasks: [{address: 'task:other'}],
    requirement: 'req:other', repositoryId: 'app'});
  const selected = await nextTask(config);
  assert.equal(selected.candidate.id, 'task:t1');
  assert.equal(f.calls.some(call => call.name === 'joppa_tasks'), false);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});
