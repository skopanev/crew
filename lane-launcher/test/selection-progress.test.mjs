import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {doneRuns, selectionProgress} from '../selection-progress.mjs';
import {createDashboard} from '../dashboard.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-progress-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {stateDir: root, workspace: 'sample', joppa: {filter: {parent: 'area:sample', depth: 4,
    data: {stage: 'ready_for_code'}}}};
}

test('DONE windows count completed runs, including legacy history, by completion time', t => {
  const config = fixture(t), now = Date.parse('2026-11-21T12:00:00Z');
  const write = (name, age, extra = {}, legacy = false) => {
    const dir = path.join(config.stateDir, 'runs', name);
    fs.mkdirSync(dir, {recursive: true});
    const result = {completed: true, code: 0, finishedAt: new Date(now - age).toISOString(), ...extra};
    fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify(legacy ? {} : {result}));
    if (legacy) fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result));
  };
  write('hour-boundary', 3600000);
  write('day-boundary', 86400000, {}, true);
  write('old', 86400001);
  write('recovered', 86400001, {recoveredAt: new Date(now - 1000).toISOString()});
  write('queued', 1000, {pendingDelivery: true});
  write('unconfirmed', 1000, {completed: false});
  write('failed', 1000, {code: 2});
  write('future', -1000);
  assert.deepEqual(doneRuns(config, now), {hour: 2, day: 3});
});

test('one grouped count uses criterion roles and parent/depth, then screen redraws reuse it', async t => {
  const config = fixture(t), calls = [];
  const progress = await selectionProgress(config, {criterionKinds: ['criterion', 'technical_check']}, {
    read: async (tool, args) => {
      calls.push({tool, args});
      return {total: 701, groups: [{stage: 'done', count: 405}, {stage: 'in_progress', count: 296}]};
    },
  });
  assert.deepEqual(calls, [{tool: 'joppa_objects', args: {kind: ['criterion', 'technical_check'],
    parent: 'area:sample', depth: 4, group_by: ['stage']}}]);
  assert.equal(progress.line, 'Progress: done 405/701 (58%) · DONE 60m: 0 · 24h: 0');
  let output = '';
  const write = t.mock.method(process.stdout, 'write', chunk => { output += chunk; return true; });
  const screen = createDashboard({...config, id: 'sample', limit: 5, repositories: []}, (_, value) => value);
  try {
    screen.state.progress = progress.line;
    screen.draw(60); screen.draw(59);
  } finally { screen.close(); write.mock.restore(); }
  assert(output.includes(progress.line));
  assert.equal(calls.length, 1);
});

test('empty and unavailable grouped counts do not invent completed criteria', async t => {
  const config = fixture(t), selected = {criterionKinds: ['criterion']};
  const empty = await selectionProgress(config, selected, {read: async () => ({total: 0, groups: []})});
  assert.equal(empty.line, 'Progress: done 0/0 (0%) · DONE 60m: 0 · 24h: 0');
  const invalid = await selectionProgress(config, selected, {read: async () => ({total: 2, groups: []})});
  assert.match(invalid.line, /^Progress: unavailable/);
  assert.match(invalid.error, /incomplete stage counts/);
  const failed = await selectionProgress(config, selected, {read: async () => { throw new Error('Unavailable'); }});
  assert.match(failed.error, /PROGRESS_UNAVAILABLE: Unavailable/);
});
