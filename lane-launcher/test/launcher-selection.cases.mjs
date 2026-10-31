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

import {launcher, worker, queueReads, countReads, queueQuery, runState, existingClaim, execute, notificationEnv, setup} from './launcher-ntk.fixture.mjs';
import {packageFixture, blockedPackage, packageLanding} from './launcher-joppa.fixture.mjs';

test('Joppa selects one executable Task in plan order', async t => {
  const f = await packageFixture(t);
  f.queue.push('task:t1');
  const selected = await nextTask(f.run.config);
  assert.deepEqual(selected.candidate.tasks.map(task => task.address), ['task:t1']);
  assert.equal(selected.candidate.requirement, 'req:r');
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

test('Joppa planner reads all compact pages and requests only test status summaries', async t => {
  const f = await packageFixture(t), sample = f.objects.get('ac:a1');
  f.queue.length = 0;
  for (let i = 0; i < 28; i++) f.objects.set(`ac:extra${i}`, {...structuredClone(sample), address: `ac:extra${i}`});
  f.objects.get('ac:extra27').process.planning_claim = {actor: 'another-planner'};
  const rows = await readyCriteria({workspace: f.run.workspace, url: f.run.config.joppa.url}, f.run.joppaWorker.tokenFile);
  assert.equal(rows.length, 29);
  assert(rows.some(row => row.address === 'ac:extra26'));
  assert(!rows.some(row => row.address === 'ac:extra27'));
  const lists = f.calls.filter(call => call.name === 'joppa_objects' && !call.args.address);
  assert(lists.some(call => call.args.cursor === '25'));
  assert(lists.every(call => call.args.limit === 25 && call.args.fields.includes('process')));
  assert(f.calls.filter(call => call.name === 'joppa_tests').every(call => call.args.summary === true));
});

test('Joppa selects structured Tasks and detects their remote repository holders', async t => {
  const f = await packageFixture(t);
  for (const index of [1, 2]) Object.assign(f.objects.get(`task:t${index}`).document.data, {
    body: `Goal: scoped change ${index}`, repository: 'app', module: `m${index}`,
    steps: ['Implement the scoped change.'], checks: [`Exercise the change => exact check ${index}`]});
  const before = contractDigest(f.objects.get('task:t1'));
  assert.equal((await nextTask(f.run.config)).candidate.id, 'task:t1');
  f.objects.get('task:t2').process = {status: 'in_progress', assignee: 'manual-worker'};
  assert.equal((await nextTask(f.run.config)).candidate, null);
  assert.equal(contractDigest(f.objects.get('task:t1')), before);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

test('Joppa planner attempt identity keeps the contract revision after a test-list-only save', async t => {
  const f = await packageFixture(t), ac = f.objects.get('ac:a1');
  f.queue.length = 0;
  ac.contract_revision = ac.current_revision;
  const config = {workspace: f.run.workspace, url: f.run.config.joppa.url};
  const before = await readyCriteria(config, f.run.joppaWorker.tokenFile);
  ac.current_revision++;
  ac.document.data.tests = ['checks.test.js > required'];
  const after = await readyCriteria(config, f.run.joppaWorker.tokenFile);
  assert.equal(after.find(row => row.address === ac.address).revision, ac.current_revision);
  assert.deepEqual(after.map(row => row.attemptKey), before.map(row => row.attemptKey));
  const readObject = async (tool, args) => tool === 'joppa_tree' ?
    {schema: {types: {req: {role: 'requirement'}}}} : structuredClone(f.objects.get(args.address));
  assert.deepEqual(await groupRequirements(after, readObject), await groupRequirements(before, readObject));
  ac.contract_revision = ac.current_revision;
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
  save(path.join(reserved, 'launch.json'), {...f.run, requirement: 'req:other', repositoryId: 'app'});
  const selected = await nextTask(config);
  assert.equal(selected.candidate.id, 'task:t1');
  assert.equal(f.calls.some(call => call.name === 'joppa_tasks' && call.args.view === 'mine'), false);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

