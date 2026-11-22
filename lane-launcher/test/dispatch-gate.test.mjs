import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {configFrom} from '../launcher-config.mjs';
import {claimTask, runHoldsTasks} from '../joppa.mjs';
import {runDispatchGate} from '../dispatch-gate.mjs';
import {startupFailure} from '../worker-outcome.mjs';
import {completionEvent, reasonCode} from '../../notify.mjs';
import {read, save, alive, runDirectories} from '../runtime.mjs';
import {setup, launcher, worker, execute} from '../test-support/launcher.fixture.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';
import {retryFixture} from '../test-support/claim-retry.fixture.mjs';
import {pause, watch} from '../test-support/config-reload.fixture.mjs';

function admission(config, root) {
  const flag = path.join(root, 'gate-closed'), script = path.join(root, 'admission.cjs');
  fs.writeFileSync(script, "process.exit(require('node:fs').existsSync(process.argv[2]) ? 7 : 0);\n");
  config.dispatchGate = [process.execPath, script, flag];
  return flag;
}

test('a refused selection makes no API call or lane reservation', async t => {
  const f = await setup(t), flag = admission(f.config, f.root);
  fs.writeFileSync(flag, 'closed'); save(f.configFile, f.config);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Dispatch paused: DISPATCH_GATE_FAILED/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(runDirectories(f.stateDir), []);
  assert.equal(fs.existsSync(f.events), false);
  assert.equal(fs.statSync(path.join(f.stateDir, 'dispatch-gate.log')).mode & 0o777, 0o600);
});

test('a gate refusal after preLaunch prevents the first claim and lane startup', async t => {
  const f = await setup(t), flag = admission(f.config, f.root);
  const cloud = path.join(f.root, 'prepare.cjs'), marker = path.join(f.root, 'lane-started');
  fs.writeFileSync(cloud, `require('node:fs').writeFileSync(${JSON.stringify(flag)}, 'closed');\n`);
  fs.writeFileSync(path.join(f.bins, 'bash'), '#!/bin/sh\n' +
    'if [ "$1" = -c ]; then exec /bin/bash "$@"; fi\n' + `touch '${marker}'\nexit 1\n`, {mode: 0o755});
  f.config.preLaunch = [process.execPath, cloud]; save(f.configFile, f.config);
  assert.equal((await f.run()).code, 0);
  const [dir] = runDirectories(f.stateDir), file = path.join(dir, 'launch.json');
  const result = await execute(worker, [file], f.env), run = read(file);
  assert.equal(result.code, 2, result.stderr);
  assert.match(run.result.error, /^DISPATCH_GATE_FAILED:/);
  assert.equal(reasonCode(completionEvent(run, run.result)), 'DISPATCH_GATE_FAILED');
  assert.equal(run.claimRequest, undefined);
  assert.equal(run.claim, undefined);
  assert.equal(runHoldsTasks(run), false);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
  assert.equal(fs.existsSync(marker), false);
});

test('a gate change during claim reads prevents the mutation', async t => {
  const f = await packageFixture(t), flag = admission(f.run.config, f.root);
  f.batch.beforeFilter = () => fs.writeFileSync(flag, 'closed');
  await assert.rejects(claimTask(f.run, f.persist, f.runId), error => {
    assert.equal(error.code, 'DISPATCH_GATE_FAILED');
    assert.match(startupFailure(f.run, error).error, /^DISPATCH_GATE_FAILED:/);
    return true;
  });
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
  assert.equal(f.run.claimRequest, undefined);
  for (const address of ['task:t1', 'task:t2']) {
    assert.equal(f.objects.get(address).current_revision, 3);
    assert.equal(f.objects.get(address).document.data.assignee, undefined);
  }
});

