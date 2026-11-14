import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {nextTask, claimTask, taskInput} from '../joppa.mjs';
import {configFrom} from '../launcher-config.mjs';
import {save} from '../runtime.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';
import {setup} from '../test-support/launcher.fixture.mjs';

test('missing Module uses the only module or the whole repository, while explicit scope stays strict', async t => {
  const f = await setup(t, {launchLanes: false}), object = f.joppa.objects.get('task:t1');
  const original = structuredClone(object.document.data);
  for (const modules of [undefined, [f.config.repositories[0].modules[0]]]) {
    const raw = structuredClone(f.config);
    if (modules === undefined) delete raw.repositories[0].modules;
    else raw.repositories[0].modules = modules;
    save(f.configFile, raw);
    const config = configFrom(f.configFile, f.env, {dryRun: true});
    const expected = modules?.[0] ?? {name: 'app', path: '.'};
    for (const structured of [false, true]) {
      object.document.data = {...original, body: structured ? 'Goal: required change' : 'Goal: required change\nRepository: app',
        ...(structured ? {repository: 'app', steps: ['Make the required change.']} : {})};
      const before = structuredClone(object);
      const {ticket} = taskInput(config, object);
      assert.equal(ticket.moduleId, expected.name);
      assert.equal(ticket.module, expected.path);
      assert.deepEqual(ticket.modulePaths, expected.paths ?? [expected.path]);
      assert.equal((await nextTask(config)).candidate.id, object.address);
      assert.deepEqual(object, before);
      object.document.data.body += '\nModule: unknown';
      assert.throws(() => taskInput(config, object), /Task module is not configured/);
    }
  }
  object.document.data = {...original, body: 'Goal: required change\nRepository: app'};
  assert.throws(() => taskInput(f.config, object), /module is ambiguous/);
  object.document.data.body += '\nModule: m1\nModule: m2';
  assert.throws(() => taskInput(f.config, object), /more than one module/);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

test('taskFields selects project labels or data paths, and no mapping reads no body label', async t => {
  const f = await setup(t, {launchLanes: false}), object = f.joppa.objects.get('task:t1');
  const original = structuredClone(object.document.data), base = structuredClone(f.config);
  const load = raw => { save(f.configFile, raw); return configFrom(f.configFile, f.env, {dryRun: true}); };
  const input = (config, data) => { object.document.data = {...original, ...data}; return taskInput(config, object).ticket; };
  // Without taskFields, line labels are plain text. The sole repository and module apply.
  const whole = load({...base, taskFields: undefined, repositories: [{...base.repositories[0], modules: undefined}]});
  assert.equal(input(whole, {body: 'Goal: change\nRepository: other\nModule: unknown'}).module, '.');
  assert.equal(input(whole, {body: 'Goal: change', steps: ['Make the change.']}).moduleId, 'app');
  // Unmapped structured scope fields are ignored, and the contract does not render them.
  const ignored = input(whole, {body: 'Goal: change', repository: 'other', module: 'unknown', steps: ['Make the change.']});
  assert.deepEqual([ignored.repository, ignored.moduleId, ignored.body], ['app', 'app', 'Goal: change\n\nHow:\n1. Make the change.']);
  const mapped = load({...base, taskFields: {repository: 'data:repository', module: 'data:module'},
    repositories: [{...base.repositories[0], modules: undefined}]});
  assert.throws(() => input(mapped, {body: 'Goal: change', repository: 'other', steps: ['Make the change.']}),
    /not configured or not unique/);
  assert.throws(() => input(mapped, {body: 'Goal: change', module: 'unknown', steps: ['Make the change.']}),
    /module is not configured/);
  const custom = load({...base, taskFields: {repository: 'body:Target repo', module: 'data:scope.module'}});
  assert.equal(input(custom, {body: 'Goal: change\nTarget repo: app', scope: {module: 'm2'}}).moduleId, 'm2');
  assert.equal(input(custom, {body: 'Goal: change', scope: {module: 'm1'}}).moduleId, 'm1');
  assert.throws(() => input(custom, {body: 'Goal: change\nModule: m1'}), /module is ambiguous/);
  assert.throws(() => input(custom, {body: 'Goal: change', scope: {module: 'm3'}}), /module is not configured/);
  assert.throws(() => input(custom, {body: 'Goal: change', scope: {module: ['m1']}}), /scope.module must be one line/);
  assert.throws(() => input(custom, {body: 'Target repo: app\nTarget repo: app', scope: {module: 'm1'}}), /ambiguous/);
  // A second repository removes the sole choice: selection skips the Task without a read of its parent.
  const two = {...custom, taskFields: {module: 'data:scope.module'},
    repositories: [...custom.repositories, {...custom.repositories[0], id: 'other'}]};
  object.document.data = {...original, body: 'Goal: change', scope: {module: 'm1'}};
  assert.notEqual((await nextTask(two)).candidate?.id, object.address);
  assert.throws(() => taskInput(two, object), /not configured or not unique/);
  for (const taskFields of [{repository: 'Repository'}, {repository: 'body:'}, {module: 'data:a..b'}, {other: 'body:X'}]) {
    assert.throws(() => load({...base, taskFields}), /taskFields maps repository and module/);
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
  f.run.config.taskFields = {repository: 'data:repository', module: 'body:Module'};
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
