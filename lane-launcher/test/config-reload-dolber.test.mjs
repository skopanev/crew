// The Dolber reloads its config only at a selection boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {save, read, runDirectories} from '../runtime.mjs';
import {launcher, queueReads, setup} from '../test-support/launcher.fixture.mjs';
import {pause, watch} from '../test-support/config-reload.fixture.mjs';
import {configFrom} from '../launcher-config.mjs';
import {laneOptionsEnv} from '../lane-options.mjs';

const count = (text, pattern) => (text.match(pattern) || []).length;

test('lane options accept an optional scout and explicit reviewers without changing panel arguments', async t => {
  const f = await setup(t), reviewers = [{harness: 'codex', model: 'configured-model', flag: '--configured-flag'},
    {harness: 'claude-code', model: 'other-model', slug: 'quality', effort: 'medium'}];
  const raw = {...f.config, scout: false, reviewers,
    context: {...f.config.context, roles: {...f.config.context.roles}}};
  delete raw.context.roles.scout;
  save(f.configFile, raw);
  const config = configFrom(f.configFile, f.env);
  const env = laneOptionsEnv(config), inputs = JSON.parse(env.LANE_REVIEWERS_JSON);
  assert.equal(env.LANE_SCOUT, 'false');
  assert.equal(inputs[0].model, reviewers[0].model);
  assert.equal(inputs[0].flag, reviewers[0].flag);
  assert.equal(inputs[0].slug, 'reviewer-1');
  assert.equal(inputs[1].slug, 'quality');
  assert.equal(inputs[1].effort, 'medium');
  assert.deepEqual(laneOptionsEnv({}), {LANE_SCOUT: 'true', LANE_REVIEWERS_JSON: ''});
  for (const change of [{scout: 'false'}, {reviewers: []}, {reviewers: [{harness: 'codex'}]},
    {reviewers: reviewers.map(seat => ({...seat, slug: 'same'}))},
    {reviewers: [{...reviewers[0], slug: '../outside'}]}]) {
    save(f.configFile, {...raw, ...change});
    assert.throws(() => configFrom(f.configFile, f.env), /scout|reviewer/i);
  }
});

async function dolber(t, options, values = {}) {
  const f = await setup(t, options);
  f.config = {...f.config, intervalSeconds: 1, ...values};
  save(f.configFile, f.config);
  return {f, run: watch(t, launcher, ['--config', f.configFile], {...f.env, NO_COLOR: '1'})};
}

test('Dolber uses a changed config at the next selection and stays quiet while it is unchanged', async t => {
  const {f, run} = await dolber(t, {launchLanes: false});
  await run.until(output => count(output, /repositories=app\]/g) >= 2);
  assert.doesNotMatch(run.output(), /config reloaded/);
  const mark = run.mark();
  save(f.configFile, {...f.config, repositories: f.config.repositories.map(repo => ({...repo, id: 'other'}))});
  await run.until(output => count(output.slice(mark), /repositories=other\]/g) >= 3);
  assert.equal(count(run.since(mark), /config reloaded/g), 1);
  assert.match(run.since(mark), /config reloaded\n[─]+\nRunning lanes/);
  assert.equal(await run.stop(), 0);
});

test('invalid Dolber config shows CONFIG_INVALID, reads no queue and recovers when fixed', async t => {
  const {f, run} = await dolber(t, {launchLanes: false});
  await run.until(output => /preview: запуск отключён/.test(output));
  fs.writeFileSync(`${f.configFile}.next`, '{"id": "test-project", "tokenFile": "secret-value-in-broken-file"');
  fs.renameSync(`${f.configFile}.next`, f.configFile);
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
