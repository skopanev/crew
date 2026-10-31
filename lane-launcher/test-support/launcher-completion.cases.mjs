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

test('Joppa package completes every Task atomically with the same checked landing', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist);
  const artifacts = packageLanding(f), result = {code: 0, status: 'exited'};
  await finishTask(f.run, f.stateFile, result, artifacts);
  assert.equal(result.completed, true);
  assert.deepEqual(result.tasks.map(task => [task.address, task.status]), [['task:t1', 'done'], ['task:t2', 'done']]);
  const operations = f.run.completionRequest.operations;
  const landing = fs.readFileSync(path.join(artifacts, 'landing.txt'), 'utf8').trim();
  assert.equal(operations.length, 2);
  operations.forEach(({command}, index) => {
    assert.equal(command.id, `task:t${index + 1}`);
    assert.match(command.evidence, new RegExp(`Task: task:t${index + 1}`));
    assert.equal(command.evidence.startsWith(landing), true);
    assert.equal(command.commit, landing.match(/^Landed SHA: ([0-9a-f]+)$/m)[1]);
  });
});

test('Joppa completion names the checked existing commit without Task verification fields', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist);
  const artifacts = packageLanding(f);
  const evidence = fs.readFileSync(path.join(artifacts, 'landing.txt'), 'utf8');
  const sha = evidence.match(/^Landed SHA: ([0-9a-f]+)$/m)[1];
  f.run.repository.targetBranch = 'checked-package';
  fs.unlinkSync(path.join(artifacts, 'landing.txt'));
  fs.writeFileSync(path.join(artifacts, 'verification.txt'), evidence.replace('Landed SHA:', 'Verified existing SHA:'));
  const result = {code: 0, status: 'exited'};
  await finishTask(f.run, f.stateFile, result, artifacts);
  assert.equal(result.completed, true);
  assert(f.run.completionRequest.operations.every(({command}) => command.commit === sha));
  assert(f.run.tasks.every(({address}) => !('verification' in f.objects.get(address).process)));
});

test('Joppa completion keeps a Task current after a parent test-list-only save', async t => {
  const f = await packageFixture(t), parent = f.objects.get('ac:a2');
  parent.contract_revision = parent.current_revision;
  parent.document.data.tests = ['checks.test.js > first'];
  await claimTask(f.run, f.persist);
  const artifacts = packageLanding(f);
  parent.current_revision++;
  parent.document.data.tests = ['checks.test.js > replacement'];
  const result = {code: 0, status: 'exited'};
  await finishTask(f.run, f.stateFile, result, artifacts);
  assert.equal(result.completed, true);
  parent.document.data.title += ' changed';
  assert.notEqual(contractDigest(parent), f.run.claim.contexts.find(context => context.address === parent.address).digest);
});

test('Joppa completion refuses a different confirmed commit', async t => {
  const f = await packageFixture(t, 'wrong-commit');
  await claimTask(f.run, f.persist);
  const artifacts = packageLanding(f), result = {code: 0, status: 'exited'};
  await assert.rejects(finishTask(f.run, f.stateFile, result, artifacts), /did not confirm.*checked SHA/);
  assert.equal(result.completed, undefined);
});

test('Joppa completion preserves an older saved request without silently adding commit', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist);
  const artifacts = packageLanding(f);
  f.run.completionRequest = {workspace: f.run.workspace, request_id: 'saved-before-upgrade',
    operations: [{command: {op: 'complete_task', id: 'task:t1', revision: 3, evidence: 'Earlier request'}}]};
  const saved = structuredClone(f.run.completionRequest), calls = f.calls.length;
  await assert.rejects(finishTask(f.run, f.stateFile, {code: 0, status: 'exited'}, artifacts), /Saved completion request/);
  assert.deepEqual(f.run.completionRequest, saved);
  assert(!f.calls.slice(calls).some(call => call.name === 'joppa_batch'));
});

