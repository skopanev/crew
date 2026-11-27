import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {plannerConfig} from '../../planning-joppa/planner-config.mjs';
import {plannerRows} from '../../planning-joppa/run-rows.mjs';
import {PlannerRuns} from '../../planning-joppa/planner-runs.mjs';
import {pause, planner, plannerFixture, watch} from '../test-support/config-reload.fixture.mjs';

async function fixture(t, values = {}) {
  const f = await plannerFixture(t, {concurrency: 3, ...values}, 0,
    '#!/bin/sh\nexec "$TEST_NODE" "$TEST_WORKER" "$5"\n');
  const workflow = path.join(f.root, 'workflow.yaml');
  fs.writeFileSync(workflow, 'nodes: {}\n');
  f.config.workflow = workflow;
  f.config.selection = {kind: 'ac'};
  f.write(f.config);
  const worker = path.join(f.root, 'pass.cjs');
  fs.writeFileSync(worker, `const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const address=process.argv[2], folder=path.join(process.env.TEST_RUNS,'2026-11-18_11-00-00-'+randomUUID());
fs.mkdirSync(path.join(folder,'artifacts'),{recursive:true});
fs.writeFileSync(path.join(folder,'.lock'),String(process.pid));
fs.writeFileSync(path.join(folder,'artifacts/input.json'),JSON.stringify({workspace:'fixture',
  selected:{address,current_revision:3,document:{data:{title:address}}}}));
console.log(folder);
console.log('stdout '+address); console.error('stderr '+address);
fs.appendFileSync(process.env.TEST_PASSES,JSON.stringify({address,pid:process.pid,folder,time:Date.now()})+'\\n');
const finish=()=>{const code=process.env.TEST_FAIL===address?2:0;
  fs.writeFileSync(path.join(folder,'artifacts/result.json'),JSON.stringify({status:code?'blocked':'published',selected_revision:4}));
  console.log('end '+address); process.exit(code);};
if(process.env.TEST_AUTO_RELEASE) setTimeout(finish,100);
else setInterval(()=>{if(fs.existsSync(path.join(process.env.TEST_RELEASE,address)))finish();},30);
`);
  const release = path.join(f.root, 'release');
  fs.mkdirSync(release);
  Object.assign(f.env, {TEST_NODE: process.execPath, TEST_WORKER: worker, TEST_RELEASE: release,
    TEST_RUNS: f.config.runs_folder});
  const starts = () => f.passes().map(line => JSON.parse(line));
  return {...f, starts, release: address => fs.writeFileSync(path.join(release, address), '')};
}

test('planner concurrency defaults to one and rejects invalid limits', async t => {
  const f = await fixture(t);
  for (const value of [0, -1, 1.5, '3', true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => plannerConfig(f.configFile, {}, Buffer.from(JSON.stringify({...f.config, concurrency: value}))),
      /concurrency must be a positive integer/);
  }
  const {concurrency, ...single} = f.config;
  assert.equal(plannerConfig(f.configFile, {}, Buffer.from(JSON.stringify(single))).concurrency, 1);
  assert.equal(plannerConfig(f.configFile).concurrency, 3);
});

