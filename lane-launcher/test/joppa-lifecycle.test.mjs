import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {claimTask, finishTask, releaseTaskClaims} from '../joppa.mjs';
import {packageFixture, packageLanding} from '../test-support/launcher-joppa.fixture.mjs';

const batches = f => f.calls.filter(call => call.name === 'joppa_batch').map(call => call.args.operations.map(({command}) => command));
const question = 'Which change does this Task make?';

test('claim refuses an assigned Task before any write', async t => {
  const f = await packageFixture(t);
  f.objects.get('task:t2').document.data.assignee = 'crew-lane:other-host:22222222-2222-4222-8222-222222222222';
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /TASK_ASSIGNED: task:t2/);
  assert.deepEqual(batches(f), []);
  assert.equal(f.run.claimRequest, undefined);
  assert.equal(f.objects.get('task:t1').document.data.assignee, undefined);
});

test('claim refuses a waiting Task and a run without a launch UUID', async t => {
  const f = await packageFixture(t);
  await assert.rejects(claimTask(f.run, f.persist, 'not-a-run'), /launch UUID/);
  f.objects.get('task:t1').process = {assessment: {state: 'waiting', reason: 'GATE_FAIL'}};
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /TASK_WAITING: task:t1/);
  assert.deepEqual(batches(f), []);
});

test('claim saves the run-specific assignee at the read revision and keeps the actor separately', async t => {
  const f = await packageFixture(t), before = structuredClone(f.objects.get('task:t1').document);
  await claimTask(f.run, f.persist, f.runId);
  const assignee = `crew-lane:${os.hostname()}:${f.runId}`;
  const [claim] = batches(f);
  assert.deepEqual(claim[0], {op: 'save_object', kind: 'task', id: 't1', revision: 3, parent: before.parent,
    data: {...before.data, assignee}, links: before.links, reason: 'Take this Task for a Crew lane run.', question_checked: question});
  assert.equal(f.run.claim.assignee, assignee);
  assert.equal(f.run.claim.actor, 'lane-1');
  assert.equal(f.run.claim.runId, f.runId);
  assert.deepEqual(f.run.claim.tasks.map(task => task.revision), [4, 4]);
});

test('release removes only the assignee with a revision-checked save', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist, f.runId);
  await releaseTaskClaims(f.run, f.persist, 'Lane did not start.');
  const release = batches(f).at(-1);
  assert.deepEqual(release.map(command => [command.op, command.id, command.revision, Object.hasOwn(command.data, 'assignee')]),
    [['save_object', 't1', 4, false], ['save_object', 't2', 4, false]]);
  assert(release.every(command => command.reason === 'Lane did not start.' && command.question_checked === question));
  assert.equal(f.objects.get('task:t1').document.data.title, '[01] Task 1');
  assert.equal(f.run.releaseConfirmed, true);
  assert.deepEqual(f.run.releaseResults.map(task => [task.address, task.revision]), [['task:t1', 5], ['task:t2', 5]]);
});

test('failure releases, assesses and notes every Task in one batch', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist, f.runId);
  const artifacts = path.join(f.root, 'artifacts');
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'failure.txt'), 'Required check failed\n');
  const result = {code: 1, status: 'failed'};
  await finishTask(f.run, f.stateFile, result, artifacts);
  const block = batches(f).at(-1), reason = block[1].reason;
  assert.equal(batches(f).length, 2);
  assert.match(reason, /^[A-Z0-9_]+$/);
  for (const [index, address] of ['task:t1', 'task:t2'].entries()) {
    const [save, assess, note] = block.slice(index * 3, index * 3 + 3);
    assert.deepEqual([save.op, `${save.kind}:${save.id}`, save.revision, Object.hasOwn(save.data, 'assignee')],
      ['save_object', address, 4, false]);
    assert.deepEqual(assess, {op: 'assess', target: address, ready: false, reason});
    assert.equal(note.op, 'note');
    assert.equal(note.target, address);
    assert.equal(note.text, `CREW_FAILURE\nTask: ${address}\nRun: ${f.runId}\nReason: ${reason}\nRequired check failed`);
    assert.equal(f.run.blockRequest.operations[index * 3 + 2].command.id, note.id);
    assert.equal(f.objects.get(address).annotations.comments[note.id].text, note.text);
  }
  assert.equal(result.blockConfirmed, true);
});

test('success saves the commit and archives each Task in one batch and checks the receipts', async t => {
  const f = await packageFixture(t, 'wrong-commit');
  await claimTask(f.run, f.persist, f.runId);
  const artifacts = packageLanding(f), result = {code: 0, status: 'exited'};
  await assert.rejects(finishTask(f.run, f.stateFile, result, artifacts), /did not confirm every Task completion/);
  assert.equal(result.completed, undefined);
  const done = batches(f).at(-1);
  assert.deepEqual(done.map(command => command.op), ['save_object', 'archive_object', 'save_object', 'archive_object']);
  assert.equal(done[1].revision, done[0].revision + 1);
});

test('success archives every Task at the revision after its commit save', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist, f.runId);
  const result = {code: 0, status: 'exited'};
  await finishTask(f.run, f.stateFile, result, packageLanding(f));
  assert.equal(result.completed, true);
  assert.deepEqual(result.tasks.map(task => [task.address, task.revision]), [['task:t1', 5], ['task:t2', 5]]);
  assert(['task:t1', 'task:t2'].every(address => f.objects.get(address).document.data.archived === true));
});

test('a saved completion request with a wrong archive revision is not sent', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist, f.runId);
  const artifacts = packageLanding(f), sent = batches(f).length;
  const sha = fs.readFileSync(path.join(artifacts, 'landing.txt'), 'utf8').match(/^Landed SHA: (\S+)$/m)[1];
  f.run.completionRequest = {workspace: 'fixture', request_id: 'saved', operations: ['t1', 't2'].flatMap(id => [
    {command: {op: 'save_object', kind: 'task', id, revision: 4, data: {commit: sha}}},
    {command: {op: 'archive_object', target: `task:${id}`, revision: 4}}])};
  await assert.rejects(finishTask(f.run, f.stateFile, {code: 0, status: 'exited'}, artifacts), /Saved completion request/);
  assert.equal(batches(f).length, sent);
});

test('a package whose failure batch exceeds 100 operations is refused before API calls', async t => {
  const f = await packageFixture(t);
  f.run.tasks = Array.from({length: 34}, (_, index) => ({address: `task:t${index}`, revision: 3}));
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /100-operation/);
  assert.equal(f.calls.length, 0);
});
