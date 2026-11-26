import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {claimTask, finishTask, releaseTaskClaims, nextTask} from '../joppa.mjs';
import {packageFixture, packageLanding} from '../test-support/launcher-joppa.fixture.mjs';

const batches = f => f.calls.filter(call => call.name === 'joppa_batch').map(call => call.args.operations.map(({command}) => command));

test('claim refuses an assigned Task before any write', async t => {
  const f = await packageFixture(t);
  f.objects.get('task:t2').document.data.assignee = 'crew-lane:other-host:22222222-2222-4222-8222-222222222222';
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /TASK_ASSIGNED: task:t2/);
  assert.deepEqual(batches(f), []);
  assert.equal(f.run.claimRequest, undefined);
  assert.equal(f.objects.get('task:t1').document.data.assignee, undefined);
});

test('claim refuses a Task outside the native stage filter and a run without a launch UUID', async t => {
  const f = await packageFixture(t);
  await assert.rejects(claimTask(f.run, f.persist, 'not-a-run'), /launch UUID/);
  f.run.config.joppa.filter = {data: {stage: 'ready'}};
  f.objects.get('task:t1').document.data.stage = 'review';
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /TASK_FILTER_MISMATCH/);
  assert.deepEqual(batches(f), []);
});

test('claim saves the run-specific assignee at the read revision and keeps the actor separately', async t => {
  const f = await packageFixture(t), before = structuredClone(f.objects.get('task:t1').document);
  await claimTask(f.run, f.persist, f.runId);
  const assignee = `crew-lane:${os.hostname()}:${f.runId}`;
  const [claim] = batches(f);
  assert.deepEqual(claim[0], {op: 'save_object', kind: 'task', id: 't1', revision: 3,
    data: {assignee}, reason: 'Take this Task for a Crew lane run.'});
  assert.deepEqual(f.objects.get('task:t1').document.data, {...before.data, assignee});
  assert.equal(f.run.claim.assignee, assignee);
  assert.equal(f.run.claim.actor, 'lane-1');
  assert.equal(f.run.claim.runId, f.runId);
  assert.deepEqual(f.run.claim.tasks.map(task => task.revision), [4, 4]);
});

test('claim shows the coder the live tests of its criterion and accepts a structured Task without checks', async t => {
  const f = await packageFixture(t);
  f.schema.types.check = {role: 'test', parents: ['ac']};
  const node = (address, parent, data, present = true) => f.objects.set(address, {address, kind: 'check', historical: false,
    current_revision: 2, status: {tone: 'green'}, document: {present, parent, data, links: []}, process: {}, annotations: {comments: {}}});
  // More than one page, so the read follows the cursor.
  for (let index = 1; index <= 26; index++) node(`check:c${index}`, 'ac:a1', {title: `suite > case ${index}`});
  node('check:c1', 'ac:a1', {title: 'suite > case 1', body: 'Proves the output.', command: 'bun test suite',
    repository: 'app', reporter_name: 'apps/api/suite.test.ts > suite > case 1'});
  node('check:gone', 'ac:a1', {title: 'suite > archived'}, false);
  node('check:other', 'ac:a2', {title: 'other > case'});
  // A structured Task with steps and no checks, and no acceptance rows: no Crew bindings.
  // Its unmapped repository and module fields do not appear in the rendered contract.
  f.objects.get('task:t2').document.data = {stage: f.objects.get('task:t2').document.data.stage,
    title: '[02] Task 2', body: `Goal: scoped change 2\nRepository: ${f.run.config.repositories[0].id}\nModule: m2`,
    repository: 'other', module: 'm1', steps: ['Make the change.']};
  await claimTask(f.run, f.persist, f.runId);
  const [one, two] = f.run.claim.tasks.map(task => task.ticket);
  assert.equal(one.acceptanceTests.length, 26);
  assert.deepEqual(one.acceptanceTests.find(test => test.address === 'check:c1'), {address: 'check:c1', revision: 2,
    title: 'suite > case 1', body: 'Proves the output.', command: 'bun test suite',
    repository: 'app', reporter_name: 'apps/api/suite.test.ts > suite > case 1'});
  assert.deepEqual(one.acceptanceTests.find(test => test.address === 'check:c2'),
    {address: 'check:c2', revision: 2, title: 'suite > case 2'});
  assert(!one.acceptanceTests.some(test => test.address === 'check:gone'));
  assert.deepEqual(two.acceptanceTests, [{address: 'check:other', revision: 2, title: 'other > case'}]);
  assert.equal(two.body, `Goal: scoped change 2\nRepository: ${f.run.config.repositories[0].id}\nModule: m2\n\nHow:\n1. Make the change.`);
  assert.deepEqual(two.paths, f.run.config.repositories[0].paths);
  assert.equal(two.testAcceptance, undefined);
  // Reading tests writes nothing: the claim is the only batch.
  assert.equal(batches(f).length, 1);
});

