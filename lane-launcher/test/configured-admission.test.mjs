import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {plannerFixture, planner, watch} from '../test-support/config-reload.fixture.mjs';
import {admissionAllowed, admissionForItem} from '../../planning-joppa/configured-admission.mjs';
import {nextConfiguredItem, flowSettings} from '../../planning-joppa/queue.mjs';
import {plannerRows} from '../../planning-joppa/run-rows.mjs';

async function fixture(t) {
  const f = await plannerFixture(t);
  const workflow = path.join(f.root, 'workflow.yaml'); fs.writeFileSync(workflow, 'nodes: {}\n');
  let count = 0;
  const module = body => {
    const file = path.join(f.root, `admission-${count++}.mjs`);
    fs.writeFileSync(file, body);
    return file;
  };
  const config = {...f.config, workflow, selection: {kind: 'ac'}, publication: {file: 'operations.json'}};
  return {...f, config, module};
}

test('the configured module uses only scoped reads and cannot mutate selection inputs', async t => {
  const f = await fixture(t), row = {address: 'ac:a1', revision: 3};
  const config = {...f.config, admission_module: f.module(`export async function admission(row, profile, read) {
    row.address='changed'; profile.selection.kind='changed';
    return (await read('joppa_objects',{address:'ac:a1',workspace:'foreign'})).allowed;
  }`)};
  const calls = [], read = async (tool, args) => {calls.push({tool, args}); return {allowed: false};};
  assert.equal(await admissionAllowed(row, config, read), false);
  assert.equal(row.address, 'ac:a1'); assert.equal(config.selection.kind, 'ac');
  assert.deepEqual(calls, [{tool: 'joppa_objects', args: {address: 'ac:a1', workspace: 'fixture'}}]);
  for (const [body, error] of [
    ['export const other=1;', /export admission/],
    ['export const admission=()=>"yes";', /boolean/],
    ['export const admission=()=>{throw Error("unavailable")};', /unavailable/],
    ['export const admission=(row,profile,read)=>read("joppa_batch",{});', /does not permit/],
  ]) await assert.rejects(admissionAllowed(row, {...config, admission_module: f.module(body)}, read), error);
  assert.throws(() => flowSettings({...config, admission_module: 'relative.mjs'}), /absolute module/);
  assert.throws(() => flowSettings({...config, admission_module: path.join(f.root, 'missing.mjs')}), /absolute module/);
});

test('effective profiles apply admission before selection and retain their input identity', async t => {
  const f = await fixture(t);
  f.queue.push('task:t1', 'task:t2');
  const config = {...f.config, admission_module: f.module(`export const admission=(row,profile)=>
    profile.selection.kind==='ac' && row.address==='ac:a2';`), inputs: [
    {selection: {kind: 'task'}}, {selection: {kind: 'ac'}}]};
  const result = await nextConfiguredItem(config, config.token_file);
  assert.equal(result.next.address, 'ac:a2'); assert.equal(result.next.input, 1);
  assert.equal(result.filtered, 3);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
  assert.equal(await admissionForItem(config, config.token_file, 'ac:a2', 1), true);
  assert.equal(await admissionForItem(config, config.token_file, 'task:t1', 0), false);
});

test('batch readiness counts only admitted rows', async t => {
  const f = await fixture(t);
  const config = {...f.config, batch: {size: 2, min_size: 2},
    admission_module: f.module('export const admission=row=>row.address==="ac:a2";')};
  assert.equal((await nextConfiguredItem(config, config.token_file)).next, null);
  assert.equal((await nextConfiguredItem({...config, batch: {size: 2, min_size: 1}}, config.token_file)).next.address, 'ac:a2');
});

test('the reader identity is stable within a pass and fresh across passes or workspaces', async t => {
  const f = await fixture(t);
  const module = f.module('export const seen=[]; export const admission=(row,profile,read)=>{seen.push(read);return row.address==="ac:a2";};');
  const config = {...f.config, admission_module: module};
  const {seen} = await import(pathToFileURL(module).href);
  await nextConfiguredItem(config, config.token_file);
  await nextConfiguredItem(config, config.token_file);
  assert.equal(seen[0], seen[1]);
  assert.equal(seen[2], seen[3]);
  assert.notEqual(seen[0], seen[2]);
  const read = async () => ({}), row = {address: 'ac:a2'};
  await admissionAllowed(row, config, read);
  await admissionAllowed(row, config, read);
  await admissionAllowed(row, {...config, workspace: 'other'}, read);
  assert.equal(seen[4], seen[5]);
  assert.notEqual(seen[4], seen[6]);
  await admissionForItem(config, config.token_file, 'ac:a2');
  await admissionForItem(config, config.token_file, 'ac:a2');
  assert.notEqual(seen[7], seen[8], 'Separate direct checks do not share a pass');
});

test('automatic and explicit dashboard skips create no pass, claim or run row', async t => {
  for (const explicit of [false, true]) {
    const f = await fixture(t);
    f.write({...f.config, admission_module: f.module('export const admission=()=>false;')});
    const run = watch(t, planner, ['--config', f.configFile, '--once', ...(explicit ? ['--item-id', 'ac:a1'] : [])], f.env);
    assert.equal(await new Promise(resolve => run.child.once('close', resolve)), 0, run.output());
    assert.equal(f.passes().length, 0);
    assert.equal(plannerRows(f.config.runs_folder).length, 0);
    assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
  }
});

test('the direct flow launcher cannot bypass admission or start Medulla for a skipped item', async t => {
  const f = await fixture(t);
  f.write({...f.config, admission_module: f.module('export const admission=()=>false;')});
  const env = {...f.env, MEDULLA_BIN: 'must-not-start'}; delete env.PLANNING_JOPPA_HANDOFF_DIGEST;
  const script = fileURLToPath(new URL('../../planning-joppa/launch.py', import.meta.url));
  const child = spawn('python3', [script, '--config', f.configFile, '--item-id', 'ac:a1'], {env});
  let output = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
  assert.equal(await new Promise(resolve => child.once('close', resolve)), 0, output);
  assert.match(output, /Skipped by configured admission/);
  assert.equal(fs.existsSync(f.config.runs_folder), false);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});
