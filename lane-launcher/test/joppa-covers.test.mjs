// A covering Task claims only when each covered criterion is live, unheld and ready.
import test from 'node:test';
import assert from 'node:assert/strict';
import {claimTask, guardTaskClaims} from '../joppa.mjs';
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
  await claimTask(f.run, f.persist, f.runId);
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
  assert.throws(() => validateJoppa({joppa: {url: 'http://localhost', project: 'project:p', coversReference: ' ',
    mcpCommand: ['node'], workers: [{actor: 'a'}]}, limit: 1}), /coversReference/);
});
