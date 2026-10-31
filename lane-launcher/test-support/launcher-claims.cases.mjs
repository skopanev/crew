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

import {launcher, worker, queueReads, countReads, queueQuery, runState, existingClaim, execute, notificationEnv, setup} from './launcher-ntk.fixture.mjs';
import {packageFixture, blockedPackage, packageLanding} from './launcher-joppa.fixture.mjs';

test('Joppa package claims atomically and preserves each Task contract and scope', async t => {
  const f = await packageFixture(t);
  const itemIds = {'task:t1': 'example-T-FIRST', 'task:t2': 'example-T-SECOND',
    'ac:a1': 'example-A-FIRST', 'ac:a2': 'example-A-SECOND', 'req:r': 'example-R-PARENT'};
  for (const [address, itemId] of Object.entries(itemIds)) f.objects.get(address).item_id = itemId;
  await claimTask(f.run, f.persist);
  const mutations = f.calls.filter(call => call.name === 'joppa_batch');
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].args.operations.map(item => item.command.id), ['task:t1', 'task:t2']);
  assert.deepEqual(f.run.claim.ticket.modulePaths, ['src/a', 'tests/a', 'src/b', 'tests/b']);
  assert.deepEqual(f.run.claim.ticket.tasks[0].modulePaths, ['src/a', 'tests/a']);
  assert.deepEqual(f.run.claim.ticket.tasks[1].modulePaths, ['src/b', 'tests/b']);
  assert.match(f.run.claim.ticket.body, /Task 1: task:t1/);
  assert.equal(f.run.claim.ticket.tasks[0].parentContext.address, 'ac:a1');
  assert.equal(f.run.claim.ticket.tasks[1].parentContext.address, 'ac:a2');
  const serialized = JSON.parse(JSON.stringify(f.run.claim.ticket));
  for (const task of serialized.tasks) {
    assert.equal(task.item_id, itemIds[task.address]);
    assert.equal(task.parentContext.item_id, itemIds[task.parentContext.address]);
    assert.equal(task.requirementContext.item_id, itemIds['req:r']);
  }
  assert.deepEqual(f.run.claim.contexts.map(context => context.address), ['ac:a1', 'req:r', 'ac:a2']);
});

test('Joppa claim guard rechecks remote state and authored pin changes before startup', async t => {
  const f = await packageFixture(t);
  const link = {workspace: 'remote', target: 'req:r', relation: 'depends_on', blocking: true, revision: 1,
    status: {access: true, present: true, review_required: false, satisfied: true, current_revision: 1}};
  f.objects.get('req:r').remote_links = [link];
  await claimTask(f.run, f.persist);
  link.status.satisfied = false;
  await assert.rejects(guardTaskClaims(f.run, f.persist), /DEPENDENCY_NOT_READY: @remote\/req:r/);
  link.status.satisfied = true;
  link.revision = link.status.current_revision = 2;
  await assert.rejects(guardTaskClaims(f.run, f.persist), /Acceptance context changed/);
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 1);
});

for (const mode of ['reject', 'incomplete']) test(`Joppa package ${mode} claim cannot start a lane`, async t => {
  const f = await packageFixture(t, mode);
  await assert.rejects(claimTask(f.run, f.persist), mode === 'reject' ? /operation 2/ : /incomplete/);
  assert.equal(f.run.claim, undefined);
  assert.equal(Boolean(f.run.claimRejected), mode === 'reject');
  assert.equal(read(f.stateFile).claimRequest.operations.length, 2);
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 1);
  assert.equal(f.calls.some(call => call.name === 'joppa_command'), false);
});

for (const mode of ['reject', 'incomplete']) test(`Joppa package worker stops before startup after ${mode} claim`, async t => {
  const f = await packageFixture(t, mode);
  const bins = path.join(f.root, 'bins'), marker = path.join(f.root, 'started');
  fs.mkdirSync(bins);
  fs.writeFileSync(path.join(bins, 'bash'), '#!/bin/sh\ntouch "$START_MARKER"\nexit 99\n', {mode: 0o755});
  f.persist();
  const result = await execute(worker, [f.stateFile], {...process.env, PATH: `${bins}:${process.env.PATH}`, START_MARKER: marker});
  assert.equal(result.code, 2, result.stderr);
  assert.equal(fs.existsSync(marker), false);
  const saved = read(f.stateFile);
  assert.equal(saved.claim, undefined);
  assert.match(saved.result.error, mode === 'reject' ? /CLAIM_REFUSED/ : /CLAIM_UNCERTAIN/);
  assert.equal(saved.claimRequest.operations.length, 2);
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 1);
});

test('Joppa package blocks all held Tasks with one atomic outcome', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist);
  const artifacts = path.join(f.root, 'artifacts');
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'failure.txt'), 'Required check failed');
  const result = {code: 1, status: 'failed'};
  await finishTask(f.run, f.stateFile, result, artifacts);
  assert.equal(result.blockConfirmed, true);
  assert.deepEqual(result.tasks.map(task => [task.address, task.status]), [['task:t1', 'blocked'], ['task:t2', 'blocked']]);
  const batch = f.calls.filter(call => call.name === 'joppa_batch').at(-1);
  assert.deepEqual(batch.args.operations.map(item => item.command.op), ['block_task', 'block_task']);
});

test('Joppa package refuses more than 100 Tasks before API calls', async t => {
  const f = await packageFixture(t);
  f.run.tasks = Array.from({length: 101}, (_, index) => ({address: `task:t${index}`, revision: 3}));
  await assert.rejects(claimTask(f.run, f.persist), /100-operation/);
  assert.equal(f.calls.length, 0);
});
