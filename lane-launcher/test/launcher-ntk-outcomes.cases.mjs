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

for (const scenario of ['blocked', 'upload-failed', 'done', 'unclaimed', 'adopted', 'unrelated-code']) {
  test(`preexisting worktree startup: ${scenario}`, async t => {
    const f = await setup(t, {reportUploadFailure: scenario === 'upload-failed', claimRefused: scenario === 'unclaimed'});
    assert.equal((await f.run()).code, 0);
    const dir = runState(f), file = path.join(dir, 'launch.json');
    const run = ['done', 'adopted'].includes(scenario) ? existingClaim(f, dir) : read(file);
    const reason = 'WORKTREE PREEXISTED: /fixture/.worktrees/T1; retained unchanged; inspect before retrying';
    fs.writeFileSync(path.join(f.bins, 'bash'), `#!/bin/sh\necho 'run.sh: ${scenario === 'unrelated-code' ? 'unrelated failure' : reason}' >&2\nexit 73\n`, {mode: 0o755});
    if (scenario === 'done') f.setStatus('done');
    if (scenario === 'unclaimed') { delete run.claim; save(file, run); }
    if (scenario === 'adopted') {
      const artifacts = path.join(run.runFolder, 'fixture', 'artifacts');
      fs.mkdirSync(artifacts, {recursive: true});
      save(path.join(artifacts, 'claim.json'), {...run.claim, run_dir: path.dirname(artifacts)});
    }
    const output = await execute(worker, [file], f.env);
    const result = read(path.join(dir, 'launch.json')).result;
    const blocked = scenario === 'blocked' || scenario === 'upload-failed';
    assert.equal(result.blocked === true, blocked);
    assert.equal(result.reopened === true, scenario === 'unrelated-code');
    const patches = f.calls.filter(call => call.method === 'PATCH');
    assert.equal(patches.length, blocked || scenario === 'unrelated-code' ? 1 : 0);
    if (blocked) {
      assert.deepEqual(patches[0].body, {workspace: 'test', status: 'blocked', force: true,
        tag_edits: ['+worktree_preexistited']});
      assert.equal(result.error, reason);
      assert.match(output.stdout, /T1 blocked: WORKTREE PREEXISTED/);
      assert.match(fs.readFileSync(path.join(dir, 'startup-failure.txt'), 'utf8'), /Worktree and branches were not modified/);
      const upload = f.calls.find(call => call.url === '/startup-upload');
      assert.ok(upload.body.includes(reason));
      assert.equal(f.calls.some(call => call.url.endsWith('/attachments/commit')), scenario === 'blocked');
      assert.equal(Boolean(result.reportError), scenario === 'upload-failed');
    }
    if (scenario === 'done') assert.match(result.blockError, /Ticket changed/);
  });
}
test('existing external Docker lane prevents a queue read', async t => {
  const f = await setup(t);
  fs.writeFileSync(f.docker, JSON.stringify({workflow: 'lane', runFolder: scopeDirectory('/manual, runs', f.config.id)}));
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(queueReads(f), 0);
  assert.equal(countReads(f).length, 0);
  assert.doesNotMatch(result.stdout, /Tickets with tags/);
});
test('another dispatcher and unscoped containers do not occupy this dispatcher', async t => {
  const f = await setup(t);
  fs.writeFileSync(f.docker, [
    {workflow: 'lane', runFolder: scopeDirectory('/manual', f.config.id + '-other')},
    {workflow: 'lane', runFolder: ''},
    {workflow: '', runFolder: ''},
    {workflow: 'planning', runFolder: scopeDirectory('/manual', f.config.id)},
  ].map(row => JSON.stringify(row)).join('\n'));
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running lanes 0 of 1/);
  assert.equal(queueReads(f), 1);
});
test('config IDs isolate reservations and locks in the same state root', async t => {
  const f = await setup(t);
  assert.equal((await f.run()).code, 0);
  fs.mkdirSync(path.join(f.stateDir, 'dispatcher.lock'));
  const otherFile = path.join(f.root, 'other.json');
  save(otherFile, {...f.config, id: 'other-project'});
  const result = await execute(launcher, ['--config', otherFile, '--once'], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running lanes 0 of 1/);
  assert.equal(queueReads(f), 2);
  const other = configFrom(otherFile, f.env);
  const [runId] = fs.readdirSync(path.join(other.stateDir, 'runs'));
  const run = read(path.join(other.stateDir, 'runs', runId, 'launch.json'));
  assert.equal(run.args[run.args.indexOf('--dispatcher-id') + 1], 'other-project');
  assert.equal(laneRunFolder(run.runFolder, 'other-project'), run.runFolder);
  assert.ok(fs.existsSync(path.join(f.stateDir, 'dispatcher.lock')));
});
test('completed lane frees capacity even when its Herdr tab remains', async t => {
  const f = await setup(t);
  assert.equal((await f.run()).code, 0);
  const [runId] = fs.readdirSync(path.join(f.stateDir, 'runs'));
  save(path.join(f.stateDir, 'runs', runId, 'launch.json'), {...read(path.join(f.stateDir, 'runs', runId, 'launch.json')), result: {status: 'exited', code: 0}});
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running lanes 0 of 1/);
  assert.equal(queueReads(f), 2);
});
test('dispatcher IDs are stable path-safe identities, including manual lanes', () => {
  assert.equal(validateId('Project-Backend'), 'project-backend');
  for (const id of ['', '../other', 'a/b', 'a,b', 'has space', 'a'.repeat(65), undefined]) {
    assert.throws(() => validateId(id), /needs id/);
  }
  const folder = laneRunFolder('/manual/runs', 'project-backend');
  assert.equal(folder, '/manual/runs/crew-dispatchers/project-backend');
  assert.equal(laneRunFolder(folder, 'project-backend'), folder);
  assert.throws(() => laneRunFolder(folder, 'another'), /another dispatcher/);
});
test('Docker failure fails closed before any queue read', async t => {
  const f = await setup(t, {dockerFailure: true});
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.equal(f.calls.length, 0);
});
test('empty queue leaves Herdr tabs unchanged', async t => {
  const f = await setup(t, {empty: true});
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Tickets with tags \[workspace=test, tags=crew, strict=true\]: 0 open · ready to work: 0/);
  assert.ok(!fs.readFileSync(f.events, 'utf8').includes('create'));
});
test('count failure reports unavailable and still dispatches the next ticket', async t => {
  const f = await setup(t, {countFailure: true});
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Tickets with tags \[workspace=test, tags=crew, strict=true\]: unavailable/);
  assert.match(result.stdout, /Starting new one with ticket: T1/);
  assert.equal(queueReads(f), 1);
  assert.ok(!f.calls.some(call => call.url.startsWith('/v1/tickets/T1/start')));
});
test('open tickets with no NTK candidate show blocked and zero ready without claiming', async t => {
  const f = await setup(t, {noReady: true});
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /17 open \(blocked\) · ready to work: 0/);
  assert.equal(queueReads(f), 1);
  assert.ok(!f.calls.some(call => call.url.startsWith('/v1/tickets/T1/start')));
  assert.ok(!fs.readFileSync(f.events, 'utf8').includes('create'));
});
test('lock refuses a second dispatcher before it selects work', async t => {
  const f = await setup(t);
  fs.mkdirSync(path.join(f.stateDir, 'dispatcher.lock'), {recursive: true});
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Dispatcher lock exists/);
  assert.equal(f.calls.length, 0);
});
test('Docker and its pending reservation count as one lane', async t => {
  const f = await setup(t);
  const dir = path.join(f.stateDir, 'runs', 'test');
  fs.mkdirSync(dir, {recursive: true});
  const runFolder = path.join(f.stateDir, 'runs/test/lane');
  save(path.join(dir, 'launch.json'), {runFolder, pane: 'test-pane'});
  const containers = dockerLanes(JSON.stringify({workflow: 'lane', runFolder}), f.config);
  assert.equal(activeCount({...f.config, stateDir: f.stateDir}, containers, new Set(['test-pane'])), 1);
});