for (const loss of ['before', 'after']) test(`a refused retry preserves a lost reply ${loss} commit without another mutation`, async t => {
  const f = await retryFixture(t), flag = admission(f.run.config, f.root);
  f.control[loss] = 1;
  const close = () => fs.writeFileSync(flag, 'closed');
  if (loss === 'before') f.control.onDrop = close;
  else f.control.afterCommit = close;
  await assert.rejects(claimTask(f.run, f.persist, f.runId), error => {
    assert.equal(error.code, 'DISPATCH_GATE_FAILED');
    assert.match(startupFailure(f.run, error).error, /^CLAIM_UNCERTAIN: DISPATCH_GATE_FAILED:/);
    return true;
  });
  assert.equal(f.control.requests.length, 1);
  assert.deepEqual(f.run.claimRequest, f.control.requests[0]);
  assert.equal(f.control.mutations, loss === 'after' ? 1 : 0);
  assert.equal(f.run.claimFailures.length, 1);
  assert.equal(f.run.claim, undefined);
  assert.equal(f.run.claimRejected, undefined);
  assert.equal(runHoldsTasks({...f.run, result: {status: 'failed', code: 2}}), true);
});

test('an accepted gate preserves literal argv and the existing claim', async t => {
  const f = await packageFixture(t), record = path.join(f.root, 'gate-argv.json');
  f.run.config.dispatchGate = [process.execPath, '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.slice(1)))`, '$HOME; echo literal', ''];
  await claimTask(f.run, f.persist, f.runId);
  assert.deepEqual(read(record), ['$HOME; echo literal', '']);
  assert.equal(f.run.claim.claimed, true);
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 1);
});

test('invalid optional gate settings fail at config load', async t => {
  const f = await setup(t, {launchLanes: false});
  for (const dispatchGate of ['command', [], [null], ['  '], ['node', '\0']]) {
    save(f.configFile, {...f.config, dispatchGate});
    assert.throws(() => configFrom(f.configFile, f.env), /dispatchGate must be a command argument array/);
  }
  for (const dispatchGateTimeoutSeconds of [0, -1, 1.5, '60', 2147484]) {
    save(f.configFile, {...f.config, dispatchGateTimeoutSeconds});
    assert.throws(() => configFrom(f.configFile, f.env), /dispatchGateTimeoutSeconds/);
  }
});

test('a timed-out gate blocks selection without API calls', async t => {
  const f = await setup(t);
  Object.assign(f.config, {dispatchGate: [process.execPath, '-e', 'setInterval(()=>{},1000)'], dispatchGateTimeoutSeconds: 1});
  save(f.configFile, f.config);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /DISPATCH_GATE_TIMEOUT/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(runDirectories(f.stateDir), []);
});

test('aborting a gate stops its process group before a claim', async t => {
  const f = await packageFixture(t), pids = path.join(f.root, 'gate-pids.json');
  f.run.config.dispatchGate = [process.execPath, '-e', `
const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
require('node:fs').writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);`];
  const controller = new AbortController();
  const pending = runDispatchGate(f.run.config, {signal: controller.signal});
  const rejected = assert.rejects(pending, error => error.code === 'DISPATCH_GATE_ABORTED');
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(pids) && Date.now() < deadline) await pause(20);
  assert.ok(fs.existsSync(pids));
  controller.abort(new Error('Interrupted'));
  await rejected;
  for (let i = 0; i < 100 && read(pids).some(alive); i++) await pause(20);
  assert.ok(read(pids).every(pid => !alive(pid)));
  assert.equal(f.calls.length, 0);
});

test('stopping the dispatcher aborts its selection gate and removes its lock', async t => {
  const f = await setup(t), pid = path.join(f.root, 'selection-gate.pid');
  f.config.dispatchGate = [process.execPath, '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(pid)},String(process.pid));setInterval(()=>{},1000);`];
  save(f.configFile, f.config);
  const run = watch(t, launcher, ['--config', f.configFile], f.env);
  await run.until(() => fs.existsSync(pid));
  assert.equal(await run.stop(), 0, run.output());
  assert.match(run.output(), /DISPATCH_GATE_ABORTED/);
  assert.equal(alive(Number(fs.readFileSync(pid, 'utf8'))), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'dispatcher.lock')), false);
  assert.equal(f.calls.length, 0);
});
