import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {plannerConfig} from '../../planning-joppa/planner-config.mjs';
import {retryFilter} from '../../planning-joppa/retry.mjs';
import {pause, plannerFixture} from '../test-support/config-reload.fixture.mjs';

async function fixture(t, retry) {
  const f = await plannerFixture(t, {retry}, 0,
    '#!/bin/sh\nprintf \'%s %s\\n\' "$5" "$(date +%s)" >> "$TEST_PASSES"\nexit 2\n');
  const workflow = path.join(f.root, 'workflow.yaml');
  fs.writeFileSync(workflow, 'nodes: {}\n');
  Object.assign(f.config, {workflow, selection: {kind: 'ac'}});
  f.objects.delete('ac:a2');
  f.write(f.config);
  return f;
}

function history(f, extra = {}) {
  const artifacts = path.join(f.config.runs_folder, '2026-11-14_10-00-00-done', 'artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify({workspace: 'fixture',
    selected: {address: 'ac:a1', current_revision: 2}}));
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({status: 'blocked', selected_revision: 3,
    ...extra}));
}

test('always retries a confirmed failure at the same revision after the interval', async t => {
  const f = await fixture(t, 'always');
  history(f);
  const run = f.start();
  await run.until(() => f.passes().length >= 2);
  const attempts = f.passes().map(line => line.split(' '));
  assert.deepEqual(attempts.map(row => row[0]), ['ac:a1', 'ac:a1']);
  assert.ok(Number(attempts[1][1]) - Number(attempts[0][1]) >= 1);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
  assert.equal(await run.stop(), 130);
});

test('on_revision waits above the final release revision, including batch members', async t => {
  const f = await fixture(t, 'on_revision');
  history(f, {item_revisions: {'ac:a1': 3}});
  const run = f.start();
  await run.until(() => f.calls.some(call => call.name === 'joppa_objects' && !call.args.address));
  assert.deepEqual(f.passes(), []);
  f.objects.get('ac:a1').current_revision = 3;
  await pause(1200);
  assert.deepEqual(f.passes(), [], 'The claim release does not count as a new input');
  f.objects.get('ac:a1').current_revision = 4;
  await run.until(() => f.passes().length === 1);
  await pause(1200);
  assert.equal(f.passes().length, 1, 'A confirmed failure stays attempted at this revision');
  assert.equal(await run.stop(), 130);
});

test('never excludes a previously attempted address after its revision grows', async t => {
  const f = await fixture(t, 'never');
  history(f);
  f.objects.get('ac:a1').current_revision = 10;
  const run = f.start();
  await run.until(() => f.calls.some(call => call.name === 'joppa_objects' && !call.args.address));
  await pause(1200);
  assert.deepEqual(f.passes(), []);
  assert.equal(await run.stop(), 130);
});

test('always retains the recovery hold for an uncertain mutation', async t => {
  const f = await fixture(t, 'always');
  history(f, {needs_recovery: true});
  const run = f.start();
  await run.until(output => /RECOVERY_REQUIRED/.test(output));
  await pause(1200);
  assert.deepEqual(f.passes(), []);
  assert.equal(await run.stop(), 130);
});

test('retry values validate at config load before any selection', async t => {
  const f = await fixture(t, 'on_revision');
  for (const retry of [null, true, 'sometimes', 1]) {
    assert.throws(() => plannerConfig(f.configFile, {}, Buffer.from(JSON.stringify({...f.config, retry}))),
      /retry must be always, on_revision or never/);
  }
  for (const retry_by_reason of [null, [], 'never', {WAIT: 'later'}, {' WAIT': 'never'}, {'': 'always'}]) {
    assert.throws(() => plannerConfig(f.configFile, {}, Buffer.from(JSON.stringify({...f.config, retry_by_reason}))),
      /retry_by_reason must map reason codes/);
  }
});

test('a configured refusal waits for a new selected revision across dispatcher restarts', async t => {
  const f = await fixture(t, 'always');
  f.config.retry_by_reason = {TASK_PREREQUISITE: 'on_revision'};
  f.write(f.config);
  history(f, {reason_code: 'TASK_PREREQUISITE'});
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = f.start();
    await run.until(output => /TASK_PREREQUISITE/.test(output));
    await pause(1200);
    assert.deepEqual(f.passes(), []);
    if (attempt === 1) {
      f.objects.get('ac:a1').current_revision = 4;
      await run.until(() => f.passes().length === 1);
    }
    assert.equal(await run.stop(), 130);
  }
});

test('reason policies follow final batch revisions and the latest completed outcome', () => {
  const key = revision => JSON.stringify(['work:a', revision]);
  const config = {retry: 'always', retry_by_reason: {WAIT: 'on_revision', STOP: 'never'}};
  const row = (revision, reasonCode, end, extra = {}) => ({attemptKeys: [key(revision)], reasonCode, end, ...extra});
  const wait = row(3, 'WAIT', '2026-11-25T01:00:00Z');
  const ordinary = row(3, 'FAIL', '2026-11-25T02:00:00Z');
  const skipped = (rows, revision = 3, attempted = [], cooldowns = new Map()) =>
    retryFilter(config, rows, new Set(attempted), cooldowns)({address: 'work:a', revision});
  assert.equal(skipped([wait]), true);
  assert.equal(skipped([wait], 4), false);
  assert.equal(skipped([ordinary, wait]), false);
  assert.equal(skipped([wait, ordinary]), false);
  assert.equal(skipped([row(2, 'FAIL', '2026-11-25T03:00:00Z'), wait]), true);
  assert.equal(skipped([wait, {...ordinary, active: true}]), true);
  assert.equal(skipped([wait], 4, [key(4)]), true);
  assert.equal(skipped([row(3, 'STOP')], 4), true);
  assert.equal(skipped([ordinary], 3, [], new Map([['work:a', Date.now() + 60000]])), true);
  assert.equal(skipped([], 3), false);
});
