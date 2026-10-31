import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {activeCount, dockerLanes, configFrom} from '../launcher.mjs';
import {scopeDirectory, laneRunFolder, validateId} from '../scope.mjs';
import {save, read, runDirectories} from '../runtime.mjs';
import {launcher, queueReads, execute, setup} from './launcher.fixture.mjs';

const claims = f => f.calls.filter(call => call.name === 'joppa_batch').length;
const herdrEvents = f => fs.existsSync(f.events) ? fs.readFileSync(f.events, 'utf8').trim().split('\n').map(JSON.parse) : [];

async function interrupted(t, child, ready, timeout) {
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '', signalled = false;
  child.stdout.on('data', data => {
    output += data;
    if (!signalled && ready(output)) { signalled = true; child.kill('SIGINT'); }
  });
  child.stderr.on('data', data => errors += data);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('dispatcher did not stop')); }, timeout);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  return {code, output, errors};
}

test('an available Task launches once; the pending tab consumes the only slot', async t => {
  const f = await setup(t);
  let result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(queueReads(f), 1);
  assert.equal(f.calls.find(call => call.args.view === 'available').args.project, 'project:app');
  const events = herdrEvents(f);
  const create = events.find(args => args[1] === 'create');
  assert.deepEqual(create.slice(0, 4), ['tab', 'create', '--workspace', 'workspace']);
  assert.ok(create.includes('--no-focus'));
  assert.ok(events.find(args => args[1] === 'run')[3].includes('worker.mjs'));
  assert.match(result.stdout, /Joppa Tasks \[workspace=fixture, project=project:app\]: 2 available · 0 held workers/);
  assert.equal(claims(f), 0, 'the worker claims; the dispatcher only reserves');
  result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running lanes 1 of 1/);
  assert.doesNotMatch(result.stdout, /Joppa Tasks/);
  assert.equal(queueReads(f), 1);
});
test('dolber-joppa.sh reads adjacent dolber-joppa.json from another cwd and only previews', async t => {
  const f = await setup(t, {launchLanes: false});
  // The copied Crew root must not contain the worker token directory.
  const crew = path.join(f.root, 'crew copy'), folder = path.join(crew, 'dolber folder');
  const source = fileURLToPath(new URL('..', import.meta.url));
  fs.mkdirSync(folder, {recursive: true});
  for (const file of fs.readdirSync(source).filter(name => /\.(mjs|sh)$/.test(name))) {
    fs.copyFileSync(path.join(source, file), path.join(folder, file));
  }
  fs.copyFileSync(fileURLToPath(new URL('../../notify.mjs', import.meta.url)), path.join(crew, 'notify.mjs'));
  const config = {...f.config};
  delete config.launchLanes; // Omission must also default to preview.
  save(path.join(folder, 'dolber-joppa.json'), config);
  const result = await execute(path.join(folder, 'dolber-joppa.sh'), ['--once'], f.env, {bin: 'sh', cwd: f.root});
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split('\n').filter(line => !/^─+$/.test(line));
  assert.deepEqual(lines, ['Running lanes 0 of 1',
    'Joppa Tasks [workspace=fixture, project=project:app]: 2 available · 0 held workers',
    'checking params:', '  project: project:app',
    'Starting new one with ticket: task:t1 (preview: запуск отключён)', '  [01] Task 1']);
  assert.equal(claims(f), 0);
  assert.ok(!fs.existsSync(f.events), 'preview must not call Herdr at all');
  assert.deepEqual(runDirectories(f.stateDir), []);
});
test('--dry-run overrides live config, previews once and never calls Herdr or claims work', async t => {
  const f = await setup(t);
  const before = fs.readFileSync(f.configFile, 'utf8');
  fs.rmSync(path.join(f.bins, 'medulla'));
  fs.rmSync(path.join(f.bins, 'jq'));
  const result = await execute(fileURLToPath(new URL('../dolber-joppa.sh', import.meta.url)),
    [path.basename(f.configFile), '--dry-run'], f.env, {bin: 'sh', cwd: f.root});
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /task:t1 \(preview: запуск отключён\)/);
  assert.doesNotMatch(result.stdout, /pause /);
  assert.equal(queueReads(f), 1);
  assert.equal(claims(f), 0);
  assert.ok(!fs.existsSync(f.events));
  assert.deepEqual(runDirectories(f.stateDir), []);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
});
test('--dry-run previews without Docker, while a live pass fails closed on Docker', async t => {
  const f = await setup(t, {dockerFailure: true});
  const result = await execute(launcher, ['--config', f.configFile, '--dry-run'], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(queueReads(f), 1);
  const live = await f.run();
  assert.equal(live.code, 1);
  assert.equal(queueReads(f), 1, 'the live pass read no queue');
  assert.ok(!fs.existsSync(f.events));
});
test('preview loop repeats after its interval and Ctrl+C releases the dispatcher lock', async t => {
  const f = await setup(t, {launchLanes: false});
  save(f.configFile, {...f.config, intervalSeconds: 1});
  const child = spawn(process.execPath, [launcher, '--config', f.configFile], {env: f.env});
  const {code, errors} = await interrupted(t, child, output => (output.match(/preview: запуск отключён/g) || []).length === 2, 8000);
  assert.equal(code, 0, errors);
  assert.equal(queueReads(f), 2);
  assert.ok(!fs.existsSync(f.events));
  assert.ok(!fs.existsSync(path.join(f.stateDir, 'dispatcher.lock')));
});
test('terminal dashboard refreshes the countdown and Ctrl+C releases the lock', async t => {
  const f = await setup(t, {launchLanes: false});
  save(f.configFile, {...f.config, intervalSeconds: 10});
  const tty = path.join(f.root, 'tty.cjs');
  fs.writeFileSync(tty, 'process.stdout.isTTY = true;\n');
  const child = spawn(process.execPath, ['--require', tty, launcher, '--config', f.configFile],
    {env: {...f.env, FORCE_COLOR: '0'}});
  const {code, output, errors} = await interrupted(t, child, output => /Next check in 00:0[4-6]/.test(output), 10000);
  assert.equal(code, 0, errors);
  assert.match(output, /Next check in 00:10/);
  assert.match(output, /project: project:app/);
  assert.match(output, /Tasks: 2 available · 0 held workers/);
  assert.match(output, /Stopped/);
  assert.equal(queueReads(f), 1);
  assert.ok(!fs.existsSync(path.join(f.stateDir, 'dispatcher.lock')));
});
test('an existing Docker lane of this dispatcher prevents a queue read', async t => {
  const f = await setup(t);
  fs.writeFileSync(f.docker, JSON.stringify({workflow: 'lane', runFolder: scopeDirectory('/manual, runs', f.config.id)}));
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running lanes 1 of 1/);
  assert.equal(f.calls.length, 0);
});
test('another dispatcher and unscoped containers do not occupy this dispatcher', async t => {
  const f = await setup(t);
  fs.writeFileSync(f.docker, [
    {workflow: 'lane', runFolder: scopeDirectory('/manual', f.config.id + '-other')},
    {workflow: 'lane', runFolder: ''},
    {workflow: '', runFolder: ''},
    {workflow: 'planning', runFolder: scopeDirectory('/manual', f.config.id)},
  ].map(row => JSON.stringify(row)).join('\n'));
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running lanes 0 of 1/);
  assert.equal(queueReads(f), 1);
});
test('config IDs isolate reservations and locks in the same state root', async t => {
  const f = await setup(t);
  assert.equal((await f.run()).code, 0);
  fs.mkdirSync(path.join(f.stateDir, 'dispatcher.lock'));
  const otherFile = path.join(f.root, 'other.json');
  save(otherFile, {...f.config, id: 'other-project'});
  const result = await execute(launcher, ['--config', otherFile, '--once'], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running lanes 0 of 1/);
  const other = configFrom(otherFile, f.env);
  const [runId] = fs.readdirSync(path.join(other.stateDir, 'runs'));
  const run = read(path.join(other.stateDir, 'runs', runId, 'launch.json'));
  assert.equal(run.config.id, 'other-project');
  assert.equal(laneRunFolder(run.runFolder, 'other-project'), run.runFolder);
  assert.ok(fs.existsSync(path.join(f.stateDir, 'dispatcher.lock')));
});
test('completed lane frees capacity even when its Herdr tab remains', async t => {
  const f = await setup(t);
  assert.equal((await f.run()).code, 0);
  const [runId] = fs.readdirSync(path.join(f.stateDir, 'runs'));
  const file = path.join(f.stateDir, 'runs', runId, 'launch.json');
  save(file, {...read(file), result: {status: 'exited', code: 0, released: true}});
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running lanes 0 of 1/);
  assert.equal(queueReads(f), 2);
});
test('dispatcher IDs are stable path-safe identities, including manual lanes', () => {
  assert.equal(validateId('Project-Backend'), 'project-backend');
  for (const id of ['', '../other', 'a/b', 'a,b', 'has space', 'a'.repeat(65), undefined]) {
    assert.throws(() => validateId(id), /needs id/);
  }
  const folder = laneRunFolder('/manual/runs', 'project-backend');
  assert.equal(folder, '/manual/runs/crew-dispatchers/project-backend');
  assert.equal(laneRunFolder(folder, 'project-backend'), folder);
  assert.throws(() => laneRunFolder(folder, 'another'), /another dispatcher/);
});
test('Docker failure fails closed before any queue read', async t => {
  const f = await setup(t, {dockerFailure: true});
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.equal(f.calls.length, 0);
});
test('empty queue leaves Herdr tabs unchanged', async t => {
  const f = await setup(t, {empty: true});
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Joppa Tasks \[workspace=fixture, project=project:app\]: 0 available · 0 held workers/);
  assert.ok(!herdrEvents(f).some(args => args[1] === 'create'));
  assert.deepEqual(runDirectories(f.stateDir), []);
});
test('lock refuses a second dispatcher before it selects work', async t => {
  const f = await setup(t);
  fs.mkdirSync(path.join(f.stateDir, 'dispatcher.lock'), {recursive: true});
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Dispatcher lock exists/);
  assert.equal(f.calls.length, 0);
});
test('Docker and its pending reservation count as one lane', async t => {
  const f = await setup(t);
  const dir = path.join(f.stateDir, 'runs', 'test');
  fs.mkdirSync(dir, {recursive: true});
  const runFolder = path.join(f.stateDir, 'runs/test/lane');
  save(path.join(dir, 'launch.json'), {runFolder, pane: 'test-pane'});
  const containers = dockerLanes(JSON.stringify({workflow: 'lane', runFolder}), f.config);
  assert.equal(activeCount({...f.config, stateDir: f.stateDir}, containers, new Set(['test-pane'])), 1);
});
