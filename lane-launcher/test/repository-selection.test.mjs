import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {nextTask, claimTask} from '../joppa.mjs';
import {configFrom} from '../launcher-config.mjs';
import {save} from '../runtime.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';
import {setup} from '../test-support/launcher.fixture.mjs';

test('one authenticated worker supports the configured lane limit without a project address', async t => {
  const f = await setup(t, {launchLanes: false});
  save(f.configFile, {...f.config, limit: 4});
  const config = configFrom(f.configFile, f.env, {dryRun: true});
  assert.equal(config.limit, 4);
  assert.equal(config.joppa.workers.length, 1);
  assert.equal(Object.hasOwn(config.joppa, 'project'), false);
  assert.equal((await nextTask(config)).candidate.id, 'task:t1');
});

test('repository selection ignores project membership and does not write Tasks', async t => {
  const f = await packageFixture(t);
  delete f.objects.get('task:t1').document.data.projects;
  f.objects.get('task:t2').document.data.projects = ['project:other'];
  // A legacy project setting must not silently restore the removed filter.
  f.run.config.joppa.project = 'project:legacy';
  let selected = await nextTask(f.run.config);
  assert.equal(selected.available, 2);
  assert.equal(selected.candidate.id, 'task:t1');
  f.queue.splice(f.queue.indexOf('task:t1'), 1);
  selected = await nextTask(f.run.config);
  assert.equal(selected.candidate.id, 'task:t2');
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

for (const body of ['Goal: no repository', 'Repository: unknown\nModule: unknown']) {
  test(`an unrelated Task is skipped unchanged: ${body.split('\n')[0]}`, async t => {
    const f = await packageFixture(t), task = f.objects.get('task:t1');
    task.document.data.body = body;
    task.document.parent = 'ac:unavailable';
    const before = structuredClone(task);
    const selected = await nextTask(f.run.config);
    assert.equal(selected.candidate.id, 'task:t2');
    assert.equal(selected.available, 1);
    assert.deepEqual(task, before);
    assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
    assert.equal(f.calls.some(call => call.args.address === 'ac:unavailable'), false);
  });
}

test('held Tasks count only configured repositories regardless of project membership', async t => {
  const f = await packageFixture(t), task = f.objects.get('task:t2');
  task.document.data.assignee = 'another-run';
  task.document.data.projects = ['project:other'];
  task.document.data.body = 'Repository: unknown\nModule: absent';
  let selected = await nextTask(f.run.config);
  assert.equal(selected.held, 0);
  assert.equal(selected.candidate.id, 'task:t1');
  task.document.data.body = 'Repository: app\nModule: absent';
  selected = await nextTask(f.run.config);
  assert.equal(selected.held, 1);
  assert.equal(selected.candidate, null);
});

test('one token worker claims independent Tasks with separate run assignees', async t => {
  const f = await packageFixture(t), config = f.run.config;
  const requirement = structuredClone(f.objects.get('req:r'));
  requirement.address = 'req:other';
  f.objects.set(requirement.address, requirement);
  f.objects.get('ac:a2').document.parent = requirement.address;
  f.run.tasks = [f.run.tasks[0]];
  await claimTask(f.run, f.persist, f.runId);
  fs.mkdirSync(path.join(config.stateDir, 'runs', 'active'), {recursive: true});
  save(path.join(config.stateDir, 'runs', 'active', 'launch.json'), {...f.run, repositoryId: 'app'});
  const selected = await nextTask(config);
  assert.equal(selected.candidate.id, 'task:t2');
  assert.equal(selected.worker.actor, f.run.joppaWorker.actor);
  const second = {...f.run, ...selected.candidate, task: selected.candidate.id,
    taskRevision: selected.candidate.revision, claim: undefined, claimRequest: undefined};
  await claimTask(second, () => {}, '22222222-2222-4222-8222-222222222222');
  const firstHolder = f.objects.get('task:t1').document.data.assignee;
  const secondHolder = f.objects.get('task:t2').document.data.assignee;
  assert.equal(firstHolder, f.run.claim.assignee);
  assert.equal(secondHolder, second.claim.assignee);
  assert.notEqual(firstHolder, secondHolder);
});
