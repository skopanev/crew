// All acceptance contexts use explicit dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {claimTask, finishTask, guardTaskClaims} from '../joppa.mjs';
import {packageFixture, packageLanding} from '../test-support/launcher-joppa.fixture.mjs';

async function claimed(t, {legacy = false} = {}) {
  const f = await packageFixture(t);
  f.run.tasks = [{address: 'task:t1', revision: 3}];
  await claimTask(f.run, f.persist, f.runId);
  // A receipt written before the criterion flag existed has no flag on any context.
  if (legacy) for (const context of f.run.claim.contexts) delete context.criterion;
  return f;
}

const finish = f => {
  const artifacts = packageLanding(f);
  assert.match(fs.readFileSync(path.join(artifacts, 'landing.txt'), 'utf8'), /^Landed SHA: /m);
  return finishTask(f.run, f.stateFile, {code: 0, status: 'exited'}, artifacts);
};

test('a Requirement context without dependencies does not stop lane startup', async t => {
  const f = await claimed(t);
  const marks = Object.fromEntries(f.run.claim.contexts.map(context => [context.address, context.criterion]));
  assert.deepEqual(marks, {'ac:a1': true, 'req:r': false});
  await guardTaskClaims(f.run, f.persist);
});

for (const legacy of [false, true]) {
  const kind = legacy ? 'an old receipt without the flag' : 'a flagged receipt';
  test(`startup with ${kind}: a Requirement passes, a criterion that is not ready refuses`, async t => {
    const f = await claimed(t, {legacy});
    await guardTaskClaims(f.run, f.persist);
    f.objects.get('ac:a1').document.links = [{relation: 'depends_on', blocking: true, target: 'ac:a2'}];
    await assert.rejects(guardTaskClaims(f.run, f.persist), /DEPENDENCY_NOT_READY|Acceptance context changed/);
  });

  test(`completion with ${kind}: a Requirement passes, a criterion that is not ready refuses`, async t => {
    const f = await claimed(t, {legacy});
    f.objects.get('ac:a1').document.links = [{relation: 'depends_on', blocking: true, target: 'ac:a2'}];
    await assert.rejects(finish(f), /TASK_REVIEW_REQUIRED|context needs review|acceptance context changed/i);
  });

  test(`completion with ${kind} succeeds with a Requirement without dependencies`, async t => {
    const f = await claimed(t, {legacy});
    await finish(f);
  });
}

test('an old receipt without the flag still refuses a covered criterion that is not ready', async t => {
  const f = await packageFixture(t);
  f.run.config.joppa.coversReference = 'covers';
  f.schema.types.task.references = {covers: {multiple: true, target: 'ac'}};
  f.objects.get('task:t1').document.data.covers = ['ac:a2'];
  f.run.tasks = [{address: 'task:t1', revision: 3}];
  await claimTask(f.run, f.persist, f.runId);
  for (const context of f.run.claim.contexts) delete context.criterion;
  await guardTaskClaims(f.run, f.persist);
  f.objects.get('ac:a2').document.links = [{relation: 'depends_on', blocking: true, target: 'ac:a1'}];
  await assert.rejects(guardTaskClaims(f.run, f.persist), /Acceptance context changed/);
});