test('three independent passes keep their slots and logs across claim revision changes and a failure', async t => {
  const f = await fixture(t, {interval_seconds: 10});
  const sample = f.objects.get('ac:a1');
  for (const address of ['ac:a3', 'ac:a4']) f.objects.set(address, {...structuredClone(sample), address});
  f.env.TEST_FAIL = 'ac:a2';
  const run = f.start();
  try {
  await run.until(() => f.starts().length === 3);
  assert.deepEqual(f.starts().map(row => row.address).sort(), ['ac:a1', 'ac:a2', 'ac:a3']);
  assert.equal(new Set(f.starts().map(row => row.pid)).size, 3);
  assert.equal(new Set(f.starts().map(row => row.folder)).size, 3);
  assert.match(run.output(), /3 running · concurrency 3/);
  for (const {address} of f.starts()) f.objects.get(address).current_revision = 4;
  await pause(150);
  assert.equal(f.starts().length, 3, 'The fourth item waits for capacity');
  f.release('ac:a2');
  await run.until(() => f.starts().length === 4, 4000);
  assert.equal(f.starts()[3].address, 'ac:a4', 'A free slot starts immediately, without the 10-second polling delay');
  assert.match(run.output(), /Planning exited 2/);
  assert.equal(f.starts().filter(row => row.address === 'ac:a1').length, 1, 'A claim revision cannot duplicate an active AC');
  assert.equal(f.starts().filter(row => row.address === 'ac:a3').length, 1);
  const first = f.starts().find(row => row.address === 'ac:a1'), third = f.starts().find(row => row.address === 'ac:a3');
  const rows = plannerRows(f.config.runs_folder, [
    {folder: first.folder, ended: false}, {folder: third.folder, ended: false}]);
  assert.equal(rows.filter(row => row.active).length, 3);
  assert.equal(await run.stop(), 130);
  assert.equal(fs.existsSync(path.join(f.config.runs_folder, 'dispatch.lock')), false);
  for (const {address, pid, folder} of f.starts()) {
    assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
    const log = fs.readFileSync(path.join(folder, 'output.log'), 'utf8');
    assert.match(log, new RegExp('stdout ' + address));
    assert.match(log, new RegExp('stderr ' + address));
    for (const other of f.starts().filter(row => row.address !== address)) assert.ok(!log.includes('stdout ' + other.address));
  }
  } finally { if (run.child.exitCode === null && run.child.signalCode === null) await run.stop(); }
});

test('--once starts one pass even when the configured concurrency is three', async t => {
  const f = await fixture(t);
  f.env.TEST_AUTO_RELEASE = '1';
  const run = watch(t, planner, ['--config', f.configFile, '--once'], f.env);
  const code = await new Promise(resolve => run.child.once('close', resolve));
  assert.equal(code, 0, run.output());
  assert.equal(f.starts().length, 1);
});

test('a second automatic dashboard cannot bypass the shared dispatcher lock', async t => {
  const f = await fixture(t);
  const first = f.start();
  await first.until(() => f.starts().length === 2);
  const second = f.start();
  const code = await new Promise(resolve => second.child.once('close', resolve));
  assert.equal(code, 2);
  assert.match(second.output(), /Another dispatcher holds/);
  assert.equal(f.starts().length, 2);
  assert.equal(await first.stop(), 130);
});

test('repeat flows keep their polling interval after a slot becomes free', async t => {
  const f = await fixture(t, {repeat: true, interval_seconds: 1});
  f.objects.delete('ac:a2');
  f.env.TEST_AUTO_RELEASE = '1';
  const run = f.start();
  await run.until(() => f.starts().length >= 2, 4000);
  assert.ok(f.starts()[1].time - f.starts()[0].time >= 1000, 'repeat does not create a completion loop');
  assert.equal(await run.stop(), 130);
});

