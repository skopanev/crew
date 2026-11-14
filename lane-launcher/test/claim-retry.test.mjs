import test from 'node:test';
import assert from 'node:assert/strict';
import {save} from '../runtime.mjs';
import {configFrom} from '../launcher-config.mjs';
import {claimTask, runHoldsTasks} from '../joppa.mjs';
import {retryFixture} from '../test-support/claim-retry.fixture.mjs';
import {setup} from '../test-support/launcher.fixture.mjs';

test('claim retry delays come only from a validated config', async t => {
  const f = await setup(t, {launchLanes: false});
  for (const delays of [[], [5, 15, 35]]) {
    save(f.configFile, {...f.config, joppa: {...f.config.joppa, claimRetryDelaysSeconds: delays}});
    assert.deepEqual(configFrom(f.configFile, f.env).joppa.claimRetryDelaysSeconds, delays);
  }
  for (const delays of [null, 5, [0], [-1], [0.5], ['5'], [2_147_484]]) {
    save(f.configFile, {...f.config, joppa: {...f.config.joppa, claimRetryDelaysSeconds: delays}});
    assert.throws(() => configFrom(f.configFile, f.env), /claimRetryDelaysSeconds/);
  }
});

for (const loss of ['before', 'after']) test(`a lost reply ${loss} commit replays one exact claim and confirms its assignee`, async t => {
  const f = await retryFixture(t);
  f.control[loss] = 1;
  const lines = [];
  await claimTask(f.run, f.persist, f.runId, {announce: line => lines.push(line)});
  assert.equal(f.control.requests.length, 2);
  assert.deepEqual(f.control.requests[0], f.control.requests[1]);
  assert.equal(f.control.mutations, 1);
  assert.equal(f.run.claim.claimed, true);
  assert.equal(f.objects.get('task:t1').document.data.assignee, f.run.claim.assignee);
  assert.equal(f.objects.get('task:t1').current_revision, 4);
  assert.equal(f.run.claimFailures.length, 1);
  assert.equal(f.run.claimFailures[0].name, 'JoppaTransportError');
  assert.match(lines[0], /CLAIM_RETRY 1 of 1 in 1s/);
});

test('a replay waits for the first request still in flight and applies one mutation', async t => {
  const f = await retryFixture(t);
  f.control.overlap = true;
  await claimTask(f.run, f.persist, f.runId);
  assert.equal(f.control.overlapped, true);
  assert.equal(f.control.mutations, 1);
  assert.deepEqual(f.control.requests[0], f.control.requests[1]);
  assert.equal(f.run.claim.claimed, true);
});

test('exhaustion and omitted retries preserve an uncertain reservation', async t => {
  for (const delays of [[], [1]]) {
    const f = await retryFixture(t, delays);
    if (!delays.length) delete f.run.config.joppa.claimRetryDelaysSeconds;
    f.control.before = 3;
    await assert.rejects(claimTask(f.run, f.persist, f.runId), /Joppa MCP transport failed/);
    assert.equal(f.control.requests.length, delays.length + 1);
    assert.equal(f.run.claimFailures.length, delays.length + 1);
    assert.equal(runHoldsTasks({...f.run, result: {status: 'failed', code: 2}}), true);
  }
});

test('a successful receipt does not override a changed live Task revision', async t => {
  const f = await retryFixture(t);
  f.control.afterCommit = () => f.objects.get('task:t1').current_revision++;
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /at the claimed revision/);
  assert.equal(f.run.claim, undefined);
  assert.equal(runHoldsTasks({...f.run, result: {status: 'failed', code: 2}}), true);
});

test('application refusals, malformed receipts and maintenance RPC errors never retry', async t => {
  for (const mode of ['reject', 'invalid', 'rpc']) {
    const f = await retryFixture(t);
    if (mode === 'rpc') f.control.rpcCode = -32000;
    else f.control[mode] = true;
    await assert.rejects(claimTask(f.run, f.persist, f.runId), /Application refused|batch response is incomplete|rejected the MCP operation/);
    assert.equal(f.control.requests.length, 1);
    assert.equal(f.run.claimFailures.length, 1);
    assert.equal(Boolean(f.run.claimRejected), mode === 'reject');
    if (mode === 'rpc') assert.equal(f.run.claimFailures[0].rpcCode, -32000);
  }
});

test('a refusal after ambiguity releases only a confirmed unowned claim', async t => {
  for (const applied of [false, true]) {
    const f = await retryFixture(t);
    if (applied) { f.control.after = 1; f.control.refuseReplay = true; }
    else {
      f.control.before = 1;
      f.control.onDrop = () => f.objects.get('task:t1').current_revision++;
    }
    await assert.rejects(claimTask(f.run, f.persist, f.runId), /unconfirmed after a transport failure|revision changed/);
    assert.equal(Boolean(f.run.claimRejected), !applied);
    assert.equal(runHoldsTasks({...f.run, result: {status: 'failed', code: 2}}), applied);
  }
});

test('abort during RPC or backoff sends no later claim and keeps uncertainty', async t => {
  for (const phase of ['rpc', 'backoff']) {
    const f = await retryFixture(t, [35]);
    const controller = new AbortController(), reason = new Error('Startup interrupted by SIGINT');
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    if (phase === 'rpc') { f.control.hang = true; f.control.entered = entered; }
    else f.control.before = 1;
    const pending = claimTask(f.run, f.persist, f.runId, {signal: controller.signal, announce: entered});
    await ready;
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.equal(f.control.requests.length, 1);
    assert.equal(runHoldsTasks({...f.run, result: {status: 'failed', code: 2}}), true);
  }
});
