import test from 'node:test';
import assert from 'node:assert/strict';
import {availableCounts, availabilityLabel} from './availability.mjs';
import {normalizeSlots} from './slots.mjs';
import {slotsFixture} from '../lane-launcher/test-support/planner-slots.fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';

test('native counts preserve profile filters and show overlaps separately without admission reads', async () => {
  const config = {workspace: 'fixture', admission_module: '/must/not/run.mjs', inputs: [
    {selection: {kind: 'work', parent: 'project:one', depth: 4, status: ['red', 'blue'], owner: 'owner',
      data: {stage: 'repair', enabled: true}}},
    {selection: {kind: ['work', 'criterion'], parent: 'project:one', depth: 5, data: {stage: 'plan'}}},
  ]};
  const before = structuredClone(config), calls = [];
  const result = await availableCounts(config, null, null, true, async args => {
    calls.push(args);
    return {total: args.depth === 4 ? 4 : 17};
  });
  assert.equal(result.text, ': repair 4 · plan 17');
  assert.equal(result.reads, 2);
  assert.ok(result.ms >= 0);
  assert.deepEqual(calls, config.inputs.map(profile => ({...profile.selection, workspace: 'fixture', assignee: '', count: true})));
  assert.deepEqual(config, before);
  assert.equal(availabilityLabel({available: result.text, skipped: 3}), 'available: repair 4 · plan 17 · skipped 3');
});

test('tag groups exclude any configured tag and duplicate native queries share one read', async () => {
  const config = normalizeSlots({workspace: 'fixture', workflow: '/path/workflow.yaml',
    selection: {kind: 'work', data: {stage: 'pending'}}, exclude_tags: ['human', 'paused'],
    slots: [{label: 'alpha', data: {area: 'one'}}, {label: 'beta', data: {area: 'one'}}]});
  const calls = [];
  const result = await availableCounts(config, null, null, true, async args => {
    calls.push(args);
    return {total: 12, groups: [{tags: null, count: 2}, {tags: [], count: 3},
      {tags: ['human'], count: 4}, {tags: ['paused', 'human'], count: 3}]};
  });
  assert.equal(result.text, ': alpha 5 · beta 5');
  assert.equal(result.reads, 1);
  assert.deepEqual(calls, [{workspace: 'fixture', kind: 'work', data: {stage: 'pending', area: 'one'},
    assignee: '', group_by: ['tags']}]);
});

test('failed or incomplete counts remain unknown and independent profiles still show their counts', async () => {
  for (const reply of [{}, {total: -1}, {total: 1.5}, {total: 2, groups: [{tags: [], count: 1}]},
    {total: 1, groups: [{count: 1}]}, {total: 1, groups: [{tags: ['ok', 3], count: 1}]}]) {
    const result = await availableCounts({workspace: 'fixture', selection: {kind: 'work'}, exclude_tags: ['human']},
      null, null, true, async () => reply);
    assert.equal(result.text, '?');
  }
  const result = await availableCounts({workspace: 'fixture', inputs: [
    {selection: {kind: 'work', data: {stage: 'repair'}}}, {selection: {kind: 'work', data: {stage: 'plan'}}},
  ]}, null, null, true, async args => {
    if (args.data.stage === 'repair') throw new Error('Unavailable');
    return {total: 17};
  });
  assert.equal(result.text, ': repair ? · plan 17');
  const unknown = await availableCounts({workspace: 'fixture', selection: {kind: 'work'}}, null, null, false, async () => ({total: 4}));
  assert.equal(unknown.text, '?', 'An unconfirmed startup must not inflate the available count');
  assert.equal(availabilityLabel({available: '0'}), 'available 0');
});

test('the dashboard refreshes counts at full capacity and never counts claimed running items', async t => {
  const f = await slotsFixture(t, {concurrency: 1});
  const run = f.start();
  try {
    await run.until(() => f.starts().length === 1);
    const pass = f.starts()[0];
    f.objects.get(pass.address).document.data.assignee = 'crew-planning:fixture';
    fs.writeFileSync(path.join(pass.folder, 'artifacts/claim.json'), JSON.stringify({status: 'confirmed'}));
    await run.until(output => output.includes('available: A 1 · B 1'));
    const {slots, ...single} = f.config;
    f.write(single);
    await run.until(output => output.includes('available 2 · last 30 runs'));
    const start = f.calls.filter(call => call.args.count).length;
    f.objects.get('ac:a3').document.data.stage = 'done';
    await run.until(output => output.includes('available 1 · last 30 runs'));
    assert.ok(f.calls.filter(call => call.args.count).length > start);
    assert.equal(f.starts().length, 1, 'Counting does not bypass the concurrency limit');
    assert.ok(f.calls.filter(call => call.args.count).every(call => call.name === 'joppa_objects' &&
      call.args.assignee === '' && call.args.cursor === undefined && call.args.limit === undefined));
  } finally { await run.stop(); }
});
