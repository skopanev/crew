import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {dependencyCheck} from '../dependencies.mjs';
import {configFrom, tick} from '../launcher.mjs';
import {createDashboard} from '../dashboard.mjs';
import {fixture} from '../test-support/requirement-delivery.fixture.mjs';
import {setup} from '../test-support/launcher.fixture.mjs';

test('local ordering uses consumer readiness without reinterpreting dependency state', async () => {
  const f = fixture(), target = f.add('spec:before', null);
  f.objects.get('work:one').document.links = [{relation: 'depends_on', blocking: true, target: target.address}];
  const calls = [];
  const read = (tool, args) => {
    calls.push({tool, args});
    return f.read(tool, args);
  };
  for (const tone of ['green', 'orange', 'yellow', 'grey', 'red', undefined]) {
    target.status = {tone};
    target.work_ready = false;
    target.process.assessment = {state: 'waiting', reason: 'WAITING'};
    assert.equal((await dependencyCheck(read)('work:one')).ready, true);
  }
  assert(calls.every(({tool, args}) => tool === 'joppa_objects' && args.address !== target.address));
  f.objects.get('work:one').work_ready = false;
  f.objects.get('work:one').waits_for = {address: target.address};
  assert.deepEqual(await dependencyCheck(read)('work:one'), {ready: false, blocker: target.address});
});

test('local ordering survives completion metadata revisions without changing documents', async () => {
  const f = fixture(), target = f.objects.get('work:two');
  target.current_revision = 11;
  const link = {relation: 'depends_on', blocking: true, target: target.address, revision: 1};
  f.objects.get('work:one').document.links = [link];
  const before = structuredClone(f.objects);
  assert.deepEqual(await dependencyCheck(f.read)('work:one'), {ready: true, blocker: null});
  assert.deepEqual(f.objects, before);
  link.revision = 11;
  assert.deepEqual(await dependencyCheck(f.read)('work:one'), {ready: true, blocker: null});
  link.revision = 1;
  f.objects.get('work:one').document.links = [];
  f.objects.get('measure:a').document.links = [link];
  const inherited = await dependencyCheck(f.read)('work:one');
  assert.equal(inherited.ready, true);
  target.document.present = true;
  target.document.data.assignee = 'another-run';
  f.objects.get('work:one').work_ready = false;
  f.objects.get('work:one').waits_for = {address: target.address};
  assert.deepEqual(await dependencyCheck(f.read)('work:one'), {ready: false, blocker: 'work:two'});
});

test('the CLI and dashboard leave unfinished dependencies unchanged', async t => {
  const f = await setup(t, {launchLanes: false});
  f.joppa.queue.splice(0, f.joppa.queue.length, 'task:t1');
  const target = f.joppa.objects.get('task:t2');
  target.current_revision = 11;
  const task = f.joppa.objects.get('task:t1');
  task.document.links = [{relation: 'depends_on', blocking: true, target: target.address, revision: 1}];
  task.work_ready = false;
  task.waits_for = {address: target.address};
  const before = structuredClone(f.joppa.objects);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /0 available/);
  assert.doesNotMatch(result.stdout, /Starting new one/);
  assert.ok(!fs.existsSync(f.events));

  const state = {};
  await tick(configFrom(f.configFile, f.env), state);
  assert.equal(state.counts.dependencyIssues.length, 0);
  assert.equal(state.message, 'No ready tickets');
  let output = '';
  const write = t.mock.method(process.stdout, 'write', chunk => { output += chunk; return true; });
  const dashboard = createDashboard({...f.config, stateDir: f.stateDir}, (_, value) => value);
  try {
    Object.assign(dashboard.state, state);
    dashboard.draw(60);
  } finally {
    dashboard.close();
    write.mock.restore();
  }
  assert.doesNotMatch(output, /DEPENDENCY_STALE_PIN/);
  assert.deepEqual(f.joppa.objects, before);
  assert.equal(f.calls.some(call => ['joppa_batch', 'joppa_command'].includes(call.name)), false);
});
