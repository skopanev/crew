// A covering Task claims only when each covered criterion is live, unheld and ready.
import test from 'node:test';
import assert from 'node:assert/strict';
import {claimTask, guardTaskClaims, nextTask} from '../joppa.mjs';
import {coversSpec, taskCovers} from '../joppa-covers.mjs';
import {validateJoppa} from '../joppa-config.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';

async function covering(t) {
  const f = await packageFixture(t);
  f.run.config.joppa.coversReference = 'covers';
  f.schema.types.task.references = {covers: {multiple: true, target: 'ac'}};
  // Joppa keeps a typed reference as sent. A bare ID reads as the criterion address.
  f.objects.get('task:t1').document.data.covers = ['a2'];
  f.run.tasks = [{address: 'task:t1', revision: 3}];
  return f;
}

const batches = f => f.calls.filter(call => call.name === 'joppa_batch');

test('covering Task records each covered criterion as acceptance context', async t => {
  const f = await covering(t);
  // An acceptance row can name a covered criterion with one of the Task checks.
  Object.assign(f.objects.get('task:t1').document.data, {checks: ['Show => shown'],
    acceptance_checks: [{ac: 'ac:a2', check: 'Show => shown'}]});
  await claimTask(f.run, f.persist, f.runId);
  assert.deepEqual(f.run.claim.ticket.testAcceptance, [{ac: 'ac:a2', check: 'Show => shown'}]);
  assert.deepEqual(f.run.claim.tasks[0].covers, ['ac:a2']);
  assert.deepEqual(f.run.claim.contexts.map(context => context.address), ['ac:a1', 'req:r', 'ac:a2']);
  assert.equal(f.run.claim.ticket.coveredContexts[0].address, 'ac:a2');
  await guardTaskClaims(f.run, f.persist);
  f.objects.get('ac:a2').work_ready = false;
  await assert.rejects(guardTaskClaims(f.run, f.persist), /Acceptance context changed/);
});

for (const [name, change] of [
  ['held by a planner', ac => { ac.document.data.assignee = 'crew-planning:host:run'; }],
  ['waiting', ac => { ac.process.assessment = {state: 'waiting', reason: 'NEEDS_HUMAN'}; }],
  ['not work ready', ac => { ac.work_ready = false; }],
  ['in another Requirement', ac => { ac.document.parent = 'req:other'; }],
]) test(`covering Task is not claimed when the covered criterion is ${name}`, async t => {
  const f = await covering(t);
  if (name.includes('Requirement')) f.objects.set('req:other', {...structuredClone(f.objects.get('req:r')), address: 'req:other'});
  change(f.objects.get('ac:a2'));
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /COVERED_CONTEXT_NOT_READY: .*no Tasks claimed/);
  assert.equal(batches(f).length, 0);
});

test('a covered criterion that changes during the claim releases the claimed Tasks', async t => {
  const f = await covering(t);
  const task = f.objects.get('task:t1'), ac = f.objects.get('ac:a2');
  delete ac.work_ready;
  Object.defineProperty(ac, 'work_ready', {enumerable: true, get: () => !task.document.data.assignee});
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /COVERED_CONTEXT_NOT_READY: ac:a2 is not work ready; this run released/);
  assert.equal(batches(f).length, 2);
  assert.equal(f.run.releaseConfirmed, true);
  assert.equal(task.document.data.assignee, undefined);
});