for (const address of ['ac:a2', 'req:r']) test(`Joppa package refuses completion after ${address} context changes`, async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist);
  const artifacts = packageLanding(f);
  f.objects.get(address).document.data.title += ' changed';
  await assert.rejects(finishTask(f.run, f.stateFile, {code: 0, status: 'exited'}, artifacts), /context changed/);
  assert.equal(f.run.completionRequest, undefined);
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 1);
  for (const task of f.run.tasks) assert.equal(f.objects.get(task.address).process.status, 'in_progress');
});

test('Joppa package preserves a single Task ticket and execution identifier', async t => {
  const f = await packageFixture(t);
  f.run.tasks = [f.run.tasks[0]];
  f.run.executionId = executionId(f.run.task);
  await claimTask(f.run, f.persist);
  assert.equal(f.run.claim.id, executionId('task:t1'));
  assert.equal(f.run.claim.ticket.id, executionId('task:t1'));
  assert.equal(f.run.claim.ticket.body, f.objects.get('task:t1').document.data.body);
  assert.deepEqual(f.run.claim.ticket.modulePaths, ['src/a', 'tests/a']);
  assert.equal(f.run.claim.digest, f.run.claim.tasks[0].digest);
});

test('runtime settings come from the selected config, without a broker profile', async t => {
  const f = await setup(t);
  save(f.configFile, {...f.config, image: 'crew-fixture:tests', dockerEngine: true});
  const config = configFrom(f.configFile, f.env);
  const args = laneArgs(config, 'T1');
  assert.equal(args[args.indexOf('--image') + 1], 'crew-fixture:tests');
  assert.ok(args.includes('--docker-engine'));
  assert.ok(!args.includes('--box'));
  assert.ok(!laneArgs({...config, dockerEngine: false}, 'T1').includes('--docker-engine'));
  save(f.configFile, {...f.config, dockerEngine: 'true'});
  assert.throws(() => configFrom(f.configFile, f.env), /dockerEngine must be/);
});
test('unsupported private Docker fails before reading or claiming a ticket', async t => {
  const f = await setup(t);
  save(f.configFile, {...f.config, dockerEngine: true});
  const result = await execute(launcher, [f.configFile, '--once'], f.env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /requires Medulla with --docker-engine support/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.events), false);
});
test('unsupported coder timeout fails before reading or claiming a ticket', async t => {
  const f = await setup(t);
  save(f.configFile, {...f.config, coderTimeoutSeconds: 1800});
  const result = await execute(launcher, [f.configFile, '--once'], f.env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /requires Medulla with --node-timeout support/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.events), false);
});
test('launches require sourceRoot and pass no repository override', async t => {
  const f = await setup(t);
  const args = laneArgs(configFrom(f.configFile, f.env), 'T1');
  assert.equal(args[args.indexOf('--source-root') + 1], f.config.sourceRoot);
  assert.ok(!args.includes('--repo') && !args.includes('--mount-rw'));
  const {sourceRoot, ...missing} = f.config;
  save(f.configFile, missing);
  assert.throws(() => configFrom(f.configFile, f.env), /needs sourceRoot/);
  save(f.configFile, {...f.config, repo: path.join(f.root, 'sources/repo')});
  assert.throws(() => configFrom(f.configFile, f.env), /repo was removed/);
});
test('worker records completion before notifying; Telegram failure preserves lane outcome', async t => {
  const f = await setup(t);
  fs.writeFileSync(path.join(f.bins, 'bash'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const dir = path.join(f.root, 'worker');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'launch.json');
  save(file, {config: {...f.config, notify: {chatId: 'fixture'}},
    ticket: 'T1', workspace: 'test', args: [], pane: 'fixture', runFolder: path.join(dir, 'lane')});
  const sent = path.join(dir, 'sent.json');
  const result = await execute(worker, [file], notificationEnv(f, file, sent, true));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(read(path.join(dir, 'launch.json')).result.code, 0);
  assert.equal(read(sent).text, '🟢 READY\nTicket: T1');
  assert.match(read(path.join(dir, 'notification-error.json')).error, /fixture delivery failure/);
});
