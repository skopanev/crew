import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {landingQueue} from './queue-display.mjs';
import {queueLabel} from './flow-batch.mjs';
import {slotsFixture} from '../lane-launcher/test-support/planner-slots.fixture.mjs';

const item = (address, branch, area = 'alpha') => ({address, document: {data: {area, delivery: {branch}}}});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-units-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const config = {workflow: '/path/workflow.yaml', selection: {kind: 'work'},
    batch: {size: 10, by: 'data.area', unit_field: 'data.delivery.branch'},
    slots: [{label: 'alpha', data: {area: 'first'}}, {label: 'beta', data: {area: 'second'}}]};
  const run = (slot, items, index = 0) => {
    const folder = path.join(root, String(fs.readdirSync(root).length));
    fs.mkdirSync(path.join(folder, 'artifacts'), {recursive: true});
    fs.writeFileSync(path.join(folder, 'launch.json'), JSON.stringify({input: index}));
    fs.writeFileSync(path.join(folder, 'config.json'), JSON.stringify(config));
    if (items) fs.writeFileSync(path.join(folder, 'artifacts/input.json'), JSON.stringify({input: index, selected: items[0], items}));
    return {runFolder: folder, slot, active: true};
  };
  return {root, config, run};
}

test('the header counts units in captured batches and removes those units from waiting', t => {
  const f = fixture(t), rows = [f.run('alpha', [item('work:a', 'one'), item('work:b', 'one'), item('work:c', 'two')]),
    f.run('beta', [item('work:d', 'three')], 1)];
  const queue = [['alpha', 'one'], ['alpha', 'two'], ['alpha', 'waiting'], ['alpha', 'waiting'], ['beta', 'three']];
  const occupied = new Map([['alpha', 1], ['beta', 1], ['empty', 0]]);
  assert.equal(queueLabel(queue, occupied, landingQueue(rows, f.config)),
    'queue: 1 waiting (alpha 2 landing / 1 waiting · beta 1 landing / 0 waiting · empty 0 landing / 0 waiting)');
  assert.equal(queue.length, 5, 'Rendering does not change the selection queue');
  const changed = {...f.config, batch: {...f.config.batch, unit_field: 'data.other'}};
  assert.deepEqual(landingQueue(rows, changed), landingQueue(rows, f.config), 'Frozen configs survive reload or restart');
  rows[0].active = false;
  assert.deepEqual(landingQueue(rows, f.config), [['beta', 'three']]);
});

test('uncaptured, unreadable or missing unit data remains unknown rather than a batch count', t => {
  const f = fixture(t), row = f.run('alpha');
  assert.equal(queueLabel([['alpha', 'one']], new Map([['alpha', 1]]), landingQueue([row], f.config)),
    'queue: unknown waiting (alpha unknown landing / unknown waiting)');
  fs.writeFileSync(path.join(row.runFolder, 'artifacts/input.json'), '{');
  assert.deepEqual(landingQueue([row], f.config), [['alpha', null]]);
  assert.deepEqual(landingQueue([], f.config, [{slot: 'alpha'}]), [['alpha', null]]);
  const missing = f.run('alpha', [item('work:a', undefined)]);
  assert.deepEqual(landingQueue([missing], f.config), [['alpha', null]]);
});

test('legacy grouped flows count captured units without slots or an occupied batch count', t => {
  const f = fixture(t); delete f.config.slots;
  const row = f.run(undefined, [item('work:a', 'one', 'group'), item('work:b', 'one', 'group')]);
  assert.equal(queueLabel([['group', 'one'], ['group', 'two']], undefined, landingQueue([row], f.config)),
    'queue: 1 waiting (group 1 landing / 1 waiting)');
});

test('the live dashboard subtracts captured branch units while retaining slot admission', async t => {
  const f = await slotsFixture(t);
  f.write({...f.config, batch: {size: 3, by: 'data.repository', unit_field: 'data.delivery.branch'}});
  const run = f.start();
  try {
    await run.until(() => f.starts().length === 2);
    for (const pass of f.starts()) {
      const file = path.join(pass.folder, 'artifacts/input.json');
      const input = JSON.parse(fs.readFileSync(file));
      input.items = pass.slot === 'A' ? [f.objects.get('ac:a1'), f.objects.get('ac:a3')] : [f.objects.get('ac:a2')];
      fs.writeFileSync(file + '.next', JSON.stringify(input)); fs.renameSync(file + '.next', file);
    }
    await run.until(output => output.includes('queue: 0 waiting (A 2 landing / 0 waiting · B 1 landing / 0 waiting)'));
    const next = structuredClone(f.objects.get('ac:a3')); next.address = 'ac:a4'; next.document.data.delivery.branch = 'next';
    f.objects.set(next.address, next);
    await run.until(output => output.includes('queue: 1 waiting (A 2 landing / 1 waiting · B 1 landing / 0 waiting)'));
    assert.equal(f.starts().length, 2, 'The display does not free an occupied slot');
  } finally { await run.stop(); }
});