test('covers reference must target several criteria and is ignored when not configured', () => {
  const types = {ac: {role: 'ac'}, doc: {role: 'document'},
    task: {role: 'task', references: {covers: {multiple: true, target: 'ac'}, one: {multiple: false, target: 'ac'},
      docs: {multiple: true, target: 'doc'}}}};
  assert.equal(coversSpec({joppa: {}}, types, 'task'), null);
  assert.deepEqual(coversSpec({joppa: {coversReference: 'covers'}}, types, 'task'), {field: 'covers', target: 'ac'});
  for (const field of ['one', 'docs', 'missing']) {
    assert.throws(() => coversSpec({joppa: {coversReference: field}}, types, 'task'), /must list several criteria/);
  }
  const object = {document: {parent: 'ac:a1', data: {covers: ['a1', 'a2', 'ac:a2', 'ac:a3']}}};
  assert.deepEqual(taskCovers({field: 'covers', target: 'ac'}, object), ['ac:a2', 'ac:a3']);
  assert.throws(() => taskCovers({field: 'covers', target: 'ac'}, {document: {data: {covers: 'ac:a2'}}}), /list of criterion/);
  for (const field of [' ', 'acceptance', 'acceptance_checks', 'test_bindings']) {
    assert.throws(() => validateJoppa({joppa: {url: 'http://localhost', project: 'project:p', coversReference: field,
      mcpCommand: ['node'], workers: [{actor: 'a'}]}, limit: 1}), /coversReference/);
  }
});

test('selection keeps a shared Task with parent and covered acceptance rows, and the claim still guards the covered AC', async t => {
  // crew/pm reproduction on 2ab46f3: selection skipped this Task as BINDING_INVALID and wrote nothing.
  const f = await covering(t);
  f.queue.splice(0, f.queue.length, 'task:t1');
  Object.assign(f.objects.get('task:t1').document.data, {covers: ['ac:a2'], checks: ['own check', 'covered check'],
    acceptance_checks: [{ac: 'ac:a1', check: 'own check'}, {ac: 'ac:a2', check: 'covered check'}]});
  const selected = (await nextTask(f.run.config)).candidate;
  assert.deepEqual(selected.tasks.map(task => task.address), ['task:t1']);
  assert.equal(batches(f).length, 0);
  Object.assign(f.run, {task: selected.id, taskRevision: selected.revision, tasks: selected.tasks});
  f.objects.get('ac:a2').document.data.assignee = 'crew-planning:host:run';
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /COVERED_CONTEXT_NOT_READY: ac:a2 is held/);
  delete f.objects.get('ac:a2').document.data.assignee;
  await claimTask(f.run, f.persist, f.runId);
  assert.deepEqual(f.run.claim.ticket.testAcceptance,
    [{ac: 'ac:a1', check: 'own check'}, {ac: 'ac:a2', check: 'covered check'}]);
  assert.deepEqual(f.run.claim.contexts.map(context => context.address), ['ac:a1', 'req:r', 'ac:a2']);
});

test('selection skips a Task whose acceptance names a criterion outside its parent and covers', async t => {
  const f = await covering(t);
  Object.assign(f.objects.get('task:t1').document.data, {checks: ['Run one => ok'],
    acceptance_checks: [{ac: 'ac:foreign', check: 'Run one => ok'}]});
  const selected = (await nextTask(f.run.config)).candidate;
  assert.notEqual(selected?.tasks?.[0]?.address, 'task:t1');
});

test('the fixture applies the native data.acceptance rule; acceptance_checks and covers saves pass', async t => {
  const f = await covering(t);
  f.run.tasks = [{address: 'task:t1', revision: 3}];
  Object.assign(f.objects.get('task:t1').document.data, {checks: ['own check'],
    acceptance_checks: [{ac: 'ac:a1', check: 'own check'}], acceptance: [{ac: 'ac:a1', check: 'own check'}]});
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /operation 1: use process commands for acceptance/);
  const fresh = await covering(t);
  Object.assign(fresh.objects.get('task:t1').document.data, {checks: ['own check'],
    acceptance_checks: [{ac: 'ac:a1', check: 'own check'}]});
  await claimTask(fresh.run, fresh.persist, fresh.runId);
  assert.deepEqual(fresh.objects.get('task:t1').document.data.covers, ['a2']);
  assert.equal(fresh.objects.get('task:t1').document.data.assignee, fresh.run.claim.assignee);
});
