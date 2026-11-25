import test from 'node:test';
import assert from 'node:assert/strict';
import {avgPace, landingPace} from '../avg-pace.mjs';
import {dolberPaceRows} from '../dolber-pace.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {plannerRows} from '../../planning-joppa/run-rows.mjs';
import {landerRows} from '../../lander/status.mjs';

const now = Date.parse('2026-11-25T18:00:00Z'), hour = 3600000;
const at = hours => new Date(now - hours * hour).toISOString();
const row = (id, start, end, paceCount = 1) => ({runId: id, start: at(start), end: at(end), paceCount});

test('pace needs one hour of retained history and uses the observed window up to six hours', () => {
  assert.equal(avgPace([], now), 'avg pace: ?');
  assert.equal(avgPace([row('a', .99, .1)], now), 'avg pace: ?');
  assert.equal(avgPace([row('a', 1, .1)], now), 'avg pace: 1.0/hr');
  assert.equal(avgPace([row('a', 2, .1), row('b', 1, .2), row('c', .5, .3)], now), 'avg pace: 1.5/hr');
  assert.equal(avgPace([row('a', 8, 7), row('b', 7, 6), row('c', 1, .1)], now), 'avg pace: 0.3/hr');
});

test('pace uses completion time, excludes active failures and future timestamps, and keeps all retained rows', () => {
  const rows = [row('old', 7, 6.1), {...row('active', 6, .1), active: true}, row('failed', 5, .1, 0),
    row('future', 1, -1), {...row('invalid', 1, .1), end: 'unknown'}];
  assert.equal(avgPace(rows, now), 'avg pace: 0.0/hr');
  rows.push(...Array.from({length: 36}, (_, i) => row('success-' + i, 1, .1)));
  assert.equal(avgPace(rows, now), 'avg pace: 6.0/hr');
});

test('Dolber counts confirmed branch handoffs and exited success, excluding held and blocked results', () => {
  const result = {code: 0, status: 'exited', finishedAt: at(.1)};
  const run = (dir, value) => ({dir, createdAt: at(2), result: value});
  const rows = dolberPaceRows([run('exited', result), run('branch', {...result, status: 'PENDING_LANDING', pendingDelivery: true}),
    run('failed', {...result, code: 2}), run('held', {...result, held: true}), run('blocked', {...result, blocked: true})]);
  assert.equal(avgPace(rows, now), 'avg pace: 1.0/hr');
});

test('Lander counts unique accepted branches in partial batches only after confirmed publication', () => {
  const task = (address, branch) => ({address, document: {data: {repository: 'service',
    delivery: {branch, head: branch.repeat(40)}}}});
  const input = {items: [task('task:one', 'a'), task('task:two', 'a'), task('task:three', 'b')]};
  const state = {landed: 'target', landed_at: at(.1), accepted: [{address: 'task:one'}, {address: 'task:two'}]};
  const result = {claim_released: true, reason_code: 'PARTIAL_LANDING'};
  const measure = value => avgPace([{...row('batch', 2, .1), ...value}], now);
  assert.equal(measure(landingPace(input, state, result)), 'avg pace: 0.5/hr');
  assert.equal(measure(landingPace(input, state, {...result, needs_recovery: true})), 'avg pace: 0.0/hr');
  assert.equal(measure(landingPace(input, null, result)), 'avg pace: 0.0/hr');
  const duplicate = landingPace(input, {...state, landed_at: at(.05)}, result);
  assert.equal(avgPace([{...row('first', 2, .1), ...landingPace(input, state, result)},
    {...row('retry', 1, .05), ...duplicate}], now), 'avg pace: 0.5/hr');
});

test('retained Lander records contribute branch counts without multiplying one batch into one completion', () => {
  const retained = {source: 'lander', run_id: 'old', reason_code: 'LANDED', publication_confirmed: true,
    batch_size: 9, ended_at: at(.1)};
  assert.equal(avgPace([{...row('old', 6, .1), ...landingPace(null, null, null, retained)}], now), 'avg pace: 1.5/hr');
  assert.equal(avgPace([{...row('old', 6, .1), ...landingPace(null, null, null,
    {...retained, publication_confirmed: false})}], now), 'avg pace: 0.0/hr');
});

test('both Lander readers preserve accepted branch evidence from the existing run artifacts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-evidence-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const stamp = new Date(at(2)).toLocaleString('sv-SE').replace(' ', '_').replaceAll(':', '-');
  const artifacts = path.join(root, stamp + '-batch', 'artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  const items = ['one', 'two'].map(id => ({address: 'task:' + id, revision: 1,
    document: {data: {repository: 'service', delivery: {branch: 'shared', head: 'a'.repeat(40)}}}}));
  const write = (name, value, time = at(.1)) => {
    const file = path.join(artifacts, name); fs.writeFileSync(file, JSON.stringify(value));
    fs.utimesSync(file, new Date(time), new Date(time));
  };
  write('input.json', {selected: items[0], items});
  write('claim.json', {status: 'confirmed'}, at(2));
  write('lander.json', {landed: 'target', landed_at: at(.1), accepted: items});
  write('result.json', {status: 'published', reason_code: 'LANDED', claim_released: true});
  write('release.json', {status: 'confirmed'});
  for (const rows of [plannerRows(root, null, Infinity), landerRows(root, null, Infinity)]) {
    assert.equal(rows.length, 1);
    assert.equal(avgPace(rows, now), 'avg pace: 0.5/hr');
  }
});
