// Only criterion contexts carry readiness; Joppa reports a Requirement as not work ready by design.
import test from 'node:test';
import assert from 'node:assert/strict';
import {claimTask, guardTaskClaims} from '../joppa.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';

test('a Requirement context with work_ready false does not stop lane startup', async t => {
  const f = await packageFixture(t);
  f.run.tasks = [{address: 'task:t1', revision: 3}];
  f.objects.get('req:r').work_ready = false;
  await claimTask(f.run, f.persist, f.runId);
  const marks = Object.fromEntries(f.run.claim.contexts.map(context => [context.address, context.criterion === true]));
  assert.deepEqual(marks, {'ac:a1': true, 'req:r': false});
  await guardTaskClaims(f.run, f.persist);
});

test('a criterion context that stops being work ready still stops lane startup', async t => {
  const f = await packageFixture(t);
  f.run.tasks = [{address: 'task:t1', revision: 3}];
  f.objects.get('req:r').work_ready = false;
  await claimTask(f.run, f.persist, f.runId);
  f.objects.get('ac:a1').work_ready = false;
  await assert.rejects(guardTaskClaims(f.run, f.persist), /Acceptance context changed/);
});
