import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {plannerFixture, planner, watch, pause} from '../test-support/config-reload.fixture.mjs';
import {plannerRows} from '../../planning-joppa/run-rows.mjs';
import {read, alive} from '../runtime.mjs';
import {detachedRuns, dispatcherId, stopDetachedRun} from '../../planning-joppa/detached-runs.mjs';
import {plannerConfig, plannerIdentity} from '../../planning-joppa/planner-config.mjs';

async function fixture(t, values = {}) {
  let cleanup = async () => {};
  t.after(() => cleanup());
  const f = await plannerFixture(t, {execution: 'detached', ...values}, 0,
    '#!/bin/sh\nexec "$TEST_NODE" "$TEST_PASS" "$3" "$5"\n');
  const workflow = path.join(f.root, 'workflow.yaml'), pass = path.join(f.root, 'pass.cjs');
  fs.writeFileSync(workflow, 'nodes: {}\n');
  Object.assign(f.config, {workflow, selection: {kind: 'ac'}, vars: {VERSION: 'first'}});
  f.write(f.config);
  fs.writeFileSync(pass, `const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const configFile=process.argv[2], address=process.argv[3], config=JSON.parse(fs.readFileSync(configFile));
const folder=path.join(config.runs_folder,'2026-11-21_10-00-00-'+randomUUID());
fs.mkdirSync(path.join(folder,'artifacts'),{recursive:true});
fs.writeFileSync(path.join(folder,'.lock'),String(process.pid));
fs.writeFileSync(path.join(folder,'artifacts/input.json'),JSON.stringify({workspace:'fixture',
  selected:{address,current_revision:2,document:{data:{title:address}}}}));
console.log(folder);
fs.appendFileSync(process.env.TEST_PASSES,JSON.stringify({address,folder,version:config.vars.VERSION,pid:process.pid})+'\\n');
const finish=()=>{
  const version=JSON.parse(fs.readFileSync(configFile)).vars.VERSION;
  fs.writeFileSync(path.join(folder,'artifacts/result.json'),JSON.stringify({status:'published',selected_revision:3,version}));
  process.exit(0);
};
process.on('SIGTERM',finish);
setInterval(()=>{if(fs.existsSync(path.join(process.env.TEST_RELEASE,address)))finish();},30);
`);
  const release = path.join(f.root, 'release'); fs.mkdirSync(release);
  Object.assign(f.env, {TEST_NODE: process.execPath, TEST_PASS: pass, TEST_RELEASE: release});
  const owner = dispatcherId(plannerIdentity(plannerConfig(f.configFile)));
  const runs = () => detachedRuns(f.config.runs_folder, owner);
  cleanup = async () => {
    for (const run of runs().filter(run => run.active)) {
      try { stopDetachedRun(f.config.runs_folder, owner, path.basename(run.folder)); } catch {}
    }
    for (let i = 0; i < 100 && runs().some(run => run.active); i++) await pause(30);
  };
  return {...f, owner, runs, release: address => fs.writeFileSync(path.join(release, address), '')};
}

