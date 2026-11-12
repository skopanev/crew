// Independent acceptance tests for requirement:dispatch-config (black box from the criteria and their Sources).
// ac:dispatch-config-filters  Dolber selects work by configured repository ID
// ac:lj09qffa                 One worker serves every lane slot
// ac:dispatch-config-preview  Dry run overrides live launch settings
// ac:dispatch-config-runtime  Runtime settings come from the configuration
// ac:vbuca5c8                 Unsupported private Docker stops before the queue
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {configFrom} from '../launcher.mjs';
import {nextTask} from '../joppa.mjs';
import {save, laneArgs, runDirectories} from '../runtime.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';
import {launcher, queueReads, execute, setup} from '../test-support/launcher.fixture.mjs';

const writes = calls => calls.filter(call => ['joppa_batch', 'joppa_command'].includes(call.name));
const herdrEvents = f => fs.existsSync(f.events) ? fs.readFileSync(f.events, 'utf8').trim().split('\n').map(JSON.parse) : [];

// ---------- ac:dispatch-config-filters  Dolber selects work by configured repository ID ----------

// The configuration lists repository app and names no project. t1: Repository app, no projects.
// t2: Repository app and project:other. t3: Repository unknown.
async function repositoryQueue(t, queue = ['task:t1', 'task:t2', 'task:t3']) {
  const f = await packageFixture(t);
  assert.deepEqual(f.run.config.repositories.map(repo => repo.id), ['app']);
  assert.equal(Object.hasOwn(f.run.config, 'project'), false);
  delete f.objects.get('task:t1').document.data.projects;
  f.objects.get('task:t2').document.data.projects = ['project:other'];
  const t3 = structuredClone(f.objects.get('task:t1'));
  Object.assign(t3, {address: 'task:t3'});
  t3.document.parent = 'ac:a1';
  t3.document.data = {title: '[03] Task 3', body: 'Goal: scoped change 3\nRepository: unknown\nModule: m1\nChecks: exact check 3'};
  f.objects.set('task:t3', t3);
  f.queue.splice(0, f.queue.length, ...queue);
  return f;
}

test('ac:dispatch-config-filters nominal: t1 without projects and t2 with project:other are available for repository app, t3 of repository unknown is skipped', async t => {
  const f = await repositoryQueue(t);
  const selected = await nextTask(f.run.config);
  assert.equal(selected.available, 2);
  assert.equal(selected.candidate.id, 'task:t1');
  assert.equal(selected.candidate.repository, 'app');
  assert.deepEqual(f.objects.get('task:t2').document.data.projects, ['project:other']);
  assert.equal(writes(f.calls).length, 0);
});

test('ac:dispatch-config-filters boundary: t2 with project:other is selected for repository app when t1 is absent and t3 declares unknown', async t => {
  const f = await repositoryQueue(t, ['task:t2', 'task:t3']);
  const selected = await nextTask(f.run.config);
  assert.equal(selected.available, 1);
  assert.equal(selected.candidate.id, 'task:t2');
  assert.deepEqual(f.objects.get('task:t2').document.data.projects, ['project:other']);
});

test('ac:dispatch-config-filters boundary: a structured t1 with data repository app and steps and no projects is available', async t => {
  const f = await repositoryQueue(t, ['task:t1', 'task:t3']);
  f.objects.get('task:t1').document.data = {title: '[01] Task 1', body: 'Goal: scoped change 1',
    repository: 'app', module: 'm1', steps: ['Implement the scoped change.'], checks: ['Exercise the change => exact check 1']};
  const selected = await nextTask(f.run.config);
  assert.equal(selected.available, 1);
  assert.equal(selected.candidate.id, 'task:t1');
});

test('ac:dispatch-config-filters off_nominal: a queue with only t3 of repository unknown gives no candidate and 0 available', async t => {
  const f = await repositoryQueue(t, ['task:t3']);
  const selected = await nextTask(f.run.config);
  assert.equal(selected.candidate, null);
  assert.equal(selected.available, 0);
});

// ---------- ac:lj09qffa  One worker serves every lane slot ----------

test('ac:lj09qffa nominal: a configuration with lane limit 4 and one worker is accepted and selects ready Task t1 of repository app', async t => {
  const f = await setup(t);
  f.joppa.queue.splice(0, f.joppa.queue.length, 'task:t1');
  save(f.configFile, {...f.config, limit: 4});
  const config = configFrom(f.configFile, f.env);
  assert.equal(config.limit, 4);
  assert.equal(config.joppa.workers.length, 1);
  const selected = await nextTask(config);
  assert.equal(selected.candidate.id, 'task:t1');
  assert.equal(selected.candidate.repository, 'app');
});

test('ac:lj09qffa boundary: a dry run with lane limit 4 and one worker reports 0 of 4 lanes and previews t1', async t => {
  const f = await setup(t);
  f.joppa.queue.splice(0, f.joppa.queue.length, 'task:t1');
  save(f.configFile, {...f.config, limit: 4});
  const result = await execute(launcher, ['--config', f.configFile, '--dry-run'], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running lanes 0 of 4/);
  assert.match(result.stdout, /task:t1/);
});

