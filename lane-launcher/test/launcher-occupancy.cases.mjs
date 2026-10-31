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

for (const state of ['live', 'held', 'uncertain']) test(`Joppa package excludes a ${state} local repository reservation`, async t => {
  const f = await packageFixture(t);
  const folder = path.join(f.root, 'runs/11111111-1111-4111-8111-111111111111');
  fs.mkdirSync(folder, {recursive: true});
  const run = {...f.run, repositoryId: 'app', joppaWorker: {actor: 'another-worker'}};
  if (state === 'held') run.result = {code: 2, held: true, finishedAt: new Date().toISOString()};
  if (state === 'uncertain') {
    run.claimRequest = {operations: [{command: {op: 'claim_task', id: 'task:t1'}}]};
    run.result = {code: 2, finishedAt: new Date().toISOString()};
  }
  save(path.join(folder, 'launch.json'), run);
  assert.equal((await nextTask(f.run.config)).candidate, null);
});

for (const sameRepository of [false, true]) test(`Joppa package detects remote holders; same repository=${sameRepository}`, async t => {
  const f = await packageFixture(t);
  const held = f.objects.get('task:t2');
  held.process = {status: 'in_progress', assignee: 'manual-worker'};
  if (!sameRepository) {
    held.document.data.body = held.document.data.body.replace('Repository: app', 'Repository: other');
    f.run.config.repositories.push({...f.run.config.repositories[0], id: 'other'});
  }
  const selected = await nextTask(f.run.config);
  if (sameRepository) assert.equal(selected.candidate, null);
  else assert.deepEqual(selected.candidate.tasks.map(task => task.address), ['task:t1']);
});

for (const configured of [false, true]) test(`Joppa package scans cross-project holders; configured repository=${configured}`, async t => {
  const f = await packageFixture(t), foreign = f.objects.get('task:t2');
  foreign.document.data.projects = ['project:other'];
  foreign.document.data.body = `Repository: ${configured ? 'app' : 'unconfigured'}\nModule: absent`;
  foreign.process = {status: 'in_progress', assignee: 'foreign-worker'};
  const selected = await nextTask(f.run.config);
  if (configured) assert.equal(selected.candidate, null);
  else assert.deepEqual(selected.candidate.tasks.map(task => task.address), ['task:t1']);
  const scans = f.calls.filter(call => call.name === 'joppa_tasks');
  assert.equal(scans.find(call => call.args.view === 'all').args.project, undefined);
  assert.equal(scans.find(call => call.args.view === 'available').args.project, 'project:app');
});

for (const mode of ['postclaim-race', 'sameactor-race', 'release-unknown']) test(`Joppa package ${mode} stops its worker before shell startup`, async t => {
  const f = await packageFixture(t, mode), bins = path.join(f.root, 'bins'), marker = path.join(f.root, 'started');
  fs.mkdirSync(bins);
  fs.writeFileSync(path.join(bins, 'bash'), '#!/bin/sh\ntouch "$START_MARKER"\nexit 99\n', {mode: 0o755});
  f.persist();
  const result = await execute(worker, [f.stateFile], {...process.env, PATH: `${bins}:${process.env.PATH}`, START_MARKER: marker});
  assert.equal(result.code, 2, result.stderr);
  assert.equal(fs.existsSync(marker), false);
  const saved = read(f.stateFile), confirmed = mode !== 'release-unknown';
  assert.deepEqual(saved.releaseRequest.operations.map(item => item.command.id), ['task:t1', 'task:t2']);
  assert.equal(saved.releaseConfirmed === true, confirmed);
  assert.equal(saved.result.released, confirmed);
  assert.equal(saved.result.held, !confirmed);
  assert.equal(saved.result.blocked, false);
  assert.equal(runHoldsTasks(saved), !confirmed);
  assert.equal(f.objects.get('task:foreign').process.assignee, mode === 'sameactor-race' ? 'lane-1' : 'foreign-worker');
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 2);
  assert.equal(saved.completionRequest, undefined);
  assert.equal(saved.blockRequest, undefined);
  assert.equal(saved.failureRequest, undefined);
});

test('Joppa package legacy adopted claim runs the ownership guard before startup', async t => {
  const f = await packageFixture(t);
  f.run.tasks = [f.run.tasks[0]];
  f.run.executionId = executionId(f.run.task);
  await claimTask(f.run, f.persist);
  delete f.run.claimRequest;
  delete f.run.claim.tasks;
  delete f.run.requirement;
  const foreign = f.objects.get('task:t2');
  foreign.document.data.projects = ['project:other'];
  foreign.process = {status: 'in_progress', assignee: 'foreign-worker'};
  const bins = path.join(f.root, 'bins'), marker = path.join(f.root, 'started');
  fs.mkdirSync(bins);
  fs.writeFileSync(path.join(bins, 'bash'), '#!/bin/sh\ntouch "$START_MARKER"\nexit 99\n', {mode: 0o755});
  f.persist();
  const result = await execute(worker, [f.stateFile], {...process.env, PATH: `${bins}:${process.env.PATH}`, START_MARKER: marker});
  assert.equal(result.code, 2, result.stderr);
  assert.equal(fs.existsSync(marker), false);
  const saved = read(f.stateFile);
  assert.equal(saved.releaseConfirmed, true);
  assert.deepEqual(saved.releaseResults.map(task => task.address), ['task:t1']);
  assert.equal(foreign.process.assignee, 'foreign-worker');
});

test('Joppa package ignores held Tasks for another purpose without an implementation contract', async t => {
  const f = await packageFixture(t), other = f.objects.get('task:t2');
  other.document.data = {title: 'Research task', purpose: 'research'};
  other.process = {status: 'in_progress', assignee: 'research-worker'};
  const selected = await nextTask(f.run.config);
  assert.deepEqual(selected.candidate.tasks.map(task => task.address), ['task:t1']);
  assert.equal(f.calls.find(call => call.name === 'joppa_tasks' && call.args.view === 'all').args.purpose, 'implementation');
  assert.equal(f.calls.some(call => call.name === 'joppa_objects' && call.args.address === 'task:t2'), false);
});
