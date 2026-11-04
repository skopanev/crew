// The planner dispatcher reloads its config only between passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pause, plannerFixture} from '../test-support/config-reload.fixture.mjs';

const count = (text, pattern) => (text.match(pattern) || []).length;

test('planner picks up new ac_ids between passes and stays quiet while the config is unchanged', async t => {
  const f = await plannerFixture(t, {ac_ids: ['ac:missing']});
  const run = f.start();
  await run.until(output => count(output, /Requirements: 0 ready/g) >= 3);
  assert.doesNotMatch(run.output(), /config reloaded/);
  assert.deepEqual(f.passes(), []);
  const mark = run.mark();
  f.write({...f.config, ac_ids: ['ac:a1']});
  await run.until(() => f.passes().includes('end'));
  assert.match(run.since(mark), /config reloaded · Planning req:r · Requirement/);
  assert.match(f.passes()[0], /"ac:a1"/);
  const quiet = run.mark();
  await run.until(output => count(output.slice(quiet), /Requirements: 1 ready · no unattempted/g) >= 2);
  assert.doesNotMatch(run.since(quiet), /config reloaded/);
  assert.equal(await run.stop(), 130);
});

test('invalid planner config shows CONFIG_INVALID, starts nothing and recovers when fixed', async t => {
  const f = await plannerFixture(t, {ac_ids: ['ac:a1']});
  const run = f.start();
  await run.until(() => f.passes().includes('end'));
  await run.until(output => /no unattempted/.test(output));
  f.write('{"workspace": "fixture", "secret-value-in-broken-file": ');
  await run.until(output => /CONFIG_INVALID: the file is not valid JSON/.test(output));
  const calls = f.calls.length, mark = run.mark();
  await pause(2200);
  assert.ok(count(run.since(mark), /CONFIG_INVALID/g) >= 1);
  assert.equal(f.calls.length, calls, 'An invalid config must not read the queue');
  assert.equal(f.passes().length, 2);
  assert.doesNotMatch(run.output(), /secret-value-in-broken-file/);
  f.write({...f.config, ac_ids: ['ac:a1'], interval_seconds: 'soon'});
  await run.until(output => /CONFIG_INVALID: interval_seconds must be 1 to 3600/.test(output));
  const fixed = run.mark();
  f.write({...f.config, ac_ids: ['ac:a1', 'ac:a2']});
  await run.until(() => f.passes().length === 4);
  assert.match(run.since(fixed), /config reloaded · Planning req:r/);
  assert.match(f.passes()[2], /"ac:a2"/);
  assert.equal(await run.stop(), 130);
});

test('locked planner identity changes show CONFIG_RESTART_REQUIRED and start nothing', async t => {
  const f = await plannerFixture(t, {ac_ids: ['ac:missing']});
  const run = f.start();
  await run.until(output => /Requirements: 0 ready/.test(output));
  for (const change of [{workspace: 'other'}, {runs_folder: path.join(f.root, 'other-runs')},
    {url: 'http://127.0.0.1:1/mcp'}, {mcp_command: ['node', 'broker.cjs']}]) {
    const mark = run.mark();
    // The new criterion is ready, but the locked change must hold every start.
    f.write({...f.config, ac_ids: ['ac:a1'], ...change});
    await run.until(output => /CONFIG_RESTART_REQUIRED/.test(output.slice(mark)));
    const calls = f.calls.length;
    await pause(1500);
    assert.equal(f.calls.length, calls, `${Object.keys(change)} must not read the queue`);
    assert.deepEqual(f.passes(), []);
    const back = run.mark();
    f.write(f.config);
    await run.until(output => /config reloaded · Requirements: 0 ready/.test(output.slice(back)));
  }
  assert.equal(await run.stop(), 130);
});

test('a planner pass keeps its config; the dispatcher reloads only after the pass', async t => {
  const f = await plannerFixture(t, {ac_ids: ['ac:a1']}, 2);
  const run = f.start();
  await run.until(() => f.passes().length === 1);
  const mark = run.mark();
  f.write({...f.config, ac_ids: ['ac:a1', 'ac:a2']});
  await pause(800);
  assert.doesNotMatch(run.since(mark), /config reloaded/, 'No reload during an active pass');
  await run.until(output => /config reloaded/.test(output.slice(mark)));
  assert.equal(f.passes()[1], 'end', 'The reload waits for the active pass to end');
  assert.doesNotMatch(f.passes()[0], /"ac:a2"/);
  await run.until(() => f.passes().length === 3);
  assert.match(f.passes()[2], /"ac:a2"/);
  assert.equal(await run.stop(), 130);
});
