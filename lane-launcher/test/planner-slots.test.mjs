import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {normalizeSlots, occupiedSlots} from '../../planning-joppa/slots.mjs';
import {plannerRows} from '../../planning-joppa/run-rows.mjs';
import {slotsFixture} from '../test-support/planner-slots.fixture.mjs';
import {pause} from '../test-support/config-reload.fixture.mjs';

test('slot profiles merge nested filters and keep the source config unchanged', () => {
  const config = {workflow: '/path/workflow.yaml', selection: {kind: 'work', assignee: '',
    data: {delivery: {state: 'pending'}, flags: {enabled: true}}},
    slots: [{label: 'first', data: {repository: 'alpha', flags: {reviewed: true}}}]};
  const copy = structuredClone(config), loaded = normalizeSlots(config);
  assert.deepEqual(config, copy);
  assert.equal(loaded.slots, undefined);
  assert.equal(loaded.concurrency, 1);
  assert.deepEqual(loaded.inputs[0], {slot: 'first', selection: {kind: 'work', assignee: '',
    data: {delivery: {state: 'pending'}, flags: {enabled: true, reviewed: true}, repository: 'alpha'}}});
  assert.equal(normalizeSlots(copy).inputs.length, 1);
  for (const change of [{slots: []}, {inputs: []}, {slots: [{label: 'A', data: {}}, {label: 'A', data: {}}]},
    {slots: [{label: '', data: {}}]}, {slots: [{label: 'A', data: []}]}]) {
    assert.throws(() => normalizeSlots({...config, ...change}), /slots:/);
  }
  const legacy = {workflow: '/path/workflow.yaml', selection: {kind: 'work'}};
  assert.equal(normalizeSlots(legacy), legacy);
});

test('two filtered slots run together while the next batch of a busy slot waits', async t => {
  const f = await slotsFixture(t), run = f.start();
  try {
    await run.until(() => f.starts().length === 2);
    assert.deepEqual(f.starts().map(row => [row.address, row.slot]).sort(),
      [['ac:a1', 'A'], ['ac:a2', 'B']]);
    assert.equal(new Set(f.starts().map(row => row.pid)).size, 2);
    await pause(1100);
    assert.equal(f.starts().length, 2);
    assert.match(run.output(), /A 1 landing/);
    assert.match(run.output(), /B 1 landing/);
    assert.match(run.output(), /\[A\]\s+ac:a1/);
    assert.match(run.output(), /\[B\]\s+ac:a2/);
    assert.ok(plannerRows(f.config.runs_folder, null, 30, normalizeSlots(f.config))
      .filter(row => row.active).every(row => row.ticket.startsWith('[' + row.slot + ']')));
    f.release('ac:a1');
    await run.until(() => f.starts().length === 3);
    assert.equal(f.starts()[2].address, 'ac:a3');
    assert.equal(f.starts()[2].slot, 'A');
  } finally { await run.stop(); }
});

test('slot batch overrides merge only into their slot and reject unknown or invalid fields', () => {
  const config = {workflow: '/path/workflow.yaml', selection: {kind: 'work'},
    batch: {size: 10, min_size: 3, by: 'data.area'},
    slots: [{label: 'A', data: {}, batch: {min_size: 1}}, {label: 'B', data: {}}]};
  const before = structuredClone(config), loaded = normalizeSlots(config);
  assert.deepEqual(loaded.inputs[0].batch, {size: 10, min_size: 1, by: 'data.area'});
  assert.equal(loaded.inputs[1].batch, undefined);
  assert.deepEqual(loaded.batch, before.batch);
  assert.deepEqual(config, before);
  for (const batch of [{unknown: 1}, {size: 2}, {min_size: 0}, null, []]) {
    assert.throws(() => normalizeSlots({...config, slots: [{label: 'A', data: {}, batch}]}), /batch/);
  }
});

test('a slot minimum survives restart while other slots wait for the common minimum', async t => {
  const f = await slotsFixture(t);
  const lock = path.join(f.root, 'producer', 'one', 'worker.lock'); fs.mkdirSync(lock, {recursive: true});
  fs.writeFileSync(path.join(path.dirname(lock), 'launch.json'), JSON.stringify({worker: {pid: process.pid}}));
  f.write({...f.config, batch: {size: 3, min_size: 3, by: 'data.repository',
    flush_when_idle: path.join(f.root, 'producer', '*', 'worker.lock')},
    slots: [{label: 'A', data: {repository: 'alpha'}, batch: {min_size: 1}}, f.config.slots[1]]});
  const first = f.start();
  await first.until(() => f.starts().length === 1);
  assert.equal(f.starts()[0].slot, 'A');
  const snapshot = path.join(f.runs()[0].folder, 'config.json');
  const frozen = fs.readFileSync(snapshot, 'utf8');
  assert.equal(normalizeSlots(JSON.parse(frozen)).inputs[0].batch.min_size, 1);
  assert.equal(await first.stop(), 130);
  const second = f.start();
  try {
    await pause(1100);
    assert.equal(f.starts().length, 1);
    f.release('ac:a1');
    await second.until(() => f.starts().length === 2);
    assert.equal(f.starts()[1].address, 'ac:a3');
    assert.equal(f.starts()[1].slot, 'A');
    assert.equal(fs.readFileSync(snapshot, 'utf8'), frozen);
    await pause(1100);
    assert.equal(f.starts().length, 2, 'The other slot still needs three items while its producer is live');
  } finally { await second.stop(); }
});

