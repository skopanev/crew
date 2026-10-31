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

for (const forceColor of ['0', '1']) {
  test(`startup stderr reaches saved result and notification (color=${forceColor})`, async t => {
    const f = await setup(t);
    const reason = '[sync] shared CBM refused tools/call: index worker ended with exit_nonzero';
    fs.writeFileSync(path.join(f.bins, 'bash'), `#!/bin/sh\nprintf '%s\\n\\n' '${reason}' >&2\nexit 2\n`, {mode: 0o755});
    const dir = path.join(f.root, 'worker');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'launch.json'), sent = path.join(dir, 'sent.json');
    save(file, {config: {...f.config, notify: {chatId: 'fixture'}},
      ticket: 'T1', workspace: 'test', args: [], pane: 'fixture', runFolder: path.join(dir, 'lane')});
    await execute(worker, [file], {...notificationEnv(f, file, sent), FORCE_COLOR: forceColor, NO_COLOR: undefined});
    assert.match(read(path.join(dir, 'launch.json')).result.error, /Lane exited 2/);
    assert.equal(read(sent).text, '🔴 FAILED\nTicket: T1\nReason: EXIT_2');
    assert.ok(fs.readFileSync(path.join(dir, 'output.log'), 'utf8').includes(reason + '\n\n'));
    assert.ok(!fs.readFileSync(path.join(dir, 'output.log'), 'utf8').includes('\x1b['));
    assert.equal(f.calls.filter(call => call.url.includes('/start')).length, 1);
  });
}
