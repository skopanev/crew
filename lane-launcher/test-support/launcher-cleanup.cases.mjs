import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {activeCount, dockerLanes, configFrom} from '../launcher.mjs';
import {scopeDirectory, laneRunFolder, validateId} from '../scope.mjs';
import {save, read, laneArgs, runDirectories} from '../runtime.mjs';
import {claimTask, finishTask, nextTask, executionId, runHoldsTasks, contractDigest, guardTaskClaims} from '../joppa.mjs';
import {cleanupBlockedTasks} from '../../planning-joppa/cleanup.mjs';
import {readyCriteria, groupRequirements} from '../../planning-joppa/dashboard.mjs';

import {launcher, worker, queueReads, execute, notificationEnv, setup, workerFixture} from './launcher.fixture.mjs';
import {packageFixture, blockedPackage, packageLanding} from './launcher-joppa.fixture.mjs';

test('Joppa package cleanup removes its recorded shared checkout once', async t => {
  const f = await packageFixture(t), blocked = blockedPackage(f);
  const prepared = cleanupBlockedTasks(blocked.input);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].folder, blocked.folder);
  assert.equal(fs.existsSync(blocked.folder), false);
});

for (const state of ['confirmed', 'overlapping', 'unconfirmed', 'newer']) {
  test(`Joppa package cleanup handles ${state} success before another failed package`, async t => {
    const f = await packageFixture(t), blocked = blockedPackage(f);
    blocked.run.createdAt = '2026-10-14T12:00:00.000Z';
    save(path.join(blocked.runs, blocked.runId, 'launch.json'), blocked.run);
    const folder = path.join(blocked.runs, '33333333-3333-4333-8333-333333333333');
    fs.mkdirSync(folder);
    const tasks = state === 'overlapping' ? blocked.run.tasks : [{address: 'task:old1'}, {address: 'task:old2'}];
    const earlier = {...blocked.run, task: tasks[0].address, tasks, claim: {tasks},
      createdAt: '2026-10-14T10:00:00.000Z', result: {code: 0, completed: state !== 'unconfirmed',
        finishedAt: state === 'newer' ? '2026-10-14T13:00:00.000Z' : '2026-10-14T11:00:00.000Z'}};
    save(path.join(folder, 'launch.json'), earlier);
    if (state === 'confirmed') {
      const prepared = cleanupBlockedTasks(blocked.input, {dryRun: true});
      assert.equal(prepared.length, 1);
      assert.equal(prepared[0].folder, blocked.folder);
    } else {
      const error = state === 'overlapping' ? /successful receipt overlaps/ :
        state === 'newer' ? /not historical/ : /unconfirmed successful/;
      assert.throws(() => cleanupBlockedTasks(blocked.input, {dryRun: true}), error);
    }
    assert.equal(fs.existsSync(path.join(blocked.folder, 'retained.txt')), true);
  });
}

test('Joppa package cleanup refuses an incomplete AC scope before deleting any checkout', async t => {
  const f = await packageFixture(t), blocked = blockedPackage(f);
  blocked.input.tasks = [blocked.input.tasks[1]];
  blocked.input.operations = [blocked.input.operations[1]];
  assert.throws(() => cleanupBlockedTasks(blocked.input), /every blocked Task.*whole Requirement/);
  assert.equal(fs.existsSync(path.join(blocked.folder, 'retained.txt')), true);
});

test('Joppa package cleanup requires an operation for every retained Task', async t => {
  const f = await packageFixture(t), blocked = blockedPackage(f);
  blocked.input.operations.pop();
  assert.throws(() => cleanupBlockedTasks(blocked.input), /Every blocked Task needs/);
  assert.equal(fs.existsSync(path.join(blocked.folder, 'retained.txt')), true);
});

test('Joppa package cleanup preserves legacy single-Task receipts', async t => {
  const f = await packageFixture(t), blocked = blockedPackage(f);
  const run = {...blocked.run, executionId: executionId('task:t1')};
  delete run.tasks;
  run.claim = {claimed: true};
  const folder = path.join(blocked.root, run.executionId);
  fs.renameSync(blocked.folder, folder);
  blocked.input.tasks.pop();
  blocked.input.operations.pop();
  save(path.join(blocked.runs, blocked.runId, 'launch.json'), run);
  assert.equal(cleanupBlockedTasks(blocked.input)[0].folder, folder);
  assert.equal(fs.existsSync(folder), false);
});

for (const state of ['live', 'held', 'uncertain']) test(`Joppa package cleanup refuses a ${state} sibling run`, async t => {
  const f = await packageFixture(t), blocked = blockedPackage(f);
  const folder = path.join(blocked.runs, '22222222-2222-4222-8222-222222222222');
  fs.mkdirSync(folder);
  const active = {...blocked.run, task: 'task:t2', tasks: [{address: 'task:t2'}]};
  if (state === 'live') delete active.result;
  if (state === 'held') active.result = {code: 2, held: true, finishedAt: new Date().toISOString()};
  if (state === 'uncertain') {
    delete active.claim;
    active.claimRequest = {operations: [{command: {op: 'claim_task', id: 'task:t2'}}]};
    active.result = {code: 2, finishedAt: new Date().toISOString()};
  }
  save(path.join(folder, 'launch.json'), active);
  assert.throws(() => cleanupBlockedTasks(blocked.input), /Active, held or unconfirmed/);
  assert.equal(fs.existsSync(path.join(blocked.folder, 'retained.txt')), true);
});
