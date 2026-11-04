// The Dolber reloads its config only at a selection boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {save, read, runDirectories} from '../runtime.mjs';
import {launcher, queueReads, setup} from '../test-support/launcher.fixture.mjs';
import {pause, watch} from '../test-support/config-reload.fixture.mjs';

const count = (text, pattern) => (text.match(pattern) || []).length;
async function dolber(t, options, values = {}) {
  const f = await setup(t, options);
  f.config = {...f.config, intervalSeconds: 1, ...values};
  save(f.configFile, f.config);
  return {f, run: watch(t, launcher, ['--config', f.configFile], {...f.env, NO_COLOR: '1'})};
}

test('Dolber uses a changed config at the next selection and stays quiet while it is unchanged', async t => {
  const {f, run} = await dolber(t, {launchLanes: false});
  await run.until(output => count(output, /project=project:app\]/g) >= 2);
  assert.doesNotMatch(run.output(), /config reloaded/);
  const mark = run.mark();
  save(f.configFile, {...f.config, joppa: {...f.config.joppa, project: 'project:other'}});
  await run.until(output => count(output.slice(mark), /project=project:other\]/g) >= 3);
  assert.equal(count(run.since(mark), /config reloaded/g), 1);
  assert.match(run.since(mark), /config reloaded\n[─]+\nRunning lanes/);
  assert.equal(await run.stop(), 0);
});

test('invalid Dolber config shows CONFIG_INVALID, reads no queue and recovers when fixed', async t => {
  const {f, run} = await dolber(t, {launchLanes: false});
  await run.until(output => /preview: запуск отключён/.test(output));
  fs.writeFileSync(f.configFile, '{"id": "test-project", "tokenFile": "secret-value-in-broken-file"');
  await run.until(output => /CONFIG_INVALID: the file is not valid JSON/.test(output));
  const reads = queueReads(f);
  await pause(2200);
  assert.equal(queueReads(f), reads, 'An invalid config must not read the queue');
  assert.doesNotMatch(run.output(), /secret-value-in-broken-file/);
  save(f.configFile, {...f.config, limit: 0});
  await run.until(output => /CONFIG_INVALID: limit must be a positive integer/.test(output));
  const mark = run.mark();
  save(f.configFile, f.config);
  await run.until(output => /config reloaded[^]*preview: запуск отключён/.test(output.slice(mark)));
  assert.ok(queueReads(f) > reads);
  assert.equal(await run.stop(), 0);
});

test('locked Dolber identity changes show CONFIG_RESTART_REQUIRED and start nothing', async t => {
  const {f, run} = await dolber(t, {launchLanes: false});
  await run.until(output => /preview: запуск отключён/.test(output));
  for (const change of [{id: 'other-project'}, {workspace: 'other'}, {stateDir: path.join(f.root, 'other-state')},
    {joppa: {...f.config.joppa, url: 'http://127.0.0.1:1/mcp'}}]) {
    const mark = run.mark();
    save(f.configFile, {...f.config, ...change});
    await run.until(output => /CONFIG_RESTART_REQUIRED/.test(output.slice(mark)));
    const reads = queueReads(f);
    await pause(1500);
    assert.equal(queueReads(f), reads, `${Object.keys(change)} must not read the queue`);
    const back = run.mark();
    save(f.configFile, f.config);
    await run.until(output => /config reloaded[^]*preview: запуск отключён/.test(output.slice(back)));
  }
  assert.ok(fs.existsSync(path.join(f.stateDir, 'dispatcher.lock')), 'The lock stays with the original state root');
  assert.ok(!fs.existsSync(path.join(f.root, 'other-state')));
  assert.equal(await run.stop(), 0);
});

test('a running lane keeps its launch config after a reload', async t => {
  const {f, run} = await dolber(t, {});
  await run.until(output => /started task:/.test(output));
  const [dir] = runDirectories(f.stateDir);
  const before = read(path.join(dir, 'launch.json')).config;
  assert.equal(before.gateTimeoutSeconds, 900);
  const mark = run.mark();
  save(f.configFile, {...f.config, gateTimeoutSeconds: 901});
  await run.until(output => /config reloaded[^]*Running lanes 1 of 1/.test(output.slice(mark)));
  assert.deepEqual(read(path.join(dir, 'launch.json')).config, before);
  assert.equal(runDirectories(f.stateDir).length, 1);
  assert.equal(await run.stop(), 0);
});
