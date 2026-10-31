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

for (const exitCode of [0, 7]) for (const closeTabOnExit of [false, true]) {
  test(`worker saves exit ${exitCode}; closeTabOnExit=${closeTabOnExit}`, async t => {
    const f = await setup(t);
    // Stand in for the lane process; exercise the real worker and Herdr dispatch.
    fs.writeFileSync(path.join(f.bins, 'bash'), `#!/bin/sh\nprintf 'lane-output\\n'\nexit ${exitCode}\n`, {mode: 0o755});
    const dir = path.join(f.root, 'worker');
    fs.mkdirSync(dir);
    const artifacts = path.join(laneRunFolder(path.join(dir, 'lane'), f.config.id), 'fixture/artifacts');
    fs.mkdirSync(path.join(artifacts, 'gates/check'), {recursive: true});
    fs.writeFileSync(path.join(artifacts, 'failure.txt'), 'candidate checks failed');
    save(path.join(artifacts, 'gates/check/receipt.json'), {checks: [
      {command: 'bun run docs:links', exit_code: 1, log: '/fixture/gates/1.log'}]});
    const file = path.join(dir, 'launch.json');
    save(file, {config: {...f.config, closeTabOnExit}, ticket: 'T1', workspace: 'test',
      args: ['--ticket-id', 'T1'], pane: 'owned-pane', runFolder: path.join(dir, 'lane')});
    const result = await execute(worker, [file], {...f.env, TEST_RESULT: file});
    assert.equal(result.code, 0, result.stderr);
    assert.equal(read(path.join(dir, 'launch.json')).result.code, exitCode);
    assert.match(fs.readFileSync(path.join(dir, 'output.log'), 'utf8'), /lane-output/);
    if (exitCode) assert.match(result.stdout, /FAILED check: bun run docs:links · exit 1/);
    else assert.doesNotMatch(result.stdout, /FAILED check:/);
    const events = fs.existsSync(f.events)
      ? fs.readFileSync(f.events, 'utf8').trim().split('\n').map(JSON.parse) : [];
    assert.deepEqual(events, closeTabOnExit ? [['pane', 'close', 'owned-pane']] : []);
    if (!closeTabOnExit) assert.match(result.stdout, /Tab kept open/);
  });
}
