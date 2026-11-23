import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {activeCount, dockerLanes, configFrom} from '../launcher.mjs';
import {scopeDirectory, laneRunFolder, validateId} from '../scope.mjs';
import {save, read, laneArgs, runDirectories} from '../runtime.mjs';
import {claimTask, finishTask, nextTask, executionId, runHoldsTasks, contractDigest, guardTaskClaims} from '../joppa.mjs';
import {cleanupBlockedTasks} from '../../planning-joppa/cleanup.mjs';
import {readyCriteria, groupRequirements} from '../../planning-joppa/dashboard.mjs';
import {sameContract, sameContext} from '../joppa-common.mjs';

import {launcher, worker, queueReads, execute, notificationEnv, setup, workerFixture} from './launcher.fixture.mjs';
import {packageFixture, blockedPackage, packageLanding} from './launcher-joppa.fixture.mjs';

test('return counters preserve a claim but authored changes invalidate it', () => {
  const object = {document: {parent: 'ac:a', data: {title: 'Implement', body: 'Keep the saved value'}, links: []}};
  const original = contractDigest(object);
  object.document.data.returns = 2;
  object.document.data.max_stage = 'legacy';
  assert.equal(contractDigest(object), original);
  object.document.data.body = 'Replace the saved value';
  assert.notEqual(contractDigest(object), original);
});

test('saved claims retain the previous digest format through counter changes', () => {
  const authored = {title: 'Check the value', body: 'Keep the saved value', returns: 0, max_stage: 'legacy'};
  const frozen = {...authored, tags: ['keep']};
  const object = {address: 'ac:a', current_revision: 7,
    document: {parent: 'requirement:r', data: structuredClone(frozen), links: []}};
  const previous = createHash('sha256').update(JSON.stringify({parent: 'requirement:r', data: authored, links: []})).digest('hex');
  const snapshot = {address: object.address, digest: previous};
  const claim = {ticket: {parentContext: {...snapshot, data: frozen}}};
  assert.equal(sameContract(object, snapshot, claim), true);
  const sourceDigest = createHash('sha256').update(JSON.stringify({revision: 7, contract: previous, files: []})).digest('hex');
  assert.equal(sameContext(object, {source: true, digest: sourceDigest}, claim), true);
  object.document.data.returns = 1;
  object.document.data.tags = ['stuck'];
  assert.equal(sameContract(object, snapshot, claim), true);
  object.document.data.body = 'Replace the saved value';
  assert.equal(sameContract(object, snapshot, claim), false);
});

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