// crew m_de7f065d: a config edit must not stop new passes until all active passes end. Each configured inline pass
// runs on its own copy of the config bytes, so the next selection uses the new config at once.
test('a changed config applies to the next pass while active passes keep their copy, and SIGTERM stops all', async t => {
  const f = await fixture(t, {interval_seconds: 1});
  const snapshots = () => {
    const folder = path.join(f.config.runs_folder, '.config-snapshots');
    return fs.existsSync(folder) ? fs.readdirSync(folder).map(name => JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')).concurrency).sort() : [];
  };
  const run = f.start();
  try {
    await run.until(() => f.starts().length === 2);
    assert.deepEqual(snapshots(), [3, 3]);
    f.objects.set('ac:a3', {...structuredClone(f.objects.get('ac:a1')), address: 'ac:a3'});
    f.write({...f.config, concurrency: 4});
    await run.until(() => f.starts().length === 3);
    assert.equal(f.starts()[2].address, 'ac:a3', 'The new config selects while the old passes run');
    assert.deepEqual(snapshots(), [3, 3, 4], 'The old passes keep their config, the new pass has the edited one');
    assert.match(run.output(), /concurrency 4/);
    assert.doesNotMatch(run.output(), /waiting for active passes/);
    f.release('ac:a1');
    await run.until(() => snapshots().length === 2);
    assert.deepEqual(snapshots(), [3, 4], 'A finished pass removes its config copy');
    const closed = new Promise(resolve => run.child.once('close', resolve));
    run.child.kill('SIGTERM');
    assert.equal(await closed, 143);
    for (const start of f.starts().slice(1)) assert.throws(() => process.kill(start.pid, 0), {code: 'ESRCH'});
    assert.deepEqual(snapshots(), []);
    assert.equal(fs.existsSync(path.join(f.config.runs_folder, 'dispatch.lock')), false);
  } finally { if (run.child.exitCode === null && run.child.signalCode === null) await run.stop(); }
});

test('a changed workspace still needs a restart while configured passes run', async t => {
  const f = await fixture(t, {interval_seconds: 1});
  const run = f.start();
  try {
    await run.until(() => f.starts().length === 2);
    f.objects.set('ac:a3', {...structuredClone(f.objects.get('ac:a1')), address: 'ac:a3'});
    f.write({...f.config, workspace: 'other', concurrency: 4});
    await run.until(output => /CONFIG_RESTART_REQUIRED/.test(output));
    await pause(1200);
    assert.equal(f.starts().length, 2, 'No pass starts with a changed identity');
  } finally { await run.stop(); }
});

test('shutdown kills a process group that ignores the graceful signal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-planner-stop-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const ready = path.join(root, 'child.pid'), worker = path.join(root, 'stubborn.cjs');
  fs.writeFileSync(worker, `const fs=require('node:fs'),{spawn}=require('node:child_process');
process.on('SIGTERM',()=>{});
spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.env.TEST_READY,String(process.pid));setInterval(()=>{},1000)\"],{stdio:'inherit'});
setInterval(()=>{},1000);`);
  const pool = new PlannerRuns(root, () => {});
  const run = pool.start('ac:stubborn', ['-c', 'exec "$TEST_NODE" "$TEST_WORKER"'],
    {...process.env, TEST_NODE: process.execPath, TEST_WORKER: worker, TEST_READY: ready});
  try {
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await pause(20);
    assert.ok(fs.existsSync(ready));
    const child = Number(fs.readFileSync(ready, 'utf8'));
    await pool.stop('SIGTERM');
    assert.equal(pool.size, 0);
    assert.throws(() => process.kill(run.child.pid, 0), {code: 'ESRCH'});
    assert.throws(() => process.kill(child, 0), {code: 'ESRCH'});
  } finally { await pool.stop('SIGTERM'); }
});

test('configured shutdown signals its launcher and allows claim cleanup after five seconds', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-flow-stop-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const ready = path.join(root, 'ready'), released = path.join(root, 'released');
  const worker = path.join(root, 'flow.cjs');
  fs.writeFileSync(worker, `const fs=require('node:fs'),{spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',"require('node:fs').writeFileSync(process.env.TEST_READY,'ready');setInterval(()=>{},1000)"],{stdio:'inherit'});
process.once('SIGTERM',()=>setTimeout(()=>{
  try {process.kill(child.pid,0);} catch {process.exit(3);}
  child.once('exit',()=>{fs.writeFileSync(process.env.TEST_RELEASED,'confirmed');process.exit(0);});
  child.kill('SIGTERM');
},5500));
setInterval(()=>{},1000);`);
  const pool = new PlannerRuns(root, () => {});
  const run = pool.start('ac:flow', ['-c', 'exec "$TEST_NODE" "$TEST_WORKER"'],
    {...process.env, TEST_NODE: process.execPath, TEST_WORKER: worker, TEST_READY: ready, TEST_RELEASED: released},
    null, true);
  try {
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await pause(20);
    assert.ok(fs.existsSync(ready));
    await pool.stop('SIGTERM');
    assert.equal(run.code, 0);
    assert.equal(fs.readFileSync(released, 'utf8'), 'confirmed');
    assert.equal(pool.size, 0);
  } finally { await pool.stop('SIGTERM'); }
});
