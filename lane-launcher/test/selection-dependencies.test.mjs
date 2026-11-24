import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {flowSettings, nextConfiguredItem} from '../../planning-joppa/queue.mjs';
import {plannerFixture} from '../test-support/config-reload.fixture.mjs';

test('pending prerequisites create no run and become selectable when the prerequisite changes', async t => {
  const f = await plannerFixture(t); f.queue.push('task:t1');
  const task = f.objects.get('task:t1'), prerequisite = f.objects.get('task:t2');
  const link = {relation: 'depends_on', blocking: true, target: prerequisite.address};
  const config = {...f.config, workflow: '/tmp/workflow.yaml', inputs: [
    {selection: {kind: 'ac', data: {stage: 'absent'}}},
    {selection: {kind: 'task', data: {stage: 'ready'}}, wait_for_dependencies: true},
  ]};
  for (const inherited of [false, true]) {
    task.document.links = inherited ? [] : [link];
    f.objects.get('ac:a1').document.links = inherited ? [link] : [];
    prerequisite.document.data.stage = 'ready';
    for (let pass = 0; pass < 3; pass++) {
      const result = await nextConfiguredItem(config, config.token_file);
      assert.equal(result.next, null); assert.equal(result.filtered, 1);
    }
    const originalRevision = task.current_revision;
    prerequisite.document.data.stage = 'done'; prerequisite.current_revision++;
    assert.equal((await nextConfiguredItem(config, config.token_file)).next.address, task.address);
    assert.equal(task.current_revision, originalRevision);
  }
  assert.equal(f.calls.some(call => call.name === 'joppa_batch' || call.name === 'joppa_command'), false);
  assert.equal(fs.existsSync(config.runs_folder), false);
  assert.deepEqual(f.passes(), []);
  for (const value of ['true', 1, null]) assert.throws(() => flowSettings({...config, wait_for_dependencies: value}), /boolean/);
});

test('archived prerequisites enter repair while the optional guard preserves other profiles and native task roles', async t => {
  const f = await plannerFixture(t);
  f.schema.types.work = {...f.schema.types.task};
  const task = structuredClone(f.objects.get('task:t1')), prerequisite = structuredClone(f.objects.get('task:t2'));
  task.address = 'work:consumer'; task.kind = 'work';
  prerequisite.address = 'work:provider'; prerequisite.kind = 'work'; prerequisite.document.data.stage = 'pending';
  task.document.links = [{relation: 'depends_on', blocking: true, target: prerequisite.address}];
  f.objects.set(task.address, task); f.objects.set(prerequisite.address, prerequisite);
  const config = {...f.config, workflow: '/tmp/workflow.yaml', selection: {kind: 'work', data: {stage: 'ready'}}};
  assert.equal((await nextConfiguredItem(config, config.token_file)).next.address, task.address);
  config.wait_for_dependencies = true;
  assert.equal((await nextConfiguredItem(config, config.token_file)).next, null);
  prerequisite.document.present = false;
  assert.equal((await nextConfiguredItem(config, config.token_file)).next.address, task.address);
  task.document.data.commit = 'b'.repeat(40);
  assert.equal((await nextConfiguredItem(config, config.token_file)).next, null);
  delete task.document.data.commit;
  prerequisite.document.data.commit = 'a'.repeat(40);
  assert.equal((await nextConfiguredItem(config, config.token_file)).next.address, task.address);
  task.document.data.assignee = 'other-run';
  assert.equal((await nextConfiguredItem(config, config.token_file)).next, null);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch' || call.name === 'joppa_command'), false);
  assert.equal(fs.existsSync(config.runs_folder), false);
});
