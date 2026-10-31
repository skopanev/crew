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

for (const forceColor of ['0', '1']) {
  test(`startup stderr reaches saved result and notification (color=${forceColor})`, async t => {
    const reason = '[sync] shared CBM refused tools/call: index worker ended with exit_nonzero';
    const f = await workerFixture(t, `printf '%s\\n\\n' '${reason}' >&2\nexit 2\n`, {notify: {chatId: 'fixture'}});
    const sent = path.join(f.root, 'sent.json'), log = path.join(f.root, 'output.log');
    await execute(worker, [f.stateFile], {...notificationEnv(f, f.stateFile, sent), FORCE_COLOR: forceColor, NO_COLOR: undefined});
    assert.match(read(f.stateFile).result.error, /Lane exited 2/);
    assert.equal(read(sent).text, '🔴 FAILED\nTicket: task:t1\nReason: EXIT_2');
    assert.ok(fs.readFileSync(log, 'utf8').includes(reason + '\n\n'));
    assert.ok(!fs.readFileSync(log, 'utf8').includes('\x1b['));
    assert.equal(f.calls.filter(call => call.name === 'joppa_batch' &&
      call.args.operations[0].command.op === 'claim_task').length, 1);
  });
}
