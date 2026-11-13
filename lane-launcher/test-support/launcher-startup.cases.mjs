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
import {defaultHooks} from '../hooks-config.mjs';
import {defaultWorkflow} from '../workflow-config.mjs';

import {launcher, worker, queueReads, execute, notificationEnv, setup, workerFixture} from './launcher.fixture.mjs';
import {packageFixture, blockedPackage, packageLanding} from './launcher-joppa.fixture.mjs';

test('live launcher accepts flat memory and refuses an invalid explicit context root', async t => {
  const f = await setup(t);
  delete f.config.context.root;
  save(f.configFile, f.config);
  assert.equal(configFrom(f.configFile, f.env).context.root, undefined);
  for (const root of [null, '', '   ', 42]) {
    f.config.context.root = root;
    save(f.configFile, f.config);
    assert.throws(() => configFrom(f.configFile, f.env), /context.root must be nonempty when present/);
  }
  f.config.context.root = 'memory:scoped';
  save(f.configFile, f.config);
  assert.equal(configFrom(f.configFile, f.env).context.root, 'memory:scoped');
  delete f.config.context.workspace;
  delete f.config.context.roles.qa;
  save(f.configFile, f.config);
  assert.equal(configFrom(f.configFile, f.env).context.workspace, undefined);
  for (const role of ['reviewer', 'gitfix']) {
    const name = f.config.context.roles[role];
    delete f.config.context.roles[role];
    save(f.configFile, f.config);
    assert.throws(() => configFrom(f.configFile, f.env), new RegExp(`context.roles.${role} is required`));
    f.config.context.roles[role] = name;
  }
});

