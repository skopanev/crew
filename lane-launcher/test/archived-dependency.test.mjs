import test from 'node:test';
import assert from 'node:assert/strict';
import {nextTask} from '../joppa.mjs';
import {dependencyCheck} from '../dependencies.mjs';
import {claimTask} from '../joppa-claims.mjs';
import {guardPublications} from '../publication-guard.mjs';
import {fixture} from '../test-support/requirement-delivery.fixture.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';

test('an archived prerequisite without a commit returns the consumer before claim or Docker', async t => {
  const f = await packageFixture(t);
  f.queue.splice(0, 1);
  const task = f.objects.get('task:t1'), parent = f.objects.get('ac:a1');
  task.document.data.returns = 2;
  parent.document.data.returns = 1;
  const dependency = structuredClone(f.objects.get('task:t2'));
  dependency.address = 'task:old';
  dependency.document.present = false;
  dependency.document.data.stage = 'review';
  const before = structuredClone(dependency);
  f.objects.set(dependency.address, dependency);
  task.document.links = [{relation: 'depends_on', blocking: true, target: dependency.address}];
  for (const inherited of [false, true]) {
    task.document.data.stage = 'ready';
    task.document.links = inherited ? [] : [{relation: 'depends_on', blocking: true, target: dependency.address}];
    parent.document.links = inherited ? [{relation: 'depends_on', blocking: true, target: dependency.address}] : [];
    const selected = await nextTask(f.run.config);
    assert.equal(selected.candidate, null);
    assert.equal(task.document.data.stage, f.run.config.FAILED_TASK_STAGE);
    const writes = f.calls.filter(call => call.name === 'joppa_batch').flatMap(call => call.args.operations);
    assert(writes.some(({command}) => command.op === 'note' && /DEPENDENCY_REPLAN: task:old/.test(command.text)));
    assert(writes.filter(({command}) => command.op === 'save_object')
      .every(({command}) => Object.keys(command.data).length === 1 && command.data.stage === f.run.config.FAILED_TASK_STAGE));
  }
  assert.equal(task.document.data.stage, f.run.config.FAILED_TASK_STAGE);
  assert.equal(task.document.data.assignee, undefined);
  assert.equal(task.document.data.returns, 2);
  assert.equal(parent.document.data.returns, 1);
  assert.deepEqual(f.objects.get(dependency.address), before);
});

test('readiness blocks an archived task without a commit and claim cannot acquire it', async t => {
  const f = fixture(), task = f.objects.get('work:two');
  f.objects.get('work:one').document.links = [{relation: 'depends_on', blocking: true, target: task.address}];
  delete task.document.data.commit;
  assert.deepEqual(await dependencyCheck(f.read)('work:one'),
    {ready: false, blocker: task.address, code: 'DEPENDENCY_REPLAN'});
  task.document.data.commit = `repo ${'a'.repeat(40)}`;
  assert.deepEqual(await dependencyCheck(f.read)('work:one'), {ready: true, blocker: null});

  const p = await packageFixture(t), prerequisite = p.objects.get('task:t2');
  prerequisite.document.present = false;
  p.objects.get('task:t1').document.links = [{relation: 'depends_on', blocking: true, target: prerequisite.address}];
  p.run.tasks = [{address: 'task:t1', revision: 3}];
  await assert.rejects(claimTask(p.run, p.persist, p.runId), /DEPENDENCY_NOT_READY: task:t2/);
  assert.equal(p.calls.some(call => call.name === 'joppa_batch'), false);
});

test('an archived prerequisite still needs its recorded commit on the delivery branch', async () => {
  const f = fixture(), task = f.objects.get('work:two');
  f.objects.get('work:one').document.links = [{relation: 'depends_on', blocking: true, target: task.address}];
  const run = {...f.run, repository: {id: 'repo'}};
  let reads = 0;
  const ancestor = async () => { reads++; return false; };
  delete task.document.data.commit;
  await assert.rejects(guardPublications(run, f.read, ancestor), {code: 'DEPENDENCY_REPLAN'});
  assert.equal(reads, 0);
  task.document.data.commit = `repo ${'a'.repeat(40)}`;
  await assert.rejects(guardPublications(run, f.read, ancestor), {code: 'DEPENDENCY_NOT_LANDED'});
  assert.equal(reads, 1);
  assert.deepEqual(await guardPublications(run, f.read, async () => true), {needsReader: false});
});

test('a dependency return cannot overwrite a Task claimed after selection', async t => {
  const f = await packageFixture(t), task = f.objects.get('task:t1');
  f.queue.splice(0, 1);
  const prerequisite = f.objects.get('task:t2');
  prerequisite.document.present = false;
  task.document.links = [{relation: 'depends_on', blocking: true, target: prerequisite.address}];
  f.batch.beforeWrite = () => {
    task.document.data.assignee = 'another-run';
    task.current_revision++;
  };
  await assert.rejects(nextTask(f.run.config), /revision changed/);
  assert.equal(task.document.data.stage, 'ready');
  assert.equal(task.document.data.assignee, 'another-run');
  assert.deepEqual(task.annotations.comments, {});
  assert.equal(prerequisite.document.present, false);
});
