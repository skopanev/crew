import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {configFrom} from '../launcher-config.mjs';
import {read, save, alive, runDirectories} from '../runtime.mjs';
import {reasonCode, completionEvent} from '../../notify.mjs';
import {setup, worker, execute} from '../test-support/launcher.fixture.mjs';
import {pause} from '../test-support/config-reload.fixture.mjs';

async function fixture(t, command, timeout = 60) {
  const f = await setup(t), marker = path.join(f.root, 'lane-started');
  const script = path.join(f.root, 'host-hook.cjs');
  fs.writeFileSync(script, command);
  fs.writeFileSync(path.join(f.bins, 'bash'), '#!/bin/sh\n' +
    'if [ "$1" = -c ]; then exec /bin/bash "$@"; fi\n' +
    `touch '${marker}'\nexit 1\n`, {mode: 0o755});
  f.config.preLaunch = [process.execPath, script, '$HOME; echo literal'];
  f.config.preLaunchTimeoutSeconds = timeout;
  save(f.configFile, f.config);
  assert.equal((await f.run()).code, 0);
  const [dir] = runDirectories(f.stateDir);
  return {...f, dir, file: path.join(dir, 'launch.json'), marker};
}

test('the host hook receives its scope before claim and permits the unchanged worker path', async t => {
  const f = await fixture(t, `const fs=require('node:fs'),path=require('node:path');
const run=JSON.parse(fs.readFileSync(path.join(process.env.CREW_RUN_DIR,'launch.json')));
if(run.claimRequest || run.claim) throw new Error('Task was already claimed');
fs.writeFileSync(path.join(process.env.CREW_RUN_DIR,'hook-env.json'),JSON.stringify({
 id:process.env.CREW_DISPATCHER_ID,dir:process.env.CREW_RUN_DIR,cwd:process.cwd(),arg:process.argv[2]}));
console.log('hook stdout'); console.error('hook stderr');
`);
  const result = await execute(worker, [f.file], f.env);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(fs.existsSync(f.marker), true);
  const env = read(path.join(f.dir, 'hook-env.json'));
  assert.deepEqual(env, {id: f.config.id, dir: f.dir, cwd: f.dir, arg: '$HOME; echo literal'});
  const log = fs.readFileSync(path.join(f.dir, 'pre-launch.log'), 'utf8');
  assert.match(log, /hook stdout/); assert.match(log, /hook stderr/);
  assert.equal(fs.statSync(path.join(f.dir, 'pre-launch.log')).mode & 0o777, 0o600);
  assert.equal(read(f.file).claim.claimed, true);
});

for (const [name, command, expected, timeout] of [
  ['nonzero exit', "console.error('cleanup refused'); process.exit(7);", 'PRE_LAUNCH_FAILED', 60],
  ['timeout', 'setInterval(()=>{},1000);', 'PRE_LAUNCH_TIMEOUT', 1],
]) test(`a hook ${name} prevents claim and lane startup and supplies the dashboard reason`, async t => {
  const f = await fixture(t, command, timeout);
  const result = await execute(worker, [f.file], f.env), run = read(f.file);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(run.claimRequest, undefined);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
  assert.equal(reasonCode(completionEvent(run, run.result)), expected);
  assert.equal(run.result.held, undefined);
  assert.equal(run.result.blocked, undefined);
  if (timeout === 60) {
    assert.match(run.result.error, /exited 7/);
    assert.match(fs.readFileSync(path.join(f.dir, 'pre-launch.log'), 'utf8'), /cleanup refused/);
  }
});

test('interrupting the worker kills the hook process group before any claim', async t => {
  const f = await fixture(t, `const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(path.join(process.env.CREW_RUN_DIR,'hook-pids.json'),JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [worker, f.file], {env: f.env, stdio: 'ignore'});
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const exit = new Promise(resolve => child.once('close', resolve));
  const pidFile = path.join(f.dir, 'hook-pids.json'), deadline = Date.now() + 5000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await pause(20);
  assert.ok(fs.existsSync(pidFile));
  child.kill('SIGTERM');
  assert.equal(await exit, 2);
  const pids = read(pidFile);
  for (let i = 0; i < 100 && pids.some(alive); i++) await pause(20);
  assert.ok(pids.every(pid => !alive(pid)), 'The hook and its child must stop');
  const run = read(f.file);
  assert.equal(reasonCode(completionEvent(run, run.result)), 'PRE_LAUNCH_ABORTED');
  assert.equal(run.claimRequest, undefined);
  assert.equal(fs.existsSync(f.marker), false);
});

test('invalid hook settings fail at config load and preview executes no hook', async t => {
  const f = await setup(t, {launchLanes: false});
  for (const preLaunch of ['command', [], [null], [''], ['node', '\0']]) {
    save(f.configFile, {...f.config, preLaunch});
    assert.throws(() => configFrom(f.configFile, f.env), /preLaunch must be a command argument array/);
  }
  for (const preLaunchTimeoutSeconds of [0, -1, 1.5, '60', 2147484]) {
    save(f.configFile, {...f.config, preLaunchTimeoutSeconds});
    assert.throws(() => configFrom(f.configFile, f.env), /preLaunchTimeoutSeconds/);
  }
  save(f.configFile, {...f.config, preLaunch: [process.execPath, '-e', 'process.exit(7)']});
  assert.equal((await f.run()).code, 0);
  assert.deepEqual(runDirectories(f.stateDir), []);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});