test('Tasks of one criterion share one paginated read of its tests', async t => {
  const f = await packageFixture(t);
  f.schema.types.check = {role: 'test', parents: ['ac']};
  for (let index = 1; index <= 26; index++) f.objects.set(`check:c${index}`, {address: `check:c${index}`, kind: 'check',
    historical: false, current_revision: 2, status: {tone: 'green'},
    document: {present: true, parent: 'ac:a1', data: {title: `suite > case ${index}`}, links: []}, process: {}, annotations: {comments: {}}});
  f.objects.get('task:t2').document.parent = 'ac:a1';
  await claimTask(f.run, f.persist, f.runId);
  const [one, two] = f.run.claim.tasks.map(task => task.ticket);
  assert.equal(one.acceptanceTests.length, 26);
  assert.deepEqual(two.acceptanceTests, one.acceptanceTests);
  const reads = f.calls.filter(call => call.name === 'joppa_objects' && call.args.parent === 'ac:a1' &&
    [call.args.kind].flat().includes('check'));
  // Two pages, read once for both Tasks.
  assert.equal(reads.length, 2);
});

test('release clears only the assignee with a revision-checked partial save', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist, f.runId);
  await releaseTaskClaims(f.run, f.persist, 'Lane did not start.');
  const release = batches(f).at(-1);
  assert.deepEqual(release.map(command => [command.op, command.id, command.revision, command.data]),
    [['save_object', 't1', 4, {assignee: null}], ['save_object', 't2', 4, {assignee: null}]]);
  assert(release.every(command => command.reason === 'Lane did not start.'));
  assert.equal(f.objects.get('task:t1').document.data.assignee, undefined);
  assert.equal(f.objects.get('task:t1').document.data.title, '[01] Task 1');
  assert.equal(f.run.releaseConfirmed, true);
  assert.deepEqual(f.run.releaseResults.map(task => [task.address, task.revision]), [['task:t1', 5], ['task:t2', 5]]);
});

test('failure releases, sets the configured stage and notes every Task in one batch', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist, f.runId);
  const artifacts = path.join(f.root, 'artifacts');
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'failure.txt'), 'Required check failed\n');
  const result = {code: 1, status: 'failed'};
  await finishTask(f.run, f.stateFile, result, artifacts);
  const block = batches(f).at(-1), reason = /^Reason: ([A-Z0-9_]+)$/m.exec(block[1].text)[1];
  assert.equal(batches(f).length, 2);
  assert.equal(block[0].data.stage, f.run.config.FAILED_TASK_STAGE);
  for (const [index, address] of ['task:t1', 'task:t2'].entries()) {
    const [save, note] = block.slice(index * 2, index * 2 + 2);
    assert.deepEqual([save.op, `${save.kind}:${save.id}`, save.revision, save.data],
      ['save_object', address, 4, {assignee: null, stage: f.run.config.FAILED_TASK_STAGE}]);
    assert.equal(f.objects.get(address).document.data.stage, f.run.config.FAILED_TASK_STAGE);
    assert.equal(note.op, 'note');
    assert.equal(note.target, address);
    assert.equal(note.text, `CREW_FAILURE\nTask: ${address}\nRun: ${f.runId}\nReason: ${reason}\nRequired check failed`);
    assert.equal(f.run.blockRequest.operations[index * 2 + 1].command.id, note.id);
    assert.equal(f.objects.get(address).annotations.comments[note.id].text, note.text);
  }
  assert.equal(result.blockConfirmed, true);
});

const complete = async (t, mode) => {
  const f = await packageFixture(t, mode);
  await claimTask(f.run, f.persist, f.runId);
  const artifacts = packageLanding(f), result = {code: 0, status: 'exited'};
  const sha = fs.readFileSync(path.join(artifacts, 'landing.txt'), 'utf8').match(/^Landed SHA: (\S+)$/m)[1];
  return {f, artifacts, result, sha, finish: () => finishTask(f.run, f.stateFile, result, artifacts)};
};

test('success saves the commit and done stage and archives at the saved revision in one batch', async t => {
  const {f, result, sha, finish} = await complete(t);
  await finish();
  assert.equal(result.completed, true);
  const [done] = f.calls.filter(call => call.name === 'joppa_batch').slice(-1).map(call => call.args.operations);
  assert.deepEqual(done.map(({ref, command}) => [ref, command.op]),
    [['done0', 'save_object'], [undefined, 'archive_object'], ['done1', 'save_object'], [undefined, 'archive_object']]);
  assert.deepEqual(done[1].command.revision, {$ref: 'done0/saved_revision'});
  assert.deepEqual(done[0].command.data, {assignee: null, commit: sha, stage: 'done'});
  assert(done.every(({command}) => command.op !== 'save_object' || !Object.hasOwn(command, 'question_checked')));
  assert.deepEqual(result.tasks.map(task => [task.address, task.revision]), [['task:t1', 6], ['task:t2', 6]]);
  for (const address of ['task:t1', 'task:t2']) {
    assert.equal(f.objects.get(address).document.present, false);
    assert.equal(f.objects.get(address).document.data.commit, sha);
    assert.equal(f.objects.get(address).document.data.stage, 'done');
  }
});

