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

test('open tagged ticket launches once; pending tab consumes the only slot', async t => {
  const f = await setup(t);
  let result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(queueReads(f), 1);
  const query = queueQuery(f);
  assert.equal(query.pathname, '/v1/tickets/next');
  for (const [key, value] of Object.entries({workspace: 'test', tag: 'crew',
    dry_run: 'true', has_module: 'true', strict: 'true'})) assert.equal(query.searchParams.get(key), value);
  assert.equal(query.searchParams.has('project'), false);
  const events = fs.readFileSync(f.events, 'utf8').trim().split('\n').map(JSON.parse);
  const create = events.find(args => args[1] === 'create');
  assert.deepEqual(create.slice(0, 4), ['tab', 'create', '--workspace', 'workspace']);
  assert.ok(create.includes('--no-focus'));
  assert.ok(events.find(args => args[1] === 'run')[3].includes('worker.mjs'));
  assert.match(result.stdout, /Tickets with tags \[workspace=test, tags=crew, strict=true\]: 17 open/);
  result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running lanes 1 of 1/);
  assert.doesNotMatch(result.stdout, /Tickets with tags/);
  assert.equal(queueReads(f), 1);
});
for (const [options, expected] of [
  [{claimRefused: true}, 'CLAIM_REFUSED'],
  [{claimRefused: true, claimHttpStatus: 503}, 'CLAIM_UNCERTAIN'],
  [{claimResponse: {id: 'T1', status: 'open', claimed: false}}, 'CLAIM_REFUSED'],
  [{claimResponse: {id: 'T2', status: 'in_progress', claimed: true}}, 'CLAIM_REFUSED'],
  [{claimResponse: {id: 'T1', status: 'open', claimed: true}}, 'CLAIM_REFUSED'],
]) {
  test(`claim refusal is visible in the tab without starting the lane: ${JSON.stringify(options)}`, async t => {
    const f = await setup(t, options);
    const started = path.join(f.root, 'bash-started');
    assert.equal((await f.run()).code, 0);
    fs.writeFileSync(path.join(f.bins, 'bash'), `#!/bin/sh\ntouch '${started}'\nexit 0\n`, {mode: 0o755});
    assert.ok(fs.readFileSync(f.events, 'utf8').includes('create'));
    assert.ok(!f.calls.some(call => call.url.includes('/start')));
    const dir = runState(f);
    const result = await execute(worker, [path.join(dir, 'launch.json')], f.env);
    assert.equal(result.code, 2, result.stderr);
    assert.ok(result.stdout.includes(expected));
    if (expected === 'CLAIM_UNCERTAIN') assert.match(result.stdout, /check T1 in NTK before retrying/);
    assert.equal(read(path.join(dir, 'launch.json')).result.code, 2);
    assert.equal(fs.existsSync(started), false);
    assert.ok(!f.calls.some(call => call.method === 'PATCH'));
  });
}
test('tab opens before claim and the lane starts only after confirmation', async t => {
  const f = await setup(t);
  assert.equal((await f.run()).code, 0);
  fs.writeFileSync(path.join(f.bins, 'bash'), `#!${process.execPath}
import fs from 'node:fs';
const claim = JSON.parse(fs.readFileSync(process.env.LANE_CLAIM_FILE, 'utf8'));
if (!claim.claimed || claim.status !== 'in_progress' || claim.id !== 'T1') process.exit(99);
fs.appendFileSync(process.env.TEST_REQUESTS, 'BASH_START\\n');
`, {mode: 0o755});
  assert.ok(!f.calls.some(call => call.url.includes('/start')));
  const dir = runState(f);
  assert.equal((await execute(worker, [path.join(dir, 'launch.json')], f.env)).code, 0);
  const events = fs.readFileSync(f.env.TEST_REQUESTS, 'utf8');
  assert.ok(events.indexOf('HERDR_TAB_CREATE') < events.indexOf('POST /v1/tickets/T1/start'));
  assert.ok(events.indexOf('POST /v1/tickets/T1/start') < events.indexOf('BASH_START'));
  assert.equal(f.calls.filter(call => call.url.includes('/start')).length, 1);
  assert.equal(read(path.join(dir, 'launch.json')).claim.claimed, true);
});
test('cancellation before claim does not touch NTK or start the lane', async t => {
  const f = await setup(t);
  assert.equal((await f.run()).code, 0);
  const started = path.join(f.root, 'bash-started');
  fs.writeFileSync(path.join(f.bins, 'bash'), `#!/bin/sh\ntouch '${started}'\nexit 0\n`, {mode: 0o755});
  const hook = path.join(f.root, 'cancel.cjs');
  fs.writeFileSync(hook, `const fs = require('node:fs');
const write = fs.writeSync;
fs.writeSync = function(fd, text, ...args) {
  const result = write.call(this, fd, text, ...args);
  if (typeof text === 'string' && text.startsWith('[lane] START ')) process.emit('SIGTERM');
  return result;
};
`);
  const result = await execute('--require', [hook, worker, path.join(runState(f), 'launch.json')], f.env);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stdout, /Startup interrupted by SIGTERM/);
  assert.ok(!f.calls.some(call => call.url.includes('/start') || call.method === 'PATCH'));
  assert.equal(fs.existsSync(started), false);
});
test('tab creation failure does not claim or modify the ticket', async t => {
  const f = await setup(t);
  f.env.TEST_CREATE_FAILURE = '1';
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no ticket was claimed/);
  assert.ok(!f.calls.some(call => call.url.includes('/start') || call.method === 'PATCH'));
  assert.equal(read(path.join(runState(f), 'launch.json')).result.status, 'failed');
});
test('worker startup failure reopens; adopted workflow failure and changed tickets do not', async t => {
  for (const scenario of ['startup', 'adopted', 'done']) {
    const f = await setup(t);
    assert.equal((await f.run()).code, 0);
    const dir = runState(f), run = scenario === 'startup' ? read(path.join(dir, 'launch.json')) : existingClaim(f, dir);
    fs.writeFileSync(path.join(f.bins, 'bash'), '#!/bin/sh\nexit 2\n', {mode: 0o755});
    if (scenario === 'adopted') {
      const artifacts = path.join(run.runFolder, 'fixture', 'artifacts');
      fs.mkdirSync(artifacts, {recursive: true});
      save(path.join(artifacts, 'claim.json'), {...run.claim, run_dir: path.dirname(artifacts)});
    }
    if (scenario === 'done') f.setStatus('done');
    await execute(worker, [path.join(dir, 'launch.json')], f.env);
    const result = read(path.join(dir, 'launch.json')).result;
    assert.equal(result.reopened === true, scenario === 'startup', scenario);
    assert.equal(f.calls.some(call => call.method === 'PATCH'), scenario === 'startup', scenario);
    if (scenario === 'done') assert.match(result.reopenError, /Ticket changed/);
  }
});