// ---------- ac:dispatch-config-preview  Dry run overrides live launch settings ----------

test('ac:dispatch-config-preview nominal: --dry-run on a launchLanes true configuration previews t1 once with no claim, no tab and an unchanged configuration file', async t => {
  const f = await setup(t);
  const before = fs.readFileSync(f.configFile, 'utf8');
  assert.equal(JSON.parse(before).launchLanes, true);
  const result = await execute(launcher, ['--config', f.configFile, '--dry-run'], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /task:t1/);
  assert.equal(queueReads(f), 1);
  assert.equal(writes(f.calls).length, 0, 'no claim and no Joppa write');
  assert.deepEqual(herdrEvents(f), [], 'no Herdr tab');
  assert.deepEqual(runDirectories(f.stateDir), []);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
});

test('ac:dispatch-config-preview boundary: --dry-run with intervalSeconds 1 and no --once exits by itself after 1 queue read', async t => {
  const f = await setup(t);
  save(f.configFile, {...f.config, intervalSeconds: 1});
  const before = fs.readFileSync(f.configFile, 'utf8');
  const child = spawn(process.execPath, [launcher, '--config', f.configFile, '--dry-run'], {env: f.env});
  let stderr = '';
  child.stderr.on('data', data => stderr += data);
  const code = await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('killed after 5 s'); }, 5000);
    child.once('close', value => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 0, stderr);
  assert.equal(queueReads(f), 1);
  assert.equal(writes(f.calls).length, 0);
  assert.deepEqual(herdrEvents(f), []);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
});

test('ac:dispatch-config-preview off_nominal: the same launchLanes true configuration without --dry-run opens a Herdr tab for t1', async t => {
  const f = await setup(t);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.ok(herdrEvents(f).some(args => args[0] === 'tab' && args[1] === 'create'), 'a live pass opens a tab');
});

// ---------- ac:dispatch-config-runtime  Runtime settings come from the configuration ----------

test('ac:dispatch-config-runtime nominal: image crew-fixture:tests and dockerEngine true give lane arguments --image crew-fixture:tests and --docker-engine without --box', async t => {
  const f = await setup(t);
  save(f.configFile, {...f.config, image: 'crew-fixture:tests', dockerEngine: true});
  const args = laneArgs(configFrom(f.configFile, f.env), 'task:t1');
  const image = args.indexOf('--image');
  assert.ok(image >= 0);
  assert.equal(args[image + 1], 'crew-fixture:tests');
  assert.equal(args.filter(arg => arg === '--docker-engine').length, 1);
  assert.equal(args.includes('--box'), false);
});

test('ac:dispatch-config-runtime boundary: image crew-fixture:tests with dockerEngine false gives --image crew-fixture:tests and no --docker-engine and no --box', async t => {
  const f = await setup(t);
  save(f.configFile, {...f.config, image: 'crew-fixture:tests', dockerEngine: false});
  const args = laneArgs(configFrom(f.configFile, f.env), 'task:t1');
  assert.equal(args[args.indexOf('--image') + 1], 'crew-fixture:tests');
  assert.equal(args.includes('--docker-engine'), false);
  assert.equal(args.includes('--box'), false);
});

// ---------- ac:vbuca5c8  Unsupported private Docker stops before the queue ----------

const medullaHelp = (f, text) => fs.writeFileSync(path.join(f.bins, 'medulla'), `#!/bin/sh\necho '${text}'\n`, {mode: 0o755});

test('ac:vbuca5c8 nominal: launchLanes true and dockerEngine true with a Medulla without --docker-engine support stop once before any Joppa read or claim', async t => {
  const f = await setup(t);
  medullaHelp(f, 'Usage: medulla run --ticket-id ID --image IMAGE');
  save(f.configFile, {...f.config, launchLanes: true, dockerEngine: true});
  const result = await execute(launcher, ['--config', f.configFile, '--once'], f.env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /requires Medulla with --docker-engine support/);
  assert.equal(f.calls.length, 0, 'no Task read and no claim');
  assert.deepEqual(herdrEvents(f), []);
});

test('ac:vbuca5c8 boundary: launchLanes true and dockerEngine true with a Medulla that lists --docker-engine do not stop and read the queue', async t => {
  const f = await setup(t);
  medullaHelp(f, 'Usage: medulla run --ticket-id ID --image IMAGE --docker-engine');
  save(f.configFile, {...f.config, launchLanes: true, dockerEngine: true});
  const result = await execute(launcher, ['--config', f.configFile, '--once'], f.env);
  assert.doesNotMatch(result.stderr, /requires Medulla with --docker-engine support/);
  assert.equal(queueReads(f), 1);
});

test('ac:vbuca5c8 off_nominal: launchLanes false and dockerEngine true with a Medulla without --docker-engine support preview t1 without the stop', async t => {
  const f = await setup(t, {launchLanes: false});
  medullaHelp(f, 'Usage: medulla run --ticket-id ID --image IMAGE');
  save(f.configFile, {...f.config, launchLanes: false, dockerEngine: true});
  const result = await execute(launcher, ['--config', f.configFile, '--once'], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /requires Medulla with --docker-engine support/);
  assert.match(result.stdout, /task:t1/);
});