test('detached passes survive dispatcher restart, keep capacity, and reload config without changing live snapshots', async t => {
  const f = await fixture(t), first = f.start();
  await first.until(() => f.passes().length === 1);
  const before = f.runs()[0];
  assert.equal(before.active, true);
  assert.equal(before.input, 0, 'The launch record retains the selected profile before prepare');
  const row = plannerRows(f.config.runs_folder).find(row => row.active);
  assert.equal(row.ac, 'ac:a1');
  assert.equal(plannerRows(f.config.runs_folder).filter(row => row.active).length, 1,
    'The worker and its Medulla run occupy one slot');
  assert.equal(await first.stop(), 130);
  assert.equal(alive(before.pid), true);
  const second = f.start();
  await second.until(output => /1 running · concurrency 1/.test(output));
  await pause(1100);
  assert.equal(f.passes().length, 1, 'The existing pass occupies the only slot after restart');
  f.write({...f.config, concurrency: 2, vars: {VERSION: 'second'}});
  await second.until(() => f.passes().length === 2);
  assert.deepEqual(f.passes().map(line => JSON.parse(line).version), ['first', 'second']);
  assert.equal(f.runs().filter(run => run.active).length, 2);
  const stop = watch(t, planner, ['--config', f.configFile, '--stop-run', path.basename(before.folder)], f.env);
  await stop.until(output => /Stopping/.test(output));
  await second.until(() => f.runs().find(run => run.file === before.file)?.result);
  const completed = read(path.join(before.folder, 'launch.json'));
  assert.equal(read(path.join(completed.medullaRun, 'artifacts/result.json')).version, 'first');
  assert.equal(f.runs().filter(run => run.active).length, 1);
  assert.equal(await second.stop(), 130);
  assert.equal(f.runs().filter(run => run.active).length, 1, 'Stopping the second dashboard preserves its worker');
});

test('a detached --once waits for its pass and reads the resulting status', async t => {
  const f = await fixture(t);
  f.release('ac:a1');
  const run = watch(t, planner, ['--config', f.configFile, '--once'], f.env);
  const code = await new Promise(resolve => run.child.once('close', resolve));
  assert.equal(code, 0, run.output());
  assert.equal(f.passes().length, 1);
  assert.equal(f.runs()[0].result.code, 0);
  assert.equal(f.runs()[0].active, false);
});

test('an unrelated dispatcher cannot stop or count another dispatcher worker', async t => {
  const f = await fixture(t), run = f.start();
  await run.until(() => f.passes().length === 1);
  const selected = f.runs()[0];
  assert.deepEqual(detachedRuns(f.config.runs_folder, 'other-dispatcher'), []);
  assert.throws(() => stopDetachedRun(f.config.runs_folder, 'other-dispatcher', path.basename(selected.folder)), /No unique live/);
  assert.equal(alive(selected.pid), true);
  assert.equal(await run.stop(), 130);
});

test('Ctrl+C detaches a waiting --once dashboard without stopping its pass', async t => {
  const f = await fixture(t);
  const run = watch(t, planner, ['--config', f.configFile, '--once'], f.env);
  await run.until(() => f.passes().length === 1);
  const worker = f.runs()[0];
  assert.equal(await run.stop(), 130);
  assert.equal(alive(worker.pid), true);
  const full = watch(t, planner, ['--config', f.configFile, '--once'], f.env);
  const code = await new Promise(resolve => full.child.once('close', resolve));
  assert.equal(code, 0, full.output());
  assert.equal(f.passes().length, 1, 'A full dispatcher starts no extra pass');
});

test('a saved nonzero profile keeps its old context after detached config reload', async t => {
  const inputs = [{selection: {kind: 'ac', data: {stage: 'absent'}}}, {selection: {kind: 'ac'}}];
  const f = await fixture(t, {inputs}), run = f.start();
  try {
    await run.until(() => f.passes().length === 1);
    await run.until(() => f.runs().some(row => row.active && row.medullaRun));
    const old = f.runs().find(row => row.active);
    assert.equal(old.input, 1);
    assert.equal(read(path.join(old.medullaRun, 'artifacts/input.json')).input, undefined);
    f.write({...f.config, concurrency: 2, inputs: [inputs[0], {...inputs[1],
      related: {limit: 20, parent: {kind: 'req'}}}], vars: {VERSION: 'second'}});
    await run.until(() => f.passes().length === 2);
    assert.deepEqual(f.passes().map(line => JSON.parse(line).version), ['first', 'second']);
    assert.equal(f.runs().filter(row => row.active).length, 2);
    assert.equal(read(old.args[old.args.indexOf('--config') + 1]).inputs[1].related, undefined);
  } finally { if (run.child.exitCode === null) await run.stop(); }
});