test('launcher defaults hooks to bundled settings and worker mounts a private copy of custom hooks', async t => {
  const f = await setup(t);
  delete f.config.hooks;
  save(f.configFile, f.config);
  assert.equal(configFrom(f.configFile, f.env).hooks, defaultHooks);
  for (const invalid of [null, '', '   ', 42, 'relative/hooks.json', path.join(f.root, 'missing.json'), f.root]) {
    f.config.hooks = invalid;
    save(f.configFile, f.config);
    assert.throws(() => configFrom(f.configFile, f.env), /hooks|Hook settings/);
  }
  const customFile = path.join(f.root, 'custom-hooks.json');
  for (const badBody of ['{', '[]', '{"hooks":[]}', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":" "}]}]}}']) {
    fs.writeFileSync(customFile, badBody);
    f.config.hooks = customFile;
    save(f.configFile, f.config);
    assert.throws(() => configFrom(f.configFile, f.env), /Hook settings/);
  }
  const customSettings = {
    permissions: {allow: ['Bash(*pytest*)']},
    hooks: {Stop: [{matcher: '*', hooks: [{type: 'command', command: 'bash /workspace/custom/lane/stop.sh'}]}]},
  };
  fs.writeFileSync(customFile, JSON.stringify(customSettings));
  f.config.hooks = customFile;
  save(f.configFile, f.config);
  assert.equal(configFrom(f.configFile, f.env).hooks, customFile);

  const marker = path.join(f.root, 'recorded-hooks.json');
  const script = `${process.execPath} -e '
    const fs = require("node:fs"), path = require("node:path");
    const dir = process.env.LANE_HOOKS_DIR || "";
    const file = dir && path.join(dir, "settings.json");
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
      dir,
      dirMode: dir ? fs.statSync(dir).mode & 0o777 : null,
      fileMode: file && fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : null,
      settings: file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null,
    }));
  '\nexit 1\n`;
  const wf = await workerFixture(t, script, {hooks: customFile});
  await execute(worker, [wf.stateFile], wf.env);
  const recorded = read(marker);
  assert.ok(recorded.dir && recorded.dir !== path.dirname(customFile));
  assert.equal(recorded.dirMode, 0o700);
  assert.equal(recorded.fileMode, 0o600);
  assert.deepEqual(recorded.settings, customSettings);
  assert.equal(fs.existsSync(recorded.dir), false);

  const defaultMarker = path.join(f.root, 'recorded-default-hooks.json');
  const defaultWf = await workerFixture(t, `${process.execPath} -e '
    require("node:fs").writeFileSync(${JSON.stringify(defaultMarker)}, JSON.stringify({dir: process.env.LANE_HOOKS_DIR || ""}));
  '\nexit 1\n`);
  await execute(worker, [defaultWf.stateFile], defaultWf.env);
  assert.equal(read(defaultMarker).dir, '');
});

test('launcher defaults to the lane workflow and passes a custom workflow by its real path', async t => {
  const f = await setup(t);
  delete f.config.workflow;
  save(f.configFile, f.config);
  assert.equal(configFrom(f.configFile, f.env).workflow, defaultWorkflow);
  const customFile = path.join(f.root, 'project-flow/workflow.yaml');
  fs.mkdirSync(path.dirname(customFile));
  fs.writeFileSync(customFile, 'version: "2"\n');
  fs.writeFileSync(path.join(f.root, 'custom.yaml'), 'version: "2"\n');
  fs.writeFileSync(path.join(f.root, 'workflow.yaml'), '');
  fs.symlinkSync(customFile, path.join(f.root, 'project-flow/linked.yaml'));
  for (const invalid of [null, '', 42, 'project-flow/workflow.yaml', path.join(f.root, 'custom.yaml'),
    path.join(f.root, 'missing/workflow.yaml'), path.join(f.root, 'workflow.yaml'), path.join(f.root, 'project-flow')]) {
    f.config.workflow = invalid;
    save(f.configFile, f.config);
    assert.throws(() => configFrom(f.configFile, f.env), /workflow|Workflow/);
  }
  f.config.workflow = customFile;
  save(f.configFile, f.config);
  assert.equal(configFrom(f.configFile, f.env).workflow, customFile);

  const record = name => `${process.execPath} -e '
    require("node:fs").writeFileSync(${JSON.stringify(path.join(f.root, name))}, JSON.stringify(process.env.LANE_WORKFLOW_FILE ?? null));
  '\nexit 1\n`;
  fs.symlinkSync(path.dirname(customFile), path.join(f.root, 'flow-link'));
  const customWf = await workerFixture(t, record('custom.json'), {workflow: path.join(f.root, 'flow-link/workflow.yaml')});
  await execute(worker, [customWf.stateFile], customWf.env);
  assert.equal(read(path.join(f.root, 'custom.json')), fs.realpathSync(customFile));
  const defaultWf = await workerFixture(t, record('default.json'));
  await execute(worker, [defaultWf.stateFile], defaultWf.env);
  assert.equal(read(path.join(f.root, 'default.json')), '');
  const invalidWf = await workerFixture(t, record('invalid.json'), {workflow: path.join(f.root, 'missing/workflow.yaml')});
  await execute(worker, [invalidWf.stateFile], invalidWf.env);
  assert.equal(fs.existsSync(path.join(f.root, 'invalid.json')), false);
  assert.equal(invalidWf.calls.some(call => call.name === 'joppa_batch'), false);
});

test('a workflow that Medulla rejects fails before reading or claiming a ticket', async t => {
  const f = await setup(t);
  const customFile = path.join(f.root, 'project-flow/workflow.yaml');
  fs.mkdirSync(path.dirname(customFile));
  fs.writeFileSync(customFile, 'version: "2"\n');
  const args = path.join(f.root, 'medulla-args');
  fs.writeFileSync(path.join(f.bins, 'medulla'), `#!/bin/sh\necho "$@" >> '${args}'\n` +
    'case "$*" in *--validate*) echo "E_VALIDATION: nodes must be a non-empty mapping" >&2; exit 1;; esac\n', {mode: 0o755});
  save(f.configFile, {...f.config, workflow: customFile});
  const result = await execute(launcher, [f.configFile, '--once'], f.env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Workflow failed Medulla validation; no ticket was claimed: E_VALIDATION: nodes must be/);
  assert.match(fs.readFileSync(args, 'utf8'), new RegExp(`^-w ${customFile} --validate$`, 'm'));
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.events), false);
});

