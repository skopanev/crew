import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {batchReady, batchQueue, batchSettings, producerIdle, queueLabel} from './flow-batch.mjs';
import {nextConfiguredItem} from './queue.mjs';
import {plannerFixture} from '../lane-launcher/test-support/config-reload.fixture.mjs';

test('idle flush waits for a real worker, then accepts its dead PID without deleting its lock', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-idle-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const pattern = path.join(root, '*', 'worker.lock');
  assert.equal(producerIdle(pattern), true);
  assert.equal(producerIdle(path.join(root, 'missing', '*', 'worker.lock')), false);
  const run = path.join(root, 'run'), lock = path.join(run, 'worker.lock');
  fs.mkdirSync(lock, {recursive: true});
  assert.equal(producerIdle(pattern), false);
  fs.writeFileSync(path.join(run, 'launch.json'), '{');
  assert.equal(producerIdle(pattern), false);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => child.kill());
  fs.writeFileSync(path.join(run, 'launch.json'), JSON.stringify({worker: {pid: child.pid}}));
  assert.equal(producerIdle(pattern), false);
  const closed = once(child, 'exit');
  child.kill(); await closed;
  assert.equal(producerIdle(pattern), true);
  assert.equal(fs.existsSync(lock), true);
  const realKill = process.kill;
  process.kill = () => { throw Object.assign(new Error('denied'), {code: 'EPERM'}); };
  try { assert.equal(producerIdle(pattern), false); } finally { process.kill = realKill; }
  fs.symlinkSync(run, path.join(root, 'alias'));
  assert.equal(producerIdle(pattern), false);
});

test('small batches require idle evidence even when the age threshold passed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-idle-batch-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const batch = {size: 10, min_size: 3, unit_field: 'branch',
    flush_when_idle: path.join(root, '*', 'worker.lock'), max_wait_seconds: 1, age_field: 'at'};
  const rows = [{branch: 'one', at: '2000-01-01T00:00:00Z'}, {branch: 'one'}];
  assert.equal(batchReady(batch, rows), true);
  fs.mkdirSync(path.join(root, 'unknown', 'worker.lock'), {recursive: true});
  assert.equal(batchReady(batch, rows), false);
  assert.equal(batchReady(batch, []), false);
  assert.equal(batchReady(batch, [...rows, {branch: 'two'}, {branch: 'three'}]), true);
  for (const flush_when_idle of ['', 'runs/*/worker.lock', '/runs/**/worker.lock', '/runs/../x', '/runs/?/worker.lock']) {
    assert.throws(() => batchSettings({...batch, flush_when_idle}), /absolute/);
  }
});

test('queue counts cover all profiles, preserve selection order, and count each branch once', async t => {
  const f = await plannerFixture(t);
  for (const [id, repo] of [['ac:a1', 'service'], ['ac:a2', 'other']]) {
    Object.assign(f.objects.get(id).document.data, {repository: repo, delivery: {branch: 'same'}});
  }
  const config = {...f.config, workflow: '/tmp/workflow.yaml', batch: {
    size: 10, min_size: 1, by: 'data.repository', unit_field: 'data.delivery.branch'},
    inputs: [{selection: {kind: 'ac', data: {repository: 'service'}}},
      {selection: {kind: 'ac', data: {repository: 'other'}}},
      {selection: {kind: 'ac', data: {repository: 'service'}}}]};
  const selected = await nextConfiguredItem(config, f.config.token_file);
  assert.equal(selected.next.address, 'ac:a1');
  assert.equal(selected.next.input, 0);
  assert.equal(queueLabel(selected.queue), 'queue: 2 queued (service 0 landing / 1 queued · other 0 landing / 1 queued)');
  const rows = [{address: 'a', group: 'service', unit: 'same', 'data.tags': []},
    {address: 'b', group: 'service', unit: 'same', 'data.tags': []},
    {address: 'c', group: 'service', unit: 'hidden', 'data.tags': ['exclude']}];
  assert.equal(queueLabel(batchQueue({by: 'group', unit_field: 'unit'}, rows, ['exclude'])), 'queue: 1 queued (service 0 landing / 1 queued)');
});