test('a restarted dashboard keeps live slot occupancy after slot reordering', async t => {
  const f = await slotsFixture(t, {concurrency: 1}), first = f.start();
  await first.until(() => f.starts().length === 1);
  assert.equal(await first.stop(), 130);
  f.write({...f.config, concurrency: 2, slots: [...f.config.slots].reverse()});
  const second = f.start();
  try {
    await second.until(() => f.starts().length === 2);
    assert.deepEqual(f.starts().map(row => [row.address, row.slot]),
      [['ac:a1', 'A'], ['ac:a2', 'B']]);
    await pause(1100);
    assert.equal(f.starts().length, 2);
  } finally { await second.stop(); }
});

test('overlapping slot filters do not start the same object twice', async t => {
  const f = await slotsFixture(t);
  f.objects.delete('ac:a3');
  f.write({...f.config, slots: [{label: 'A', data: {repository: 'alpha'}},
    {label: 'B', data: {repository: 'alpha'}}]});
  const run = f.start();
  try {
    await run.until(() => f.starts().length === 1);
    await pause(1100);
    assert.equal(f.starts().length, 1);
    assert.equal(f.starts()[0].address, 'ac:a1');
  } finally { await run.stop(); }
});

test('unknown or renamed live slot state blocks admission and broken journals are refused', t => {
  const config = normalizeSlots({workflow: '/path/workflow.yaml', selection: {kind: 'work'},
    slots: [{label: 'A', data: {}}]});
  for (const row of [{active: true, runFolder: 'one'}, {slotUncertain: true},
    {active: true, runFolder: 'one', slot: 'removed'}]) {
    assert.throws(() => occupiedSlots(config, [row], []), /slot|unknown/i);
  }
  assert.deepEqual([...occupiedSlots(config, [{active: true, runFolder: 'one', slot: 'A'}],
    [{folder: 'one', slot: 'A'}])], [['A', 1]]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-slot-unknown-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const run = path.join(root, '2026-11-25_12-00-00-unknown'); fs.mkdirSync(run);
  fs.writeFileSync(path.join(run, 'launch.json'), '{');
  assert.throws(() => plannerRows(root, null, 30, config), /Run state unavailable/);
  fs.writeFileSync(path.join(run, 'launch.json'), JSON.stringify({address: 'work:one', slot: 'A',
    attemptKey: JSON.stringify(['work:one', 1]), worker: {pid: 0}}));
  assert.throws(() => occupiedSlots(config, plannerRows(root, null, 30, config), []), /unknown/);
  const retained = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-retained-slot-'));
  t.after(() => fs.rmSync(retained, {recursive: true, force: true}));
  const before = fs.readFileSync(path.join(run, 'launch.json'));
  fs.renameSync(run, path.join(retained, path.basename(run)));
  assert.deepEqual(fs.readFileSync(path.join(retained, path.basename(run), 'launch.json')), before);
  assert.equal(occupiedSlots(config, plannerRows(root, null, 30, config), []).get('A'), 0);
});

// crew m_de7f065d: the Lander (inline, slots) applies a slot selection edit to the next selection at once.
test('an inline slot selection edit starts the other slot while the first slot pass still runs', async t => {
  const f = await slotsFixture(t, {execution: 'inline'});
  f.write({...f.config, slots: [{label: 'A', data: {repository: 'alpha'}}, {label: 'B', data: {repository: 'gamma'}}]});
  const run = f.start();
  try {
    await run.until(() => f.starts().length === 1);
    assert.equal(f.starts()[0].slot, 'A');
    await pause(1200);
    assert.equal(f.starts().length, 1, 'Slot B selects nothing before the edit');
    f.write({...f.config, slots: [{label: 'A', data: {repository: 'alpha'}}, {label: 'B', data: {repository: 'beta'}}]});
    await run.until(() => f.starts().length === 2);
    assert.deepEqual(f.starts().map(start => [start.slot, start.address]), [['A', 'ac:a1'], ['B', 'ac:a2']]);
    assert.doesNotMatch(run.output(), /waiting for active passes/);
  } finally { await run.stop(); }
});
