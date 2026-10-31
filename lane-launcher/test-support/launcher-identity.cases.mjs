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

test('claim digest tracks authored remote pins without tracking live target status', () => {
  const object = {document: {parent: 'ac:a', data: {title: 'Implement'}, links: []}};
  const original = contractDigest(object);
  object.remote_links = [];
  assert.equal(contractDigest(object), original);
  object.remote_links.push({workspace: 'other', target: 'requirement:api', relation: 'depends_on',
    blocking: true, revision: 1, status: {satisfied: true}});
  const pinned = contractDigest(object);
  assert.notEqual(pinned, original);
  object.remote_links[0].status.satisfied = false;
  assert.equal(contractDigest(object), pinned);
  object.remote_links[0].revision = 2;
  assert.notEqual(contractDigest(object), pinned);
  object.remote_links = [];
  object.remote_links_revision = 1;
  const cleared = contractDigest(object);
  assert.notEqual(cleared, original);
  object.remote_links_revision++;
  assert.notEqual(contractDigest(object), cleared);
});
