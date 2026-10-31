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

test('dolber.sh reads adjacent dolber.json from another cwd and only previews with configured filters', async t => {
  const f = await setup(t, {launchLanes: false});
  const folder = path.join(f.root, 'dolber folder');
  fs.mkdirSync(folder);
  for (const file of ['dolber.sh', 'launcher.mjs', 'runtime.mjs', 'ntk.mjs', 'scope.mjs',
    'dashboard.mjs', 'joppa.mjs', 'joppa-api.mjs', 'mcp-client.mjs', 'task-contract.mjs', 'dependencies.mjs',
    'requirement-delivery.mjs', 'requirement-state.mjs', 'publication-guard.mjs', 'requirement-finalizer.mjs',
    'joppa-common.mjs', 'joppa-config.mjs', 'joppa-selection.mjs', 'joppa-input.mjs',
    'joppa-claims.mjs', 'joppa-outcome.mjs', 'joppa-failure.mjs', 'joppa-recovery.mjs']) {
    fs.copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), path.join(folder, file));
  }
  fs.copyFileSync(fileURLToPath(new URL('../../notify.mjs', import.meta.url)), path.join(f.root, 'notify.mjs'));
  const config = {...f.config, tags: ['open', 'agent-ready'], strict: false,
    preferTags: ['KYC', 'ceo60', 'KYT'], intervalSeconds: 60,
    project: '', sourceRoot: '', cbmMcpCommand: '', sshDir: '', gateCommands: []};
  delete config.launchLanes; // Omission must also default to preview.
  save(path.join(folder, 'dolber.json'), config);
  const result = await execute(path.join(folder, 'dolber.sh'), ['--once'], f.env,
    {bin: 'bash', cwd: f.root});
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split('\n').filter(line => !/^─+$/.test(line));
  assert.equal(lines[0], 'Running lanes 0 of 1');
  assert.equal(lines[1], 'Tickets with tags [workspace=test, tags=open,agent-ready, strict=false]: 17 open · ready to work: ≥1');
  assert.equal(lines[2], 'checking params:');
  assert.equal(lines[3], '  tags: open, agent-ready');
  assert.equal(lines[4], '  prefer: KYC → ceo60 → KYT');
  assert.equal(lines[5], 'Starting new one with ticket: T1 (preview: запуск отключён)');
  const query = queueQuery(f);
  assert.equal(query.searchParams.get('tag'), 'open,agent-ready');
  assert.equal(query.searchParams.get('prefer'), 'KYC,ceo60,KYT');
  assert.equal(query.searchParams.get('strict'), 'false');
  assert.equal(query.searchParams.get('dry_run'), 'true');
  assert.equal(query.searchParams.has('project'), false);
  assert.equal(f.calls.length, 2);
  for (const call of countReads(f)) {
    const countQuery = new URL(call.url, 'http://fixture');
    assert.equal(countQuery.searchParams.get('workspace'), 'test');
    assert.equal(countQuery.searchParams.get('tag'), 'open,agent-ready');
    assert.equal(countQuery.searchParams.get('strict'), 'false');
    assert.equal(countQuery.searchParams.has('project'), false);
    assert.equal(countQuery.searchParams.has('prefer'), false);
  }
  assert.ok(!fs.existsSync(f.events), 'preview must not call Herdr at all');
  assert.deepEqual(runDirectories(f.stateDir), []);
});
test('--dry-run overrides live config, previews once and never calls Herdr or claims work', async t => {
  const f = await setup(t);
  save(f.configFile, {...f.config, project: '', sourceRoot: '', cbmMcpCommand: '', sshDir: '', gateCommands: []});
  const before = fs.readFileSync(f.configFile, 'utf8');
  fs.rmSync(path.join(f.bins, 'medulla'));
  fs.rmSync(path.join(f.bins, 'jq'));
  const result = await execute(fileURLToPath(new URL('../dolber.sh', import.meta.url)),
    [path.basename(f.configFile), '--dry-run'], f.env, {bin: 'sh', cwd: f.root});
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /T1 \(preview: запуск отключён\)/);
  assert.doesNotMatch(result.stdout, /pause /);
  assert.equal(f.calls.length, 2);
  const query = queueQuery(f);
  assert.equal(query.pathname, '/v1/tickets/next');
  assert.equal(query.searchParams.get('dry_run'), 'true');
  assert.ok(!fs.existsSync(f.events));
  assert.deepEqual(runDirectories(f.stateDir), []);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
});
test('--dry-run exits with an error when Docker cannot be inspected', async t => {
  const f = await setup(t, {dockerFailure: true});
  const result = await execute(launcher, ['--config', f.configFile, '--dry-run'], f.env);
  assert.equal(result.code, 1);
  assert.equal(f.calls.length, 0);
  assert.ok(!fs.existsSync(f.events));
});
test('preview loop repeats after its interval and Ctrl+C releases the dispatcher lock', async t => {
  const f = await setup(t, {launchLanes: false});
  save(f.configFile, {...f.config, intervalSeconds: 1});
  const child = spawn(process.execPath, [launcher, '--config', f.configFile], {env: f.env});
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '', signalled = false;
  child.stdout.on('data', data => {
    output += data;
    if (!signalled && (output.match(/preview: запуск отключён/g) || []).length === 2) {
      signalled = true;
      child.kill('SIGINT');
    }
  });
  child.stderr.on('data', data => errors += data);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('loop did not stop')); }, 5000);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(code, 0, errors);
  assert.equal(f.calls.length, 4);
  assert.ok(!fs.existsSync(f.events));
  assert.ok(!fs.existsSync(path.join(f.stateDir, 'dispatcher.lock')));
});
test('terminal dashboard refreshes the countdown and Ctrl+C releases the lock', async t => {
  const f = await setup(t, {launchLanes: false});
  save(f.configFile, {...f.config, intervalSeconds: 10});
  const tty = path.join(f.root, 'tty.cjs');
  fs.writeFileSync(tty, 'process.stdout.isTTY = true;\n');
  const child = spawn(process.execPath, ['--require', tty, launcher, '--config', f.configFile],
    {env: {...f.env, FORCE_COLOR: '0'}});
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '', signalled = false;
  child.stdout.on('data', data => {
    output += data;
    if (!signalled && /Next check in 00:0[4-6]/.test(output)) {
      signalled = true; child.kill('SIGINT');
    }
  });
  child.stderr.on('data', data => errors += data);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('countdown did not stop')); }, 8000);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(code, 0, errors);
  assert.match(output, /Next check in 00:10/);
  assert.match(output, /Next check in 00:0[4-6]/);
  assert.match(output, /Stopped/);
  assert.equal(queueReads(f), 1);
  assert.ok(!fs.existsSync(path.join(f.stateDir, 'dispatcher.lock')));
});
