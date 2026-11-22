// Ordered native inputs keep their own context and publication policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {flowSettings, nextConfiguredItem} from '../../planning-joppa/queue.mjs';
import {plannerFixture} from '../test-support/config-reload.fixture.mjs';

test('ordered profiles retain scalar filters, skip excluded parents and select later inputs', async t => {
  const f = await plannerFixture(t);
  f.queue.push('task:t1', 'task:t2');
  f.objects.get('ac:a1').document.data.stage = 'to_task';
  f.objects.get('task:t1').document.data.stage = 'to_review';
  f.objects.get('task:t2').document.data.stage = 'to_decide';
  const task = {children: {}, references: [], exclude_children: null,
    related: {limit: 90, parent: {kind: 'ac', exclude_tags: ['hold']}},
    publication: {update_kinds: ['task']}};
  const config = {...f.config, workflow: '/tmp/workflow.yaml', exclude_children: {kind: 'task'}, inputs: [
    {selection: {kind: 'ac', data: {stage: 'to_task'}}, exclude_children: null},
    {...task, selection: {kind: 'task', data: {stage: 'to_review'}}},
    {...task, selection: {kind: 'task', data: {stage: 'to_decide'}}}]};
  const next = skip => nextConfiguredItem(config, config.token_file, undefined, row => skip.includes(row.address));
  assert.equal((await next([])).next.input, 0);
  assert.deepEqual([(await next(['ac:a1'])).next.address, (await next(['ac:a1'])).next.input], ['task:t1', 1]);
  f.objects.get('ac:a1').document.data.tags = ['hold'];
  assert.equal((await next(['ac:a1'])).next.address, 'task:t2');
  f.objects.get('ac:a2').document.data.assignee = 'another-run';
  assert.equal((await next(['ac:a1'])).next, null);
  const queries = f.calls.filter(call => call.name === 'joppa_objects' && !call.args.address);
  assert.ok(queries.every(call => !Array.isArray(call.args.data?.stage)));
  assert.ok(queries.some(call => call.args.data?.stage === 'to_decide'));
  for (const input of [{selection: {kind: 'task'}, workspace: 'foreign'}, {}, null]) {
    assert.throws(() => flowSettings({...config, inputs: [input]}), /native selection profiles/);
  }
});

test('the dispatcher passes the selected profile index without editing its config', async t => {
  const pass = '#!/bin/sh\nprintf \'start %s %s\\n\' "$5" "$PLANNING_JOPPA_INPUT" >> "$TEST_PASSES"\n';
  const f = await plannerFixture(t, {}, 0, pass);
  f.queue.push('task:t2');
  const workflow = path.join(f.root, 'workflow.yaml');
  fs.writeFileSync(workflow, 'nodes: {}\n');
  const config = {...f.config, workflow, inputs: [
    {selection: {kind: 'ac', data: {stage: 'absent'}}},
    {selection: {kind: 'task', data: {stage: 'ready'}}, children: {}, references: [], exclude_children: null}]};
  f.write(config);
  const bytes = fs.readFileSync(f.configFile);
  const run = f.start();
  await run.until(() => f.passes().length > 0);
  assert.equal(f.passes()[0], 'start task:t2 1');
  assert.deepEqual(fs.readFileSync(f.configFile), bytes);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
  assert.equal(await run.stop(), 130);
});
