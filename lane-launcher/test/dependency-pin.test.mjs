import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {dependencyCheck} from '../dependencies.mjs';
import {configFrom, tick} from '../launcher.mjs';
import {createDashboard} from '../dashboard.mjs';
import {fixture} from '../test-support/requirement-delivery.fixture.mjs';
import {setup} from '../test-support/launcher.fixture.mjs';

test('a delivered prerequisite with a changed contract reports its stale pin without changing documents', async () => {
  const f = fixture(), target = f.objects.get('work:two');
  Object.assign(target, {current_revision: 11, review_required: false});
  target.process.origin_revision = 9;
  const link = {relation: 'depends_on', blocking: true, target: target.address, revision: 1};
  f.objects.get('work:one').document.links = [link];
  const before = structuredClone(f.objects);
  assert.deepEqual(await dependencyCheck(f.read)('work:one'), {ready: false,
    code: 'DEPENDENCY_STALE_PIN', consumer: 'work:one', blocker: 'work:two',
    pin: 1, contractRevision: 9, currentRevision: 11});
  assert.deepEqual(f.objects, before);
  link.revision = 11;
  assert.deepEqual(await dependencyCheck(f.read)('work:one'), {ready: true, blocker: null});
  link.revision = 1;
  f.objects.get('work:one').document.links = [];
  f.objects.get('measure:a').document.links = [link];
  const inherited = await dependencyCheck(f.read)('work:one');
  assert.equal(inherited.code, 'DEPENDENCY_STALE_PIN');
  assert.equal(inherited.consumer, 'measure:a');
});

test('the CLI and dashboard explain zero availability and never claim or re-pin the stale Task', async t => {
  const f = await setup(t, {launchLanes: false});
  f.joppa.queue.splice(0, f.joppa.queue.length, 'task:t1');
  const target = f.joppa.objects.get('task:t2');
  Object.assign(target, {current_revision: 11, review_required: false});
  target.process = {status: 'done', done: 'Delivered', origin_revision: 9};
  const task = f.joppa.objects.get('task:t1');
  task.document.links = [{relation: 'depends_on', blocking: true, target: target.address, revision: 1}];
  const before = structuredClone(f.joppa.objects);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /0 available · 0 held workers · 1 DEPENDENCY_STALE_PIN/);
  assert.match(result.stdout, /task:t1 → task:t2 · pin=1 · contract=9 · current=11/);
  assert.doesNotMatch(result.stdout, /Starting new one/);
  assert.ok(!fs.existsSync(f.events));

  const state = {};
  await tick(configFrom(f.configFile, f.env), state);
  assert.equal(state.counts.dependencyIssues.length, 1);
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
  assert.match(output, /DEPENDENCY_STALE_PIN/);
  assert.match(output, /task:t1 → task:t2/);
  assert.match(output, /pin=1 · contract=9 · current=11/);
  assert.deepEqual(f.joppa.objects, before);
  assert.equal(f.calls.some(call => ['joppa_batch', 'joppa_command'].includes(call.name)), false);
});