for (const state of ['retained', 'removed', 'other-repository']) test(`Joppa package handles a ${state} blocked sibling checkout`, async t => {
  const f = await packageFixture(t);
  f.queue.splice(0, 1);
  const root = path.join(f.root, 'worktrees'), folder = path.join(f.root, 'runs/11111111-1111-4111-8111-111111111111');
  fs.mkdirSync(root);
  fs.mkdirSync(folder, {recursive: true});
  f.run.config.worktreeRoot = root;
  const repositoryId = state === 'other-repository' ? 'other' : 'app';
  const run = {...f.run, task: 'task:t2', tasks: [{address: 'task:t2'}, {address: 'task:old3'}], repositoryId,
    executionId: executionId(`req:r\n${repositoryId}`),
    result: {code: 1, blockConfirmed: true, finishedAt: new Date().toISOString()}};
  if (state !== 'removed') fs.mkdirSync(path.join(root, run.executionId));
  save(path.join(folder, 'launch.json'), run);
  const selected = await nextTask(f.run.config);
  assert.deepEqual(selected.candidate.tasks.map(task => task.address), ['task:t1']);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

test('Joppa package keeps manual existing checkout handling in lane startup', async t => {
  const f = await packageFixture(t);
  f.queue.splice(0, 1);
  f.run.config.worktreeRoot = path.join(f.root, 'worktrees');
  fs.mkdirSync(path.join(f.run.config.worktreeRoot, executionId('task:t1')), {recursive: true});
  assert.deepEqual((await nextTask(f.run.config)).candidate.tasks.map(task => task.address), ['task:t1']);
});

test('Joppa package unconfirmed worker outcome remains held', async t => {
  const f = await packageFixture(t, 'outcome-reject');
  Object.assign(f.run.config, {readOnlyRepos: [], gateCommands: ['true'], sshDir: f.root});
  const bins = path.join(f.root, 'bins'), artifacts = path.join(f.run.runFolder, 'fixture/artifacts');
  fs.mkdirSync(bins);
  fs.mkdirSync(artifacts, {recursive: true});
  fs.writeFileSync(path.join(artifacts, 'failure.txt'), 'Gate failed');
  fs.writeFileSync(path.join(bins, 'bash'), '#!/bin/sh\nexit 1\n', {mode: 0o755});
  f.persist();
  const result = await execute(worker, [f.stateFile], {...process.env, PATH: `${bins}:${process.env.PATH}`});
  assert.equal(result.code, 2, result.stderr);
  const saved = read(f.stateFile);
  assert.equal(saved.result.held, true);
  assert.equal(saved.result.blocked, false);
  assert.equal(saved.result.blockConfirmed, undefined);
  assert.match(saved.result.error, /JOPPA_OUTCOME_UNCONFIRMED/);
});

for (const scenario of ['cbm-sync', 'mcp-bridge', 'removed-worktree', 'container-cli-rejected', 'released-startup', 'released-native-run', 'unlabelled-container', 'checkout-present', 'broken-symlink', 'native-run', 'medulla-started', 'docker-present', 'contract-changed', 'unknown-exit', 'surviving-child']) {
  test(`Joppa pre-Medulla startup handling (${scenario}) releases only when unused and confirmed`, async t => {
    const f = await packageFixture(t);
    const worktreeRoot = path.join(f.root, 'worktrees'), bins = path.join(f.root, 'bins'), marker = path.join(f.root, 'ran');
    fs.mkdirSync(worktreeRoot);
    fs.mkdirSync(bins);
    f.run.config.repositories[0].gateCommands = ['true'];
    Object.assign(f.run.config, {worktreeRoot, readOnlyRepos: [], gateCommands: ['true'], sshDir: f.root});
    const checkout = path.join(worktreeRoot, f.run.executionId);
    const synced = '[sync] app: shared CBM refused tools/call: index worker ended with exit_nonzero';
    const line = scenario === 'removed-worktree' ? `run.sh: removed unused worktree: ${checkout}` :
      ['container-cli-rejected', 'released-startup', 'released-native-run', 'unlabelled-container'].includes(scenario) ? `[medulla] session container medulla-sess-test starting\nerror: unrecognized arguments: --node-timeout implement_code=1800\nrun.sh: removed unused worktree: ${checkout}` :
      scenario === 'mcp-bridge' ? 'MCP bridge: failed: no listener could be started' :
      scenario === 'medulla-started' ? `${synced}\n[medulla] session container medulla-sess-1` :
      scenario === 'unknown-exit' ? 'unexpected pre-launch crash' : synced;
    const dockerOutput = scenario === 'docker-present' ? 'echo medulla-sess-1\n' :
      scenario === 'unlabelled-container' ? 'case "$4" in name=*) echo medulla-sess-test;; esac\n' : '';
    fs.writeFileSync(path.join(bins, 'docker'), `#!/bin/sh\n${dockerOutput}exit 0\n`, {mode: 0o755});
    const survivorFile = path.join(f.root, 'survivor.pid');
    const survivor = scenario === 'surviving-child' ? `sleep 60 </dev/null >/dev/null 2>&1 &\necho $! > '${survivorFile}'\n` : '';
    t.after(() => {
      if (fs.existsSync(survivorFile)) {
        try { process.kill(Number(fs.readFileSync(survivorFile, 'utf8')), 'SIGTERM'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    });
    fs.writeFileSync(path.join(bins, 'bash'), `#!/bin/sh\ntouch '${marker}'\nprintf '%s\\r\\n' "${line}" >&2\n${survivor}exit 2\n`, {mode: 0o755});
    if (scenario === 'checkout-present') fs.mkdirSync(checkout);
    if (scenario === 'broken-symlink') fs.symlinkSync(path.join(f.root, 'missing-target'), checkout);
    if (['native-run', 'released-native-run'].includes(scenario)) fs.mkdirSync(path.join(laneRunFolder(f.run.runFolder, f.run.config.id), 'run-1'), {recursive: true});
    const manuallyReleased = scenario.startsWith('released-');
    // An operator removes the assignee while the lane starts.
    if (manuallyReleased) for (const object of [f.objects.get('task:t1'), f.objects.get('task:t2')]) {
      let data = object.document.data;
      Object.defineProperty(object.document, 'data', {enumerable: true,
        get: () => fs.existsSync(marker) ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'assignee')) : data,
        set: value => { data = value; },
      });
    }
    if (scenario === 'contract-changed') {
      const data = f.objects.get('task:t1').document.data, original = data.body;
      Object.defineProperty(data, 'contract', {
        enumerable: true,
        get: () => fs.existsSync(marker) ? `${original}\nChanged: after claim` : original,
      });
    }
    f.persist();
    const result = await execute(worker, [f.stateFile], {...process.env, PATH: `${bins}:${process.env.PATH}`});
    assert.equal(result.code, 2, result.stderr);
    assert.equal(fs.existsSync(marker), true, scenario);
    const saved = read(f.stateFile), released = ['cbm-sync', 'mcp-bridge', 'removed-worktree', 'container-cli-rejected', 'released-startup'].includes(scenario);
    assert.equal(saved.releaseConfirmed === true, released, scenario);
    assert.equal(saved.result.released === true, released, scenario);
    assert.equal(saved.result.held === true, !released, scenario);
    assert.equal(Boolean(saved.result.blocked), false, scenario);
    assert.equal(runHoldsTasks(saved), !released, scenario);
    if (manuallyReleased) assert.equal(f.calls.filter(call => call.name === 'joppa_batch' &&
      call.args.operations.some(item => item.command.op === 'save_object' && !item.command.data.assignee)).length, 0, scenario);
    assert.match(saved.claim.assignee, new RegExp(`^crew-lane:[^:]+:${f.runId}$`), scenario);
    for (const address of ['task:t1', 'task:t2']) {
      assert.equal(f.objects.get(address).document.data.assignee, released || manuallyReleased ? undefined : saved.claim.assignee, scenario);
    }
  });
}
