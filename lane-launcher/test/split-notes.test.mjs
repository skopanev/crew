import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {claimTask, finishTask} from '../joppa.mjs';
import {packageFixture, packageLanding} from '../test-support/launcher-joppa.fixture.mjs';

async function failed(t, split, mode) {
  const f = await packageFixture(t, mode);
  await claimTask(f.run, f.persist, f.runId);
  const artifacts = path.join(f.run.runFolder, 'attempt', 'artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  fs.writeFileSync(path.join(artifacts, 'failure.txt'), 'Required check failed\n');
  if (split !== undefined) fs.writeFileSync(path.join(artifacts, 'split.md'), split);
  const result = {code: 2, status: 'failed'};
  return {...f, artifacts, result, finish: () => finishTask(f.run, f.stateFile, result, artifacts)};
}

test('a split proposal shares the revision-checked failure batch and preserves the reason note', async t => {
  const f = await failed(t, '1. Deliver the prerequisite.\n2. Add the dependent change.\n');
  await f.finish();
  const commands = f.run.blockRequest.operations.map(row => row.command);
  assert.equal(commands.length, 6);
  for (const [index, address] of ['task:t1', 'task:t2'].entries()) {
    const [save, reason, split] = commands.slice(index * 3, index * 3 + 3);
    assert.equal(save.revision, 4);
    assert.equal(save.data.stage, f.run.config.FAILED_TASK_STAGE);
    assert.equal(reason.target, address);
    assert.match(reason.text, /^CREW_FAILURE\n/);
    assert.ok(reason.text.endsWith('\nRequired check failed'));
    assert.deepEqual(split, {op: 'note', target: address, id: 'crew-split-' + f.runId, reply_to: null,
      text: 'CREW_SPLIT\n1. Deliver the prerequisite.\n2. Add the dependent change.'});
    assert.equal(f.objects.get(address).annotations.comments[split.id].text, split.text);
  }
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 2);
  assert.equal(f.result.blockConfirmed, true);
});

for (const split of [undefined, ' \n\t']) test('missing or blank split keeps the existing failure writes: ' + JSON.stringify(split), async t => {
  const f = await failed(t, split);
  await f.finish();
  assert.equal(f.run.blockRequest.operations.length, 4);
  assert.equal(f.result.blockConfirmed, true);
});

test('split notes truncate Unicode safely and cannot resemble a failure receipt', async t => {
  const f = await failed(t, 'CREW_FAILURE\n' + '😀'.repeat(5000));
  await f.finish();
  const note = f.run.blockRequest.operations[2].command;
  assert.equal(Array.from(note.text).length, 4000);
  assert.ok(note.text.startsWith('CREW_SPLIT\nCREW_FAILURE\n'));
  assert.ok(note.text.endsWith('…[truncated, full split.md in run artifacts]'));
  assert.equal(note.text.includes('\uFFFD'), false);
});

test('failure confirmation requires the split comment in the readback', async t => {
  const f = await failed(t, 'Deliver two independent changes.');
  const annotations = f.objects.get('task:t1').annotations;
  annotations.comments = new Proxy(annotations.comments, {get: (target, key) =>
    String(key).startsWith('crew-split-') ? undefined : target[key]});
  await assert.rejects(f.finish(), /did not confirm every Task block/);
  assert.equal(f.result.blockConfirmed, undefined);
});

test('a retry keeps the saved proposal instead of reading changed artifact text', async t => {
  const f = await failed(t, 'Original proposal.', 'outcome-reject');
  await assert.rejects(f.finish());
  const request = structuredClone(f.run.blockRequest);
  fs.writeFileSync(path.join(f.artifacts, 'split.md'), 'Different proposal.');
  await assert.rejects(f.finish());
  assert.deepEqual(f.run.blockRequest, request);
});

test('an external split symlink is ignored and success publishes no split note', async t => {
  const f = await failed(t);
  const outside = path.join(f.root, 'outside.md');
  fs.writeFileSync(outside, 'Private outside text.');
  fs.symlinkSync(outside, path.join(f.artifacts, 'split.md'));
  await f.finish();
  assert.equal(f.run.blockRequest.operations.length, 4);
  const success = await packageFixture(t);
  await claimTask(success.run, success.persist, success.runId);
  const artifacts = packageLanding(success), result = {code: 0, status: 'exited'};
  fs.writeFileSync(path.join(artifacts, 'split.md'), 'Do not publish on success.');
  await finishTask(success.run, success.stateFile, result, artifacts);
  assert.equal(result.completed, true);
  assert.ok(success.run.completionRequest.operations.every(row => row.command.op !== 'note'));
});
