// The planner dispatcher reloads its config only between passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configReloader} from '../config-reload.mjs';
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
  await run.until(output => /Requirements: 1 ready · no unattempted/.test(output.slice(mark)));
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

test('an edit between the initial load and the reloader start is a change, not a cached baseline', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-reload-'));
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  const file = path.join(folder, 'config.json'), parse = raw => JSON.parse(raw.toString('utf8'));
  fs.writeFileSync(file, '{"workspace": "w", "ac_ids": ["ac:a1"]}');
  const bytes = fs.readFileSync(file), initial = parse(bytes);
  fs.writeFileSync(file, '{"workspace": "w", "ac_ids": ["ac:a1", "ac:a2"]}');
  const reload = configReloader(file, parse, config => config.workspace, initial, bytes);
  const first = reload();
  assert.equal(first.reloaded, true);
  assert.deepEqual(first.config.ac_ids, ['ac:a1', 'ac:a2']);
  assert.equal(reload().reloaded, false);
});

test('a config edited between selection and spawn makes no claim, starts no Medulla and the item starts once later', async t => {
  // The first pass replaces the selected file before the real run.sh and launch.py read it. Later passes only record.
  const pass = '#!/bin/sh\nif [ ! -e "$TEST_REPLACED" ]; then touch "$TEST_REPLACED"\n' +
    'printf \'%s\' "$TEST_REPLACEMENT" > "$3"\nexec /bin/sh "$@"\nfi\nprintf \'start %s\\n\' "$5" >> "$TEST_PASSES"\n';
  const f = await plannerFixture(t, {ac_ids: ['ac:a1']}, 0, pass);
  const medulla = path.join(f.root, 'medulla'), started = path.join(f.root, 'medulla-started');
  fs.writeFileSync(medulla, `#!/bin/sh\ntouch '${started}'\n`, {mode: 0o755});
  Object.assign(f.env, {MEDULLA_BIN: medulla, TEST_REPLACED: path.join(f.root, 'replaced'),
    TEST_REPLACEMENT: JSON.stringify({...f.config, ac_ids: ['ac:a1'], workspace: 'other'})});
  const run = f.start();
  await run.until(output => /planner config changed after the dispatcher selected this pass/.test(output));
  await run.until(output => /CONFIG_RESTART_REQUIRED/.test(output));
  assert.ok(!fs.existsSync(started), 'Medulla must not start for the replacement config');
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 0, 'No claim was made');
  assert.deepEqual(f.passes(), []);
  const mark = run.mark();
  f.write(f.config);
  await run.until(() => f.passes().length === 1);
  await run.until(output => count(output.slice(mark), /Requirements: 1 ready · no unattempted/g) >= 3);
  assert.deepEqual(f.passes(), ['start req:r'], 'The same item starts exactly once after the restore');
  assert.equal(await run.stop(), 130);
});

test('a genuine pass failure stays attempted', async t => {
  const pass = '#!/bin/sh\nprintf \'start %s\\n\' "$5" >> "$TEST_PASSES"\nexit 2\n';
  const f = await plannerFixture(t, {ac_ids: ['ac:a1']}, 0, pass);
  const run = f.start();
  await run.until(() => f.passes().length === 1);
  await run.until(output => count(output, /Requirements: 1 ready · no unattempted/g) >= 3);
  assert.deepEqual(f.passes(), ['start req:r']);
  assert.equal(await run.stop(), 130);
});
