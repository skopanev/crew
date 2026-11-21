import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {configFrom, activeCount} from '../launcher.mjs';
import {save, read, alive, runDirectories} from '../runtime.mjs';
import {setup} from '../test-support/launcher.fixture.mjs';
import {watch, pause} from '../test-support/config-reload.fixture.mjs';
import {launcher} from '../test-support/launcher.fixture.mjs';

async function until(check) {
  const end = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Headless worker did not reach the expected state');
    await pause(30);
  }
}

function fakeLane(f, seconds = 0) {
  fs.writeFileSync(path.join(f.bins, 'bash'), '#!/bin/sh\n' +
    'if [ "$1" = -c ]; then exec /bin/bash "$@"; fi\n' +
    `printf 'headless stdout\\n'\nprintf 'headless stderr\\n' >&2\nsleep ${seconds}\nexit 2\n`, {mode: 0o755});
}

test('headless starts the real worker without Herdr and writes each stream once', async t => {
  const f = await setup(t);
  fakeLane(f);
  const config = {...f.config, lanes: 'headless', closeTabOnExit: true};
  delete config.herdrWorkspace;
  delete f.env.HERDR_WORKSPACE_ID;
  fs.rmSync(config.herdr);
  save(f.configFile, config);
  assert.equal(configFrom(f.configFile, f.env).lanes, 'headless');
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const [dir] = runDirectories(f.stateDir), file = path.join(dir, 'launch.json');
  await until(() => read(file).result);
  const run = read(file), log = fs.readFileSync(path.join(dir, 'output.log'), 'utf8');
  assert.equal(run.pane, undefined);
  assert.equal(run.claim.claimed, true);
  assert.equal(run.result.blockConfirmed, true);
  assert.match(log, /\[lane\] START task:t1 · headless/);
  for (const stream of ['stdout', 'stderr']) assert.equal(log.split(`headless ${stream}`).length - 1, 1);
  assert.equal(fs.existsSync(f.events), false);
  assert.equal(activeCount(configFrom(f.configFile, f.env), [], null), 0);
});

test('a mode reload preserves the existing tab and the headless worker survives dispatcher exit', async t => {
  const f = await setup(t);
  fakeLane(f, 3);
  save(f.configFile, {...f.config, limit: 2, intervalSeconds: 1});
  const dispatcher = watch(t, launcher, ['--config', f.configFile], f.env);
  await dispatcher.until(output => /started task:t1 in test-pane/.test(output));
  const [oldDir] = runDirectories(f.stateDir), oldFile = path.join(oldDir, 'launch.json');
  const old = read(oldFile);
  save(f.configFile, {...f.config, limit: 2, intervalSeconds: 1, lanes: 'headless'});
  await dispatcher.until(output => /headless mode/.test(output));
  const newDir = runDirectories(f.stateDir).find(dir => dir !== oldDir), file = path.join(newDir, 'launch.json');
  await until(() => read(file).launchPgid);
  const worker = read(file).worker;
  t.after(() => { if (alive(worker.pid)) process.kill(worker.pid, 'SIGTERM'); });
  assert.deepEqual(read(oldFile), old);
  assert.equal(read(file).config.lanes, 'headless');
  assert.equal(activeCount(configFrom(f.configFile, f.env), [], null), 2);
  assert.equal(await dispatcher.stop(), 0);
  assert.equal(alive(worker.pid), true, 'The lane is independent of the dispatcher');
  await until(() => read(file).result);
  const events = fs.readFileSync(f.events, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(args => args[0] === 'tab' && args[1] === 'create').length, 1);
  assert.equal(events.some(args => args[1] === 'close'), false);
});

test('preview stays disabled in headless mode and invalid lane modes fail before selection', async t => {
  const f = await setup(t, {launchLanes: false});
  save(f.configFile, {...f.config, lanes: 'headless'});
  assert.equal((await f.run()).code, 0);
  assert.deepEqual(runDirectories(f.stateDir), []);
  assert.equal(fs.existsSync(f.events), false);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
  save(f.configFile, {...f.config, lanes: 'unknown'});
  assert.throws(() => configFrom(f.configFile, f.env), /lanes must be herdr or headless/);
});