test('completion uses the configured stage and refuses a legacy request without changing it', async t => {
  const {f, result, finish} = await complete(t);
  f.run.config.DONE_TASK_STAGE = 'closed';
  f.schema.types.task.fields.stage.values.push('closed');
  await finish();
  assert.equal(result.completed, true);
  assert(f.run.completionRequest.operations.filter(({command}) => command.op === 'save_object')
    .every(({command}) => command.data.stage === 'closed'));
  const legacy = await complete(t);
  legacy.f.run.completionRequest = {workspace: 'fixture', request_id: 'legacy', operations: ['t1', 't2'].flatMap((id, index) => [
    {ref: `done${index}`, command: {op: 'save_object', kind: 'task', id, revision: 4,
      data: {assignee: null, commit: legacy.sha}, reason: 'Done'}},
    {command: {op: 'archive_object', target: `task:${id}`, revision: {$ref: `done${index}/saved_revision`}, reason: 'Done'}}])};
  const saved = structuredClone(legacy.f.run.completionRequest);
  const calls = batches(legacy.f).length;
  await assert.rejects(legacy.finish(), /LEGACY_COMPLETION_REQUEST/);
  assert.equal(legacy.result.completed, undefined);
  assert.deepEqual(legacy.f.run.completionRequest, saved);
  assert.equal(batches(legacy.f).length, calls);
  assert(legacy.f.run.tasks.every(task => legacy.f.objects.get(task.address).document.present === true));
  const invalid = await packageFixture(t);
  invalid.schema.types.task.fields.stage.values = ['ready', 'review'];
  await assert.rejects(claimTask(invalid.run, invalid.persist, invalid.runId), /DONE_TASK_STAGE/);
  assert.equal(batches(invalid).length, 0);
});

test('a Task type without a schema question can be claimed and completed', async t => {
  const {f, result, finish} = await complete(t, 'no-question');
  await finish();
  assert.equal(result.completed, true);
  assert(batches(f).flat().filter(command => command.op === 'save_object')
    .every(command => !Object.hasOwn(command, 'question_checked')));
});

for (const [mode, label] of [['wrong-commit', 'a different commit'], ['archive-present', 'a present document'],
  ['archive-historical', 'a historical document'], ['archive-assigned', 'an assigned document'],
  ['archive-missing-commit', 'a missing commit'], ['wrong-stage', 'a different completion stage']]) {
  test(`completion is refused when the archived read shows ${label}`, async t => {
    const {result, finish} = await complete(t, mode);
    await assert.rejects(finish(), /did not confirm every Task completion at the checked SHA/);
    assert.equal(result.completed, undefined);
  });
}

test('failure is not confirmed when the read stage differs from the written stage', async t => {
  const f = await packageFixture(t, 'wrong-stage');
  await claimTask(f.run, f.persist, f.runId);
  const artifacts = path.join(f.root, 'artifacts');
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'failure.txt'), 'Required check failed\n');
  const result = {code: 1, status: 'failed'};
  await assert.rejects(finishTask(f.run, f.stateFile, result, artifacts), /did not confirm every Task block/);
  assert.equal(result.blockConfirmed, undefined);
});

test('a saved completion request without a saved-revision reference is not sent', async t => {
  const {f, sha, finish} = await complete(t);
  const sent = batches(f).length;
  f.run.completionRequest = {workspace: 'fixture', request_id: 'saved', operations: ['t1', 't2'].flatMap((id, index) => [
    {ref: `done${index}`, command: {op: 'save_object', kind: 'task', id, revision: 4,
      data: {assignee: null, commit: sha, stage: 'done'}, reason: 'Done'}},
    {command: {op: 'archive_object', target: `task:${id}`, revision: 5}}])};
  await assert.rejects(finish(), /Saved completion request/);
  assert.equal(batches(f).length, sent);
});

test('a package whose failure batch exceeds 100 operations is refused before API calls', async t => {
  const f = await packageFixture(t);
  f.run.tasks = Array.from({length: 51}, (_, index) => ({address: `task:t${index}`, revision: 3}));
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /100-operation/);
  assert.equal(f.calls.length, 0);
});

for (const stage of [undefined, '', 'unknown', 'done']) {
  test(`an invalid failure stage refuses the claim before writes: ${stage}`, async t => {
    const f = await packageFixture(t);
    f.run.config.FAILED_TASK_STAGE = stage;
    await assert.rejects(claimTask(f.run, f.persist, f.runId), /FAILED_TASK_STAGE/);
    assert.equal(batches(f).length, 0);
    assert.equal(f.objects.get('task:t1').document.data.assignee, undefined);
  });
}

test('an old saved failure request cannot replay a hold write', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist, f.runId);
  f.run.blockRequest = {operations: [{command: {op: 'save_object', kind: 'task', id: 't1',
    revision: 4, data: {assignee: null, hold: 'GATE_FAIL'}}}]};
  const sent = batches(f).length;
  await assert.rejects(finishTask(f.run, f.stateFile, {code: 2}, null), /Saved failure request/);
  assert.equal(batches(f).length, sent);
});
