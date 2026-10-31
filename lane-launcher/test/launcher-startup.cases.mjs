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

for (const state of ['retained', 'removed', 'other-repository']) test(`Joppa package handles a ${state} blocked sibling checkout`, async t => {
  const f = await packageFixture(t);
  f.queue.splice(0, 1);
  const root = path.join(f.root, 'worktrees'), folder = path.join(f.root, 'runs/11111111-1111-4111-8111-111111111111');
  fs.mkdirSync(root);
  fs.mkdirSync(folder, {recursive: true});
  f.run.config.worktreeRoot = root;
  const repositoryId = state === 'other-repository' ? 'other' : 'app';
  const run = {...f.run, task: 'task:t2', tasks: [{address: 'task:t2'}, {address: 'task:old3'}], repositoryId,
    executionId: executionId(`req:r\n${repositoryId}`),
    result: {code: 1, blockConfirmed: true, finishedAt: new Date().toISOString()}};
  if (state !== 'removed') fs.mkdirSync(path.join(root, run.executionId));
  save(path.join(folder, 'launch.json'), run);
  const selected = await nextTask(f.run.config);
  if (state === 'retained') assert.equal(selected.candidate, null);
  else assert.deepEqual(selected.candidate.tasks.map(task => task.address), ['task:t1']);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

test('Joppa package keeps manual existing checkout handling in lane startup', async t => {
  const f = await packageFixture(t);
  f.queue.splice(0, 1);
  f.run.config.worktreeRoot = path.join(f.root, 'worktrees');
  fs.mkdirSync(path.join(f.run.config.worktreeRoot, executionId('task:t1')), {recursive: true});
  assert.deepEqual((await nextTask(f.run.config)).candidate.tasks.map(task => task.address), ['task:t1']);
});

test('Joppa package unconfirmed worker outcome remains held', async t => {
  const f = await packageFixture(t, 'outcome-reject');
  Object.assign(f.run.config, {readOnlyRepos: [], gateCommands: ['true'], sshDir: f.root});
  const bins = path.join(f.root, 'bins'), artifacts = path.join(f.run.runFolder, 'fixture/artifacts');
  fs.mkdirSync(bins);
  fs.mkdirSync(artifacts, {recursive: true});
  fs.writeFileSync(path.join(artifacts, 'failure.txt'), 'Gate failed');
  fs.writeFileSync(path.join(bins, 'bash'), '#!/bin/sh\nexit 1\n', {mode: 0o755});
  f.persist();
  const result = await execute(worker, [f.stateFile], {...process.env, PATH: `${bins}:${process.env.PATH}`});
  assert.equal(result.code, 2, result.stderr);
  const saved = read(f.stateFile);
  assert.equal(saved.result.held, true);
  assert.equal(saved.result.blocked, false);
  assert.equal(saved.result.blockConfirmed, undefined);
  assert.match(saved.result.error, /JOPPA_OUTCOME_UNCONFIRMED/);
});

for (const scenario of ['cbm-sync', 'mcp-bridge', 'removed-worktree', 'container-cli-rejected', 'released-startup', 'released-native-run', 'unlabelled-container', 'checkout-present', 'broken-symlink', 'native-run', 'medulla-started', 'docker-present', 'contract-changed', 'unknown-exit', 'surviving-child']) {
  test(`Joppa pre-Medulla startup handling (${scenario}) releases only when unused and confirmed`, async t => {
    const f = await packageFixture(t);
    const worktreeRoot = path.join(f.root, 'worktrees'), bins = path.join(f.root, 'bins'), marker = path.join(f.root, 'ran');
    fs.mkdirSync(worktreeRoot);
    fs.mkdirSync(bins);
    f.run.config.repositories[0].gateCommands = ['true'];
    Object.assign(f.run.config, {worktreeRoot, readOnlyRepos: [], gateCommands: ['true'], sshDir: f.root});
    const checkout = path.join(worktreeRoot, f.run.executionId);
    const synced = '[sync] app: shared CBM refused tools/call: index worker ended with exit_nonzero';
    const line = scenario === 'removed-worktree' ? `run.sh: removed unused worktree: ${checkout}` :
      ['container-cli-rejected', 'released-startup', 'released-native-run', 'unlabelled-container'].includes(scenario) ? `[medulla] session container medulla-sess-test starting\nerror: unrecognized arguments: --node-timeout implement_code=1800\nrun.sh: removed unused worktree: ${checkout}` :
      scenario === 'mcp-bridge' ? 'MCP bridge: failed: no listener could be started' :
      scenario === 'medulla-started' ? `${synced}\n[medulla] session container medulla-sess-1` :
      scenario === 'unknown-exit' ? 'unexpected pre-launch crash' : synced;
    const dockerOutput = scenario === 'docker-present' ? 'echo medulla-sess-1\n' :
      scenario === 'unlabelled-container' ? 'case "$4" in name=*) echo medulla-sess-test;; esac\n' : '';
    fs.writeFileSync(path.join(bins, 'docker'), `#!/bin/sh\n${dockerOutput}exit 0\n`, {mode: 0o755});
    const survivorFile = path.join(f.root, 'survivor.pid');
    const survivor = scenario === 'surviving-child' ? `sleep 60 </dev/null >/dev/null 2>&1 &\necho $! > '${survivorFile}'\n` : '';
    t.after(() => {
      if (fs.existsSync(survivorFile)) {
        try { process.kill(Number(fs.readFileSync(survivorFile, 'utf8')), 'SIGTERM'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    });
    fs.writeFileSync(path.join(bins, 'bash'), `#!/bin/sh\ntouch '${marker}'\nprintf '%s\\r\\n' "${line}" >&2\n${survivor}exit 2\n`, {mode: 0o755});
    if (scenario === 'checkout-present') fs.mkdirSync(checkout);
    if (scenario === 'broken-symlink') fs.symlinkSync(path.join(f.root, 'missing-target'), checkout);
    if (['native-run', 'released-native-run'].includes(scenario)) fs.mkdirSync(path.join(laneRunFolder(f.run.runFolder, f.run.config.id), 'run-1'), {recursive: true});
    const manuallyReleased = scenario.startsWith('released-');
    if (manuallyReleased) for (const object of [f.objects.get('task:t1'), f.objects.get('task:t2')]) {
      let process = object.process;
      Object.defineProperty(object, 'process', {enumerable: true,
        get: () => fs.existsSync(marker) ? {status: 'open', assignee: null} : process,
        set: value => { process = value; },
      });
    }
    if (scenario === 'contract-changed') {
      const data = f.objects.get('task:t1').document.data, original = data.body;
      Object.defineProperty(data, 'contract', {
        enumerable: true,
        get: () => fs.existsSync(marker) ? `${original}\nChanged: after claim` : original,
      });
    }
    f.persist();
    const result = await execute(worker, [f.stateFile], {...process.env, PATH: `${bins}:${process.env.PATH}`});
    assert.equal(result.code, 2, result.stderr);
    assert.equal(fs.existsSync(marker), true, scenario);
    const saved = read(f.stateFile), released = ['cbm-sync', 'mcp-bridge', 'removed-worktree', 'container-cli-rejected', 'released-startup'].includes(scenario);
    assert.equal(saved.releaseConfirmed === true, released, scenario);
    assert.equal(saved.result.released === true, released, scenario);
    assert.equal(saved.result.held === true, !released, scenario);
    assert.equal(Boolean(saved.result.blocked), false, scenario);
    assert.equal(runHoldsTasks(saved), !released, scenario);
    if (manuallyReleased) assert.equal(f.calls.filter(call => call.name === 'joppa_batch' &&
      call.args.operations.some(item => item.command.op === 'release_task')).length, 0, scenario);
    for (const address of ['task:t1', 'task:t2']) {
      assert.equal(f.objects.get(address).process.status, released || manuallyReleased ? 'open' : 'in_progress', scenario);
      assert.equal(f.objects.get(address).process.assignee, released || manuallyReleased ? null : 'lane-1', scenario);
    }
  });
}
