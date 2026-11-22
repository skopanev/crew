import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {nextTask, claimTask, taskInput} from '../joppa.mjs';
import {configFrom} from '../launcher-config.mjs';
import {save} from '../runtime.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';
import {setup} from '../test-support/launcher.fixture.mjs';

test('repository paths apply regardless of missing or historical Module text', async t => {
  const f = await setup(t, {launchLanes: false}), object = f.joppa.objects.get('task:t1');
  const original = structuredClone(object.document.data);
  for (const declaration of ['', '\nModule: unknown', '\nModule: first\nModule: second']) {
    object.document.data = {...original, body: 'Goal: change\nRepository: app' + declaration};
    const before = structuredClone(object);
    const {ticket} = taskInput(f.config, object);
    assert.deepEqual(ticket.paths, f.config.repositories[0].paths);
    assert.equal(Object.hasOwn(ticket, 'module'), false);
    assert.equal(Object.hasOwn(ticket, 'moduleId'), false);
    const selection = await nextTask(f.config);
    assert.equal(selection.candidate.id, object.address);
    assert(!selection.selectionIssues?.some(issue => issue.task === object.address));
    assert.deepEqual(object, before);
  }
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

test('taskFields maps only repository labels or data paths', async t => {
  const f = await setup(t, {launchLanes: false}), object = f.joppa.objects.get('task:t1');
  const original = structuredClone(object.document.data), base = structuredClone(f.config);
  const load = raw => { save(f.configFile, raw); return configFrom(f.configFile, f.env, {dryRun: true}); };
  const legacy = structuredClone(base);
  legacy.repositories[0].modules = [{name: 'old', paths: legacy.repositories[0].paths}];
  delete legacy.repositories[0].paths;
  assert.throws(() => load(legacy), /Replace modules\[\]\.paths with repositories\[\]\.paths/);
  const input = (config, data) => { object.document.data = {...original, ...data}; return taskInput(config, object).ticket; };
  const whole = load({...base, taskFields: undefined});
  assert.equal(input(whole, {body: 'Goal: change\nRepository: other'}).repository, 'app');
  const ignored = input(whole, {body: 'Goal: change', repository: 'other', module: 'unknown', steps: ['Make the change.']});
  assert.deepEqual([ignored.repository, ignored.body], ['app', 'Goal: change\n\nHow:\n1. Make the change.']);
  const mapped = load({...base, taskFields: {repository: 'data:repository'}});
  assert.throws(() => input(mapped, {body: 'Goal: change', repository: 'other'}), /not configured or not unique/);
  const custom = load({...base, taskFields: {repository: 'body:Target repo'}});
  assert.equal(input(custom, {body: 'Goal: change\nTarget repo: app'}).repository, 'app');
  assert.throws(() => input(custom, {body: 'Target repo: app\nTarget repo: app'}), /ambiguous/);
  const two = {...custom, taskFields: undefined, repositories: [...custom.repositories, {...custom.repositories[0], id: 'other'}]};
  object.document.data = {...original, body: 'Goal: change'};
  assert.notEqual((await nextTask(two)).candidate?.id, object.address);
  assert.throws(() => taskInput(two, object), /not configured or not unique/);
  for (const taskFields of [{repository: 'Repository'}, {repository: 'body:'}, {module: 'data:module'}, {other: 'body:X'}]) {
    assert.throws(() => load({...base, taskFields}), /taskFields maps repository/);
  }
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

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
    // With a second repository, a Task without a repository value has no sole choice.
    f.run.config.repositories.push({...f.run.config.repositories[0], id: 'other'});
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

test('filtered Tasks report missing repository choices and preserve literal matching', async t => {
  const f = await packageFixture(t), task = f.objects.get('task:t1');
  f.run.config.joppa.filter = {data: {stage: 'ready'}};
  f.objects.get('task:t2').document.data.body += '\nTarget repo: app';
  const original = structuredClone(task.document.data);
  for (const declaration of ['Repository: app.', 'Repository: app,', 'Repository: app. Module: core',
    'Repository: unknown', 'Repo: app', 'Target repo: app.']) {
    f.run.config.taskFields = {repository: declaration.startsWith('Target repo:') ? 'body:Target repo' : 'body:Repository'};
    task.document.data = {...original, body: 'Goal: scoped change\n' + declaration};
    const before = structuredClone(task);
    const selected = await nextTask(f.run.config);
    assert.equal(selected.candidate.id, 'task:t2');
    assert.equal(selected.available, 1);
    assert.deepEqual(selected.selectionIssues, [{task: task.address, revision: task.current_revision,
      code: 'REPOSITORY_MISSING', message: declaration.startsWith('Repo:')
        ? 'No configured repository matches "Repository: (missing)".'
        : `No configured repository matches ${JSON.stringify(declaration)}.`}]);
    assert.deepEqual(task, before);
  }
  task.document.data = {...original, stage: 'done', body: 'Repo: app'};
  f.run.config.taskFields = {repository: 'body:Repository'};
  assert.deepEqual((await nextTask(f.run.config)).selectionIssues, []);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

test('an ambiguous filtered repository reports an issue without stopping selection', async t => {
  const f = await packageFixture(t), task = f.objects.get('task:t1');
  f.run.config.joppa.filter = {data: {stage: 'ready'}};
  task.document.data.body = 'Goal: scoped change\nRepository: app\nRepository: app';
  const before = structuredClone(task);
  const selected = await nextTask(f.run.config);
  assert.equal(selected.candidate.id, 'task:t2');
  assert.equal(selected.available, 1);
  assert.deepEqual(selected.selectionIssues, [{task: task.address, revision: task.current_revision,
    code: 'CANDIDATE_INVALID', message: 'Task repository declaration is ambiguous'}]);
  assert.deepEqual(task, before);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

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
  assert.equal(selected.candidate.id, 'task:t1');
});

test('unrelated structured contracts do not need executable steps or checks', async t => {
  const f = await packageFixture(t), task = f.objects.get('task:t1');
  f.run.config.taskFields = {repository: 'data:repository'};
  Object.assign(task.document.data, {body: 'External work', repository: 'unknown', steps: [], checks: []});
  task.document.parent = 'ac:unavailable';
  for (const assignee of [undefined, 'another-run']) {
    task.document.data.assignee = assignee;
    const selected = await nextTask(f.run.config);
    assert.equal(selected.candidate.id, 'task:t2');
    assert.equal(selected.held, 0);
  }
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
  assert.equal(f.calls.some(call => call.args.address === 'ac:unavailable'), false);
});

test('a missing structured repository does not invent a second declaration for an assigned Task', async t => {
  const f = await packageFixture(t), task = f.objects.get('task:t2');
  Object.assign(task.document.data, {steps: [], assignee: 'another-run'});
  const selected = await nextTask(f.run.config);
  assert.equal(selected.held, 1);
  assert.equal(selected.candidate.id, 'task:t1');
});

for (const state of ['archived after list', 'without Requirement', 'archived parent']) {
  for (const phase of ['selection', 'claim guard']) test(`${phase} ignores an assigned Task ${state}`, async t => {
    const f = await packageFixture(t), task = f.objects.get('task:t2');
    task.document.data.assignee = 'another-run';
    if (state === 'archived after list') {
      let reads = 0;
      Object.defineProperty(task.document, 'present', {get: () => ++reads === 1});
    }
    if (state === 'without Requirement') task.document.parent = null;
    if (state === 'archived parent') f.objects.get('ac:a2').document.present = false;
    if (phase === 'selection') {
      const selected = await nextTask(f.run.config);
      assert.equal(selected.candidate.id, 'task:t1');
      assert.equal(selected.held, state === 'archived after list' ? 0 : 1);
      assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
    } else {
      f.run.tasks = [f.run.tasks[0]];
      await claimTask(f.run, f.persist, f.runId);
      assert.equal(f.run.releaseRequest, undefined);
      assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 1);
    }
  });
}

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
