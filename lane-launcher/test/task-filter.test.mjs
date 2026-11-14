import test from 'node:test';
import assert from 'node:assert/strict';
import {save} from '../runtime.mjs';
import {configFrom} from '../launcher-config.mjs';
import {claimTask, nextTask} from '../joppa.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';
import {setup} from '../test-support/launcher.fixture.mjs';

test('config accepts native project fields and refuses routing or pagination overrides', async t => {
  const f = await setup(t, {launchLanes: false});
  const filter = {data: {decision: {approved: true}, labels: ['selected']}};
  save(f.configFile, {...f.config, joppa: {...f.config.joppa, filter}});
  assert.deepEqual(configFrom(f.configFile, f.env).joppa.filter, filter);
  for (const invalid of [null, [], 'stage', {data: []}, {workspace: 'other'}, {kind: 'source'},
    {fields: ['data']}, {cursor: 'skip'}, {limit: 1}, {address: 'task:t1'}, {ready: true}]) {
    save(f.configFile, {...f.config, joppa: {...f.config.joppa, filter: invalid}});
    assert.throws(() => configFrom(f.configFile, f.env), /joppa.filter must contain only native/);
  }
});

test('native data filtering narrows available Tasks without hiding assigned Tasks or changing their data', async t => {
  const f = await packageFixture(t);
  f.objects.get('task:t1').document.data.stage = 'discuss';
  f.objects.get('task:t2').document.data.stage = 'approved';
  f.objects.get('task:t1').document.data.assignee = 'other-worker';
  const before = structuredClone([...f.objects.values()]);
  f.run.config.joppa.filter = {data: {stage: 'approved'}};
  const result = await nextTask(f.run.config);
  assert.equal(result.candidate.id, 'task:t2');
  assert.equal(result.available, 1);
  assert.equal(result.held, 1);
  assert.deepEqual([...f.objects.values()], before);
  assert.deepEqual(f.calls.find(call => call.args.data)?.args.data, {stage: 'approved'});
  f.run.config.joppa.filter.data.stage = 'missing-project-value';
  const empty = await nextTask(f.run.config);
  assert.equal(empty.available, 0);
  assert.equal(empty.candidate, null);
  assert.equal(empty.held, 1);
});

test('every selected Task must match before the claim writes anything', async t => {
  const f = await packageFixture(t);
  f.run.config.joppa.filter = {data: {stage: 'approved'}};
  f.objects.get('task:t1').document.data.stage = 'approved';
  f.objects.get('task:t2').document.data.stage = 'discuss';
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /TASK_FILTER_MISMATCH: task:t2/);
  assert(!f.calls.some(call => call.name === 'joppa_batch'));
  assert.equal(f.run.claimRequest, undefined);
});

test('a stage edit during the filtered read or the atomic save prevents a claim', async t => {
  for (const at of ['beforeFilter', 'beforeWrite']) {
    const f = await packageFixture(t);
    f.run.tasks = [f.run.tasks[0]];
    f.run.config.joppa.filter = {data: {stage: 'approved'}};
    f.objects.get('task:t1').document.data.stage = 'approved';
    f.batch[at] = () => {
      delete f.batch[at];
      const task = f.objects.get('task:t1');
      task.document.data.stage = 'discuss';
      task.current_revision++;
    };
    await assert.rejects(claimTask(f.run, f.persist, f.runId), /TASK_FILTER_MISMATCH|revision changed/);
    assert.equal(f.objects.get('task:t1').document.data.assignee, undefined);
    assert.equal(f.run.claim, undefined);
  }
});
