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

for (const state of ['live', 'held', 'uncertain']) test(`Joppa package excludes a ${state} local repository reservation`, async t => {
  const f = await packageFixture(t);
  const folder = path.join(f.root, 'runs/11111111-1111-4111-8111-111111111111');
  fs.mkdirSync(folder, {recursive: true});
  const run = {...f.run, repositoryId: 'app', joppaWorker: {actor: 'another-worker'}};
  if (state === 'held') run.result = {code: 2, held: true, finishedAt: new Date().toISOString()};
  if (state === 'uncertain') {
    run.claimRequest = {operations: [{command: {op: 'save_object', kind: 'task', id: 't1', revision: 3}}]};
    run.result = {code: 2, finishedAt: new Date().toISOString()};
  }
  save(path.join(folder, 'launch.json'), run);
  assert.equal((await nextTask(f.run.config)).candidate, null);
});

for (const sameRepository of [false, true]) test(`Joppa package detects remote holders; same repository=${sameRepository}`, async t => {
  const f = await packageFixture(t);
  const held = f.objects.get('task:t2');
  held.document.data.assignee = 'manual-worker';
  if (!sameRepository) {
    held.document.data.body = held.document.data.body.replace('Repository: app', 'Repository: other');
    f.run.config.repositories.push({...f.run.config.repositories[0], id: 'other'});
  }
  const selected = await nextTask(f.run.config);
  assert.deepEqual(selected.candidate.tasks.map(task => task.address), ['task:t1']);
});

for (const configured of [false, true]) test(`Joppa package scans cross-project holders; configured repository=${configured}`, async t => {
  const f = await packageFixture(t), foreign = f.objects.get('task:t2');
  foreign.document.data.projects = ['project:other'];
  foreign.document.data.body = `Repository: ${configured ? 'app' : 'unconfigured'}\nModule: absent`;
  foreign.document.data.assignee = 'foreign-worker';
  const selected = await nextTask(f.run.config);
  assert.deepEqual(selected.candidate.tasks.map(task => task.address), ['task:t1']);
  const scans = f.calls.filter(call => call.name === 'joppa_objects' && call.args.kind?.includes('task'));
  assert(scans.length > 0);
  assert(scans.every(call => !Object.hasOwn(call.args, 'project') && !Object.hasOwn(call.args, 'view')));
});

test('Joppa package ignores held Tasks without a repository contract', async t => {
  const f = await packageFixture(t), other = f.objects.get('task:t2');
  other.document.data = {title: 'Research task', body: 'Summarize the current decision.'};
  other.document.data.assignee = 'research-worker';
  const selected = await nextTask(f.run.config);
  assert.deepEqual(selected.candidate.tasks.map(task => task.address), ['task:t1']);
  assert(!f.calls.some(call => call.name === 'joppa_tasks'));
  assert.equal(f.calls.some(call => call.name === 'joppa_objects' && call.args.address === 'task:t2'), true);
});
