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

const launcher = fileURLToPath(new URL('../launcher.mjs', import.meta.url));
const worker = fileURLToPath(new URL('../worker.mjs', import.meta.url));

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

async function packageFixture(t, mode = 'success') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-package-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, 'fixture-token');
  const objects = new Map(), calls = [], queue = ['task:t2', 'task:t1'];
  const make = (address, kind, parent, data) => ({address, kind, historical: false, current_revision: 3,
    work_ready: true, review_required: false, document: {present: true, parent, data, links: []},
    process: {status: 'open', assignee: null}});
  objects.set('req:r', make('req:r', 'req', null, {title: 'Requirement'}));
  for (let index = 1; index <= 2; index++) {
    objects.set(`ac:a${index}`, make(`ac:a${index}`, 'ac', 'req:r', {title: `AC ${index}`}));
    objects.set(`task:t${index}`, make(`task:t${index}`, 'task', `ac:a${index}`, {
      title: `[0${index}] Task ${index}`, purpose: 'implementation',
      contract: `Goal: scoped change ${index}\nRepository: app\nModule: m${index}\nChecks: exact check ${index}`}));
  }
  const server = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    let body = '';
    for await (const part of req) body += part;
    const message = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    if (message.method === 'notifications/initialized') { res.writeHead(204).end(); return; }
    if (message.method === 'initialize') {
      res.end(JSON.stringify({jsonrpc: '2.0', id: message.id, result: {protocolVersion: '2025-03-26'}})); return;
    }
    const {name, arguments: args} = message.params;
    calls.push({name, args});
    let value, rejected = false;
    if (name === 'joppa_tree') value = {schema: {types: {req: {role: 'requirement'}, ac: {role: 'ac'}, task: {role: 'task'}}}};
    else if (name === 'joppa_objects') value = args.address ? objects.get(args.address) : {
      items: [...objects.values()].filter(object => object.kind === 'ac').map(object => ({
        address: object.address, revision: object.current_revision, contract_revision: object.contract_revision,
        title: object.document.data.title, work_ready: object.work_ready, review_required: object.review_required,
        process: object.process, work_summary: {active: 0, done: 0}})), next_cursor: null};
    else if (name === 'joppa_tests') value = {items: args.ac.split(',').map(address => ({address, status: 'grey'}))};
    else if (name === 'joppa_tasks') value = args.view === 'mine' ? {total: 0} : {
      tasks: queue.map(address => ({address, revision: 3, title: objects.get(address).document.data.title,
        purpose: objects.get(address).document.data.purpose,
        projects: objects.get(address).document.data.projects || ['project:app'],
        status: objects.get(address).process.status, assignee: objects.get(address).process.assignee}))
        .filter(task => !args.purpose || task.purpose === args.purpose)
        .filter(task => !args.project || task.projects.includes(args.project))
        .filter(task => args.view === 'all' || task.status === 'open' && !task.assignee)};
    else if (name === 'joppa_batch') {
      if (mode === 'release-unknown' && args.operations[0].command.op === 'release_task') {
        res.destroy(); return;
      }
      if (mode === 'reject' || mode === 'outcome-reject' && args.operations[0].command.op !== 'claim_task') {
        rejected = true; value = {error: 'operation 2 revision changed'};
      }
      else {
        value = {results: args.operations.map(({command}, index) => {
          const object = objects.get(command.id);
          if (command.op === 'claim_task') object.process = {status: 'in_progress', assignee: 'lane-1'};
          if (command.op === 'complete_task') {
            assert.match(command.commit, /^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
            object.process = {status: 'done', assignee: null, done: command.evidence,
              commit: mode === 'wrong-commit' ? '0'.repeat(40) : command.commit};
          }
          if (command.op === 'release_task') object.process = {status: 'open', assignee: null, claim: null};
          if (command.op === 'block_task') object.process = {status: 'open', assignee: null,
            blocked: {actor: 'lane-1', position: index + 1, reason: command.reason, evidence: command.evidence}};
          return {command: {...command, id: command.id.split(':')[1]}, object: null, position: index + 1};
        })};
        if (['postclaim-race', 'sameactor-race', 'release-unknown'].includes(mode) && args.operations[0].command.op === 'claim_task') {
          const foreign = structuredClone(objects.get('task:t1'));
          foreign.address = 'task:foreign';
          foreign.document.data.projects = ['project:other'];
          foreign.document.data.contract = 'Repository: app\nModule: unconfigured';
          foreign.process = {status: 'in_progress', assignee: mode === 'sameactor-race' ? 'lane-1' : 'foreign-worker'};
          objects.set(foreign.address, foreign);
          queue.push(foreign.address);
        }
        if (mode === 'incomplete') value.results.pop();
      }
    }
    res.end(JSON.stringify({jsonrpc: '2.0', id: message.id,
      result: {structuredContent: value, ...(rejected ? {isError: true} : {})}}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = {id: 'fixture', source: 'joppa', workspace: 'fixture', stateDir: root, joppa: {url: `http://127.0.0.1:${server.address().port}`,
    project: 'project:app', workers: [{actor: 'lane-1', tokenFile}]}, repositories: [{id: 'app', path: root,
    modules: [{name: 'm1', path: 'src/a', paths: ['src/a', 'tests/a']}, {name: 'm2', path: 'src/b', paths: ['src/b', 'tests/b']}]}]};
  const run = {config, workspace: 'fixture', joppaWorker: config.joppa.workers[0], requirement: 'req:r',
    task: 'task:t1', taskRevision: 3, tasks: [1, 2].map(index => ({address: `task:t${index}`, revision: 3})),
    executionId: executionId('req:r\napp'), runFolder: path.join(root, 'lane')};
  const stateFile = path.join(root, 'launch.json');
  fs.writeFileSync(path.join(root, 'output.log'), '');
  return {root, run, stateFile, calls, objects, queue, persist: () => save(stateFile, run)};
}

test('Joppa selects one executable Task in plan order', async t => {
  const f = await packageFixture(t);
  f.queue.push('task:t1');
  const selected = await nextTask(f.run.config);
  assert.deepEqual(selected.candidate.tasks.map(task => task.address), ['task:t1']);
  assert.equal(selected.candidate.requirement, 'req:r');
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

test('Joppa planner attempt identity keeps the contract revision after a test-list-only save', async t => {
  const f = await packageFixture(t), ac = f.objects.get('ac:a1');
  f.queue.length = 0;
  ac.contract_revision = ac.current_revision;
  const config = {workspace: f.run.workspace, url: f.run.config.joppa.url};
  const before = await readyCriteria(config, f.run.joppaWorker.tokenFile);
  ac.current_revision++;
  ac.document.data.tests = ['checks.test.js > required'];
  const after = await readyCriteria(config, f.run.joppaWorker.tokenFile);
  assert.equal(after.find(row => row.address === ac.address).revision, ac.current_revision);
  assert.deepEqual(after.map(row => row.attemptKey), before.map(row => row.attemptKey));
  const readObject = async (tool, args) => tool === 'joppa_tree' ?
    {schema: {types: {req: {role: 'requirement'}}}} : structuredClone(f.objects.get(args.address));
  assert.deepEqual(await groupRequirements(after, readObject), await groupRequirements(before, readObject));
  ac.contract_revision = ac.current_revision;
  assert.notDeepEqual((await readyCriteria(config, f.run.joppaWorker.tokenFile)).map(row => row.attemptKey),
    before.map(row => row.attemptKey));
});

test('one logged-in user can select independent work while another lane reserves capacity', async t => {
  const f = await packageFixture(t), config = f.run.config;
  const proxy = path.join(f.root, 'connector.mjs');
  const module = new URL('../joppa-api.mjs', import.meta.url).href;
  fs.writeFileSync(proxy, `import {callJoppa} from ${JSON.stringify(module)};
import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);if(!('id' in r))continue;
 const result=r.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:
  {structuredContent:await callJoppa(process.argv[2],process.argv[3],r.params.name,r.params.arguments)};
 console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
}`);
  config.joppa.mcpCommand = [process.execPath, proxy, config.joppa.url, config.joppa.workers[0].tokenFile];
  delete config.joppa.workers[0].tokenFile;
  const reserved = path.join(f.root, 'runs', 'active');
  fs.mkdirSync(reserved, {recursive: true});
  save(path.join(reserved, 'launch.json'), {...f.run, requirement: 'req:other', repositoryId: 'app'});
  const selected = await nextTask(config);
  assert.equal(selected.candidate.id, 'task:t1');
  assert.equal(f.calls.some(call => call.name === 'joppa_tasks' && call.args.view === 'mine'), false);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

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
    held.document.data.contract = held.document.data.contract.replace('Repository: app', 'Repository: other');
    f.run.config.repositories.push({...f.run.config.repositories[0], id: 'other'});
  }
  const selected = await nextTask(f.run.config);
  if (sameRepository) assert.equal(selected.candidate, null);
  else assert.deepEqual(selected.candidate.tasks.map(task => task.address), ['task:t1']);
});

for (const configured of [false, true]) test(`Joppa package scans cross-project holders; configured repository=${configured}`, async t => {
  const f = await packageFixture(t), foreign = f.objects.get('task:t2');
  foreign.document.data.projects = ['project:other'];
  foreign.document.data.contract = `Repository: ${configured ? 'app' : 'unconfigured'}\nModule: absent`;
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
  if (state === 'retained') assert.equal(selected.candidate, null);
  else assert.deepEqual(selected.candidate.tasks.map(task => task.address), ['task:t1']);
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
    if (manuallyReleased) for (const object of [f.objects.get('task:t1'), f.objects.get('task:t2')]) {
      let process = object.process;
      Object.defineProperty(object, 'process', {enumerable: true,
        get: () => fs.existsSync(marker) ? {status: 'open', assignee: null} : process,
        set: value => { process = value; },
      });
    }
    if (scenario === 'contract-changed') {
      const data = f.objects.get('task:t1').document.data, original = data.contract;
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
      call.args.operations.some(item => item.command.op === 'release_task')).length, 0, scenario);
    for (const address of ['task:t1', 'task:t2']) {
      assert.equal(f.objects.get(address).process.status, released || manuallyReleased ? 'open' : 'in_progress', scenario);
      assert.equal(f.objects.get(address).process.assignee, released || manuallyReleased ? null : 'lane-1', scenario);
    }
  });
}

function blockedPackage(f) {
  const root = path.join(f.root, 'worktrees'), runs = path.join(f.root, 'receipts');
  fs.mkdirSync(root);
  const runId = '11111111-1111-4111-8111-111111111111';
  fs.mkdirSync(path.join(runs, runId), {recursive: true});
  const run = {...f.run, repositoryId: 'app', config: {...f.run.config, worktreeRoot: root},
    claim: {tasks: f.run.tasks}, result: {code: 1, blockConfirmed: true, finishedAt: new Date().toISOString()}};
  const folder = path.join(root, run.executionId);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'retained.txt'), 'Retained package work');
  save(path.join(runs, runId, 'launch.json'), run);
  const tasks = f.run.tasks.map(({address}) => ({address, kind: 'task', process: {
    status: 'open', assignee: null, blocked: {reason: 'GATE_FAIL', evidence: `Run: ${runId}`}}}));
  const operations = tasks.map(task => ({command: {op: 'retire_task', id: task.address.split(':')[1]}}));
  return {root, runs, run, folder, runId, input: {tasks, operations, config: {workspace: 'fixture',
    url: f.run.config.joppa.url, worktree_root: root, lane_runs_folder: runs, repositories: [{path: f.root}]}}};
}

test('Joppa package cleanup removes its recorded shared checkout once', async t => {
  const f = await packageFixture(t), blocked = blockedPackage(f);
  const prepared = cleanupBlockedTasks(blocked.input);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].folder, blocked.folder);
  assert.equal(fs.existsSync(blocked.folder), false);
});

for (const state of ['confirmed', 'overlapping', 'unconfirmed', 'newer']) {
  test(`Joppa package cleanup handles ${state} success before another failed package`, async t => {
    const f = await packageFixture(t), blocked = blockedPackage(f);
    blocked.run.createdAt = '2026-10-14T12:00:00.000Z';
    save(path.join(blocked.runs, blocked.runId, 'launch.json'), blocked.run);
    const folder = path.join(blocked.runs, '33333333-3333-4333-8333-333333333333');
    fs.mkdirSync(folder);
    const tasks = state === 'overlapping' ? blocked.run.tasks : [{address: 'task:old1'}, {address: 'task:old2'}];
    const earlier = {...blocked.run, task: tasks[0].address, tasks, claim: {tasks},
      createdAt: '2026-10-14T10:00:00.000Z', result: {code: 0, completed: state !== 'unconfirmed',
        finishedAt: state === 'newer' ? '2026-10-14T13:00:00.000Z' : '2026-10-14T11:00:00.000Z'}};
    save(path.join(folder, 'launch.json'), earlier);
    if (state === 'confirmed') {
      const prepared = cleanupBlockedTasks(blocked.input, {dryRun: true});
      assert.equal(prepared.length, 1);
      assert.equal(prepared[0].folder, blocked.folder);
    } else {
      const error = state === 'overlapping' ? /successful receipt overlaps/ :
        state === 'newer' ? /not historical/ : /unconfirmed successful/;
      assert.throws(() => cleanupBlockedTasks(blocked.input, {dryRun: true}), error);
    }
    assert.equal(fs.existsSync(path.join(blocked.folder, 'retained.txt')), true);
  });
}

test('Joppa package cleanup refuses an incomplete AC scope before deleting any checkout', async t => {
  const f = await packageFixture(t), blocked = blockedPackage(f);
  blocked.input.tasks = [blocked.input.tasks[1]];
  blocked.input.operations = [blocked.input.operations[1]];
  assert.throws(() => cleanupBlockedTasks(blocked.input), /every blocked Task.*whole Requirement/);
  assert.equal(fs.existsSync(path.join(blocked.folder, 'retained.txt')), true);
});

test('Joppa package cleanup requires an operation for every retained Task', async t => {
  const f = await packageFixture(t), blocked = blockedPackage(f);
  blocked.input.operations.pop();
  assert.throws(() => cleanupBlockedTasks(blocked.input), /Every blocked Task needs/);
  assert.equal(fs.existsSync(path.join(blocked.folder, 'retained.txt')), true);
});

test('Joppa package cleanup preserves legacy single-Task receipts', async t => {
  const f = await packageFixture(t), blocked = blockedPackage(f);
  const run = {...blocked.run, executionId: executionId('task:t1')};
  delete run.tasks;
  run.claim = {claimed: true};
  const folder = path.join(blocked.root, run.executionId);
  fs.renameSync(blocked.folder, folder);
  blocked.input.tasks.pop();
  blocked.input.operations.pop();
  save(path.join(blocked.runs, blocked.runId, 'launch.json'), run);
  assert.equal(cleanupBlockedTasks(blocked.input)[0].folder, folder);
  assert.equal(fs.existsSync(folder), false);
});

for (const state of ['live', 'held', 'uncertain']) test(`Joppa package cleanup refuses a ${state} sibling run`, async t => {
  const f = await packageFixture(t), blocked = blockedPackage(f);
  const folder = path.join(blocked.runs, '22222222-2222-4222-8222-222222222222');
  fs.mkdirSync(folder);
  const active = {...blocked.run, task: 'task:t2', tasks: [{address: 'task:t2'}]};
  if (state === 'live') delete active.result;
  if (state === 'held') active.result = {code: 2, held: true, finishedAt: new Date().toISOString()};
  if (state === 'uncertain') {
    delete active.claim;
    active.claimRequest = {operations: [{command: {op: 'claim_task', id: 'task:t2'}}]};
    active.result = {code: 2, finishedAt: new Date().toISOString()};
  }
  save(path.join(folder, 'launch.json'), active);
  assert.throws(() => cleanupBlockedTasks(blocked.input), /Active, held or unconfirmed/);
  assert.equal(fs.existsSync(path.join(blocked.folder, 'retained.txt')), true);
});

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

function packageLanding(f) {
  const remote = path.join(f.root, 'remote.git');
  const git = (args, input) => {
    const result = spawnSync('git', args, {encoding: 'utf8', input, env: {...process.env,
      GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com'}});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--bare', remote]);
  const tree = git(['-C', remote, 'mktree'], '');
  const sha = git(['-C', remote, 'commit-tree', tree, '-m', 'Checked fixture']);
  git(['-C', remote, 'update-ref', 'refs/heads/checked-package', sha]);
  git(['-C', remote, 'config', 'remote.origin.url', remote]);
  f.run.repository.path = remote;
  f.run.repository.targetBranch = 'main';
  f.run.deliveryBranch = 'checked-package';
  f.run.config.delivery = 'branch';
  f.run.config.sshDir = f.root;
  const artifacts = path.join(f.root, 'artifacts');
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'landing.txt'), `Landed SHA: ${sha}\nTarget: checked-package\n`);
  return artifacts;
}

test('Joppa package completes every Task atomically with the same checked landing', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist);
  const artifacts = packageLanding(f), result = {code: 0, status: 'exited'};
  await finishTask(f.run, f.stateFile, result, artifacts);
  assert.equal(result.completed, true);
  assert.deepEqual(result.tasks.map(task => [task.address, task.status]), [['task:t1', 'done'], ['task:t2', 'done']]);
  const operations = f.run.completionRequest.operations;
  const landing = fs.readFileSync(path.join(artifacts, 'landing.txt'), 'utf8').trim();
  assert.equal(operations.length, 2);
  operations.forEach(({command}, index) => {
    assert.equal(command.id, `task:t${index + 1}`);
    assert.match(command.evidence, new RegExp(`Task: task:t${index + 1}`));
    assert.equal(command.evidence.startsWith(landing), true);
    assert.equal(command.commit, landing.match(/^Landed SHA: ([0-9a-f]+)$/m)[1]);
  });
});

test('Joppa completion names the checked existing commit without Task verification fields', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist);
  const artifacts = packageLanding(f);
  const evidence = fs.readFileSync(path.join(artifacts, 'landing.txt'), 'utf8');
  const sha = evidence.match(/^Landed SHA: ([0-9a-f]+)$/m)[1];
  f.run.repository.targetBranch = 'checked-package';
  fs.unlinkSync(path.join(artifacts, 'landing.txt'));
  fs.writeFileSync(path.join(artifacts, 'verification.txt'), evidence.replace('Landed SHA:', 'Verified existing SHA:'));
  const result = {code: 0, status: 'exited'};
  await finishTask(f.run, f.stateFile, result, artifacts);
  assert.equal(result.completed, true);
  assert(f.run.completionRequest.operations.every(({command}) => command.commit === sha));
  assert(f.run.tasks.every(({address}) => !('verification' in f.objects.get(address).process)));
});

test('Joppa completion keeps a Task current after a parent test-list-only save', async t => {
  const f = await packageFixture(t), parent = f.objects.get('ac:a2');
  parent.contract_revision = parent.current_revision;
  parent.document.data.tests = ['checks.test.js > first'];
  await claimTask(f.run, f.persist);
  const artifacts = packageLanding(f);
  parent.current_revision++;
  parent.document.data.tests = ['checks.test.js > replacement'];
  const result = {code: 0, status: 'exited'};
  await finishTask(f.run, f.stateFile, result, artifacts);
  assert.equal(result.completed, true);
  parent.document.data.title += ' changed';
  assert.notEqual(contractDigest(parent), f.run.claim.contexts.find(context => context.address === parent.address).digest);
});

test('Joppa completion refuses a different confirmed commit', async t => {
  const f = await packageFixture(t, 'wrong-commit');
  await claimTask(f.run, f.persist);
  const artifacts = packageLanding(f), result = {code: 0, status: 'exited'};
  await assert.rejects(finishTask(f.run, f.stateFile, result, artifacts), /did not confirm.*checked SHA/);
  assert.equal(result.completed, undefined);
});

test('Joppa completion preserves an older saved request without silently adding commit', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist);
  const artifacts = packageLanding(f);
  f.run.completionRequest = {workspace: f.run.workspace, request_id: 'saved-before-upgrade',
    operations: [{command: {op: 'complete_task', id: 'task:t1', revision: 3, evidence: 'Earlier request'}}]};
  const saved = structuredClone(f.run.completionRequest), calls = f.calls.length;
  await assert.rejects(finishTask(f.run, f.stateFile, {code: 0, status: 'exited'}, artifacts), /Saved completion request/);
  assert.deepEqual(f.run.completionRequest, saved);
  assert(!f.calls.slice(calls).some(call => call.name === 'joppa_batch'));
});

for (const address of ['ac:a2', 'req:r']) test(`Joppa package refuses completion after ${address} context changes`, async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist);
  const artifacts = packageLanding(f);
  f.objects.get(address).document.data.title += ' changed';
  await assert.rejects(finishTask(f.run, f.stateFile, {code: 0, status: 'exited'}, artifacts), /context changed/);
  assert.equal(f.run.completionRequest, undefined);
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 1);
  for (const task of f.run.tasks) assert.equal(f.objects.get(task.address).process.status, 'in_progress');
});

test('Joppa package preserves a single Task ticket and execution identifier', async t => {
  const f = await packageFixture(t);
  f.run.tasks = [f.run.tasks[0]];
  f.run.executionId = executionId(f.run.task);
  await claimTask(f.run, f.persist);
  assert.equal(f.run.claim.id, executionId('task:t1'));
  assert.equal(f.run.claim.ticket.id, executionId('task:t1'));
  assert.equal(f.run.claim.ticket.body, f.objects.get('task:t1').document.data.contract);
  assert.deepEqual(f.run.claim.ticket.modulePaths, ['src/a', 'tests/a']);
  assert.equal(f.run.claim.digest, f.run.claim.tasks[0].digest);
});

test('runtime settings come from the selected config, without a broker profile', async t => {
  const f = await setup(t);
  save(f.configFile, {...f.config, image: 'crew-fixture:tests', dockerEngine: true});
  const config = configFrom(f.configFile, f.env);
  const args = laneArgs(config, 'T1');
  assert.equal(args[args.indexOf('--image') + 1], 'crew-fixture:tests');
  assert.ok(args.includes('--docker-engine'));
  assert.ok(!args.includes('--box'));
  assert.ok(!laneArgs({...config, dockerEngine: false}, 'T1').includes('--docker-engine'));
  save(f.configFile, {...f.config, dockerEngine: 'true'});
  assert.throws(() => configFrom(f.configFile, f.env), /dockerEngine must be/);
});
test('unsupported private Docker fails before reading or claiming a ticket', async t => {
  const f = await setup(t);
  save(f.configFile, {...f.config, dockerEngine: true});
  const result = await execute(launcher, [f.configFile, '--once'], f.env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /requires Medulla with --docker-engine support/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.events), false);
});
test('unsupported coder timeout fails before reading or claiming a ticket', async t => {
  const f = await setup(t);
  save(f.configFile, {...f.config, coderTimeoutSeconds: 1800});
  const result = await execute(launcher, [f.configFile, '--once'], f.env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /requires Medulla with --node-timeout support/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.events), false);
});
test('launches require sourceRoot and pass no repository override', async t => {
  const f = await setup(t);
  const args = laneArgs(configFrom(f.configFile, f.env), 'T1');
  assert.equal(args[args.indexOf('--source-root') + 1], f.config.sourceRoot);
  assert.ok(!args.includes('--repo') && !args.includes('--mount-rw'));
  const {sourceRoot, ...missing} = f.config;
  save(f.configFile, missing);
  assert.throws(() => configFrom(f.configFile, f.env), /needs sourceRoot/);
  save(f.configFile, {...f.config, repo: path.join(f.root, 'sources/repo')});
  assert.throws(() => configFrom(f.configFile, f.env), /repo was removed/);
});
test('worker records completion before notifying; Telegram failure preserves lane outcome', async t => {
  const f = await setup(t);
  fs.writeFileSync(path.join(f.bins, 'bash'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const dir = path.join(f.root, 'worker');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'launch.json');
  save(file, {config: {...f.config, notify: {chatId: 'fixture'}},
    ticket: 'T1', workspace: 'test', args: [], pane: 'fixture', runFolder: path.join(dir, 'lane')});
  const sent = path.join(dir, 'sent.json');
  const result = await execute(worker, [file], notificationEnv(f, file, sent, true));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(read(path.join(dir, 'launch.json')).result.code, 0);
  assert.equal(read(sent).text, '🟢 READY\nTicket: T1');
  assert.match(read(path.join(dir, 'notification-error.json')).error, /fixture delivery failure/);
});
const queueReads = f => f.calls.filter(call => call.url.startsWith('/v1/tickets/next')).length;
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
const countReads = f => f.calls.filter(call => call.method === 'GET' && call.url.startsWith('/v1/tickets?'));
const queueQuery = f => new URL(f.calls.find(call => call.url.startsWith('/v1/tickets/next')).url, 'http://fixture');
const runState = f => {
  const [runId] = fs.readdirSync(path.join(f.stateDir, 'runs'));
  return path.join(f.stateDir, 'runs', runId);
};
function existingClaim(f, dir) {
  const file = path.join(dir, 'launch.json'), run = read(file);
  run.claim = {id: 'T1', status: 'in_progress', claimed: true, workspace: 'test'};
  save(file, run);
  f.setStatus('in_progress');
  return run;
}
function execute(script, args, env, {bin = process.execPath, cwd} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [script, ...args], {env, cwd});
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}
function notificationEnv(f, stateFile, sentFile, fail = false) {
  const preload = path.join(f.root, 'telegram-fixture.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith('https://api.telegram.org/')) return original(url, options);
  if (!JSON.parse(fs.readFileSync(process.env.TEST_RESULT)).result) throw new Error('completion not saved');
  fs.writeFileSync(process.env.TEST_NOTIFY, options.body);
  if (process.env.TEST_NOTIFY_FAILURE === '1') throw new Error('fixture delivery failure');
  return {ok: true, json: async () => ({ok: true})};
};
`);
  return {...f.env, TEST_RESULT: stateFile, TEST_NOTIFY: sentFile, TELEGRAM_BOT_TOKEN: 'fixture-token',
    TEST_NOTIFY_FAILURE: fail ? '1' : '0', NODE_OPTIONS: `--import=${preload}`};
}
async function setup(t, {empty = false, dockerFailure = false, launchLanes = true, claimRefused = false, claimHttpStatus = 409, claimResponse, reportUploadFailure = false, countFailure = false, noReady = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-launcher-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const bins = path.join(root, 'bin');
  fs.writeFileSync(path.join(root, 'cbm-mcp.py'), '# connector fixture\n');
  for (const dir of [bins, path.join(root, 'sources/repo/.git'), path.join(root, 'ssh'),
    path.join(root, 'sources/locks'), path.join(root, 'cbm-cache')]) {
    fs.mkdirSync(dir, {recursive: true});
  }
  const events = path.join(root, 'events.jsonl'), panes = path.join(root, 'panes.json');
  fs.writeFileSync(panes, '[]');
  const herdr = path.join(bins, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_EVENTS, JSON.stringify(args) + '\\n');
const panes = JSON.parse(fs.readFileSync(process.env.TEST_PANES));
let result = {};
if (args[0] === 'tab' && args[1] === 'create') {
  fs.appendFileSync(process.env.TEST_REQUESTS, 'HERDR_TAB_CREATE\\n');
  if (process.env.TEST_CREATE_FAILURE === '1') process.exit(1);
  panes.push({pane_id: 'test-pane'});
  fs.writeFileSync(process.env.TEST_PANES, JSON.stringify(panes));
  result = {root_pane: {pane_id: 'test-pane'}};
}
if (args[1] === 'list') result = {panes};
if (args[1] === 'close' && process.env.TEST_RESULT) {
  if (!JSON.parse(fs.readFileSync(process.env.TEST_RESULT)).result) process.exit(2);
}
if (args[1] === 'run' && process.env.TEST_RUN_FAILURE === '1') process.exit(1);
if (args[0] === 'pane' && ['run', 'close'].includes(args[1])) process.exit(0);
console.log(JSON.stringify({result}));
`, {mode: 0o755});
  fs.writeFileSync(path.join(bins, 'docker'), '#!/bin/sh\nif [ "$TEST_DOCKER_FAILURE" = 1 ]; then exit 1; fi\ncat "$TEST_DOCKER"\n', {mode: 0o755});
  for (const bin of ['medulla', 'jq']) fs.writeFileSync(path.join(bins, bin), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const docker = path.join(root, 'docker.jsonl');
  fs.writeFileSync(docker, '');
  const calls = [], requests = path.join(root, 'requests.log');
  let ticketStatus = 'open';
  fs.writeFileSync(requests, '');
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({method: req.method, url: req.url,
      body: body ? (req.headers['content-type']?.startsWith('application/json') ? JSON.parse(body) : body) : null});
    fs.appendFileSync(requests, `${req.method} ${req.url}\n`);
    if (req.method === 'GET' && req.url.startsWith('/v1/tickets?')) {
      const query = new URL(req.url, 'http://fixture');
      assert.equal(query.searchParams.get('count'), 'true');
      assert.equal(query.searchParams.get('all'), 'true');
      res.writeHead(countFailure ? 503 : 200);
      res.end(JSON.stringify(countFailure ? {error: 'count unavailable'} :
        {count: empty ? 0 : query.searchParams.get('status') === 'open' ? 17 : 56}));
    }
    else if (empty || (noReady && req.url.startsWith('/v1/tickets/next'))) { res.writeHead(204); res.end(); }
    else if (req.url.startsWith('/v1/tickets/T1/start') && claimRefused) {
      res.writeHead(claimHttpStatus); res.end('{"error":"fixture conflict"}');
    }
    else if (req.url.startsWith('/v1/tickets/T1/start') && claimResponse !== undefined) {
      res.end(JSON.stringify(claimResponse));
    }
    else if (req.url.startsWith('/v1/tickets/T1/start')) {
      ticketStatus = 'in_progress';
      res.end('{"id":"T1","status":"in_progress","claimed":true}');
    }
    else if (req.url === '/v1/tickets/T1/attachments') {
      res.end(JSON.stringify({url: `http://127.0.0.1:${server.address().port}/startup-upload`, object_key: 'startup/report'}));
    }
    else if (req.url === '/startup-upload') {
      res.writeHead(reportUploadFailure ? 503 : 200); res.end();
    }
    else if (req.method === 'GET') res.end(JSON.stringify({ticket: {id: 'T1', status: ticketStatus}}));
    else if (req.method === 'PATCH') {
      ticketStatus = JSON.parse(body).status;
      res.end(JSON.stringify({id: 'T1', status: ticketStatus}));
    }
    else res.end('{"id":"T1","status":"open","claimed":false}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = {id: 'test-project', workspace: 'test', project: 'project', tags: ['crew'], strict: true,
    launchLanes, sourceRoot: path.join(root, 'sources'),
    cbmMcpCommand: path.join(root, 'cbm-mcp.py'), cbmCacheDir: path.join(root, 'cbm-cache'), sshDir: path.join(root, 'ssh'), gateCommands: ['true'],
    testCommand: ['true'], sharedLockDir: path.join(root, 'sources/locks'),
    stateDir: path.join(root, 'state'), herdr, herdrWorkspace: 'different-config-workspace'};
  const configFile = path.join(root, 'config.json');
  save(configFile, config);
  const env = {...process.env, PATH: `${bins}:${process.env.PATH}`,
    HERDR_WORKSPACE_ID: 'workspace',
    TEST_EVENTS: events, TEST_PANES: panes, TEST_DOCKER: docker, TEST_REQUESTS: requests,
    TEST_DOCKER_FAILURE: dockerFailure ? '1' : '0', NTK_CONFIG: path.join(root, 'absent'),
    NTK_URL: `http://127.0.0.1:${server.address().port}`, NTK_KEY: 'fixture-key'};
  return {root, config, stateDir: scopeDirectory(config.stateDir, config.id), configFile, env, calls, events, docker, bins,
    setStatus: value => { ticketStatus = value; },
    run: () => execute(launcher, ['--config', configFile, '--once'], env)};
}

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
for (const scenario of ['blocked', 'upload-failed', 'done', 'unclaimed', 'adopted', 'unrelated-code']) {
  test(`preexisting worktree startup: ${scenario}`, async t => {
    const f = await setup(t, {reportUploadFailure: scenario === 'upload-failed', claimRefused: scenario === 'unclaimed'});
    assert.equal((await f.run()).code, 0);
    const dir = runState(f), file = path.join(dir, 'launch.json');
    const run = ['done', 'adopted'].includes(scenario) ? existingClaim(f, dir) : read(file);
    const reason = 'WORKTREE PREEXISTED: /fixture/.worktrees/T1; retained unchanged; inspect before retrying';
    fs.writeFileSync(path.join(f.bins, 'bash'), `#!/bin/sh\necho 'run.sh: ${scenario === 'unrelated-code' ? 'unrelated failure' : reason}' >&2\nexit 73\n`, {mode: 0o755});
    if (scenario === 'done') f.setStatus('done');
    if (scenario === 'unclaimed') { delete run.claim; save(file, run); }
    if (scenario === 'adopted') {
      const artifacts = path.join(run.runFolder, 'fixture', 'artifacts');
      fs.mkdirSync(artifacts, {recursive: true});
      save(path.join(artifacts, 'claim.json'), {...run.claim, run_dir: path.dirname(artifacts)});
    }
    const output = await execute(worker, [file], f.env);
    const result = read(path.join(dir, 'launch.json')).result;
    const blocked = scenario === 'blocked' || scenario === 'upload-failed';
    assert.equal(result.blocked === true, blocked);
    assert.equal(result.reopened === true, scenario === 'unrelated-code');
    const patches = f.calls.filter(call => call.method === 'PATCH');
    assert.equal(patches.length, blocked || scenario === 'unrelated-code' ? 1 : 0);
    if (blocked) {
      assert.deepEqual(patches[0].body, {workspace: 'test', status: 'blocked', force: true,
        tag_edits: ['+worktree_preexistited']});
      assert.equal(result.error, reason);
      assert.match(output.stdout, /T1 blocked: WORKTREE PREEXISTED/);
      assert.match(fs.readFileSync(path.join(dir, 'startup-failure.txt'), 'utf8'), /Worktree and branches were not modified/);
      const upload = f.calls.find(call => call.url === '/startup-upload');
      assert.ok(upload.body.includes(reason));
      assert.equal(f.calls.some(call => call.url.endsWith('/attachments/commit')), scenario === 'blocked');
      assert.equal(Boolean(result.reportError), scenario === 'upload-failed');
    }
    if (scenario === 'done') assert.match(result.blockError, /Ticket changed/);
  });
}
test('existing external Docker lane prevents a queue read', async t => {
  const f = await setup(t);
  fs.writeFileSync(f.docker, JSON.stringify({workflow: 'lane', runFolder: scopeDirectory('/manual, runs', f.config.id)}));
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(queueReads(f), 0);
  assert.equal(countReads(f).length, 0);
  assert.doesNotMatch(result.stdout, /Tickets with tags/);
});
test('another dispatcher and unscoped containers do not occupy this dispatcher', async t => {
  const f = await setup(t);
  fs.writeFileSync(f.docker, [
    {workflow: 'lane', runFolder: scopeDirectory('/manual', f.config.id + '-other')},
    {workflow: 'lane', runFolder: ''},
    {workflow: '', runFolder: ''},
    {workflow: 'planning', runFolder: scopeDirectory('/manual', f.config.id)},
  ].map(row => JSON.stringify(row)).join('\n'));
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running lanes 0 of 1/);
  assert.equal(queueReads(f), 1);
});
test('config IDs isolate reservations and locks in the same state root', async t => {
  const f = await setup(t);
  assert.equal((await f.run()).code, 0);
  fs.mkdirSync(path.join(f.stateDir, 'dispatcher.lock'));
  const otherFile = path.join(f.root, 'other.json');
  save(otherFile, {...f.config, id: 'other-project'});
  const result = await execute(launcher, ['--config', otherFile, '--once'], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running lanes 0 of 1/);
  assert.equal(queueReads(f), 2);
  const other = configFrom(otherFile, f.env);
  const [runId] = fs.readdirSync(path.join(other.stateDir, 'runs'));
  const run = read(path.join(other.stateDir, 'runs', runId, 'launch.json'));
  assert.equal(run.args[run.args.indexOf('--dispatcher-id') + 1], 'other-project');
  assert.equal(laneRunFolder(run.runFolder, 'other-project'), run.runFolder);
  assert.ok(fs.existsSync(path.join(f.stateDir, 'dispatcher.lock')));
});
test('completed lane frees capacity even when its Herdr tab remains', async t => {
  const f = await setup(t);
  assert.equal((await f.run()).code, 0);
  const [runId] = fs.readdirSync(path.join(f.stateDir, 'runs'));
  save(path.join(f.stateDir, 'runs', runId, 'launch.json'), {...read(path.join(f.stateDir, 'runs', runId, 'launch.json')), result: {status: 'exited', code: 0}});
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running lanes 0 of 1/);
  assert.equal(queueReads(f), 2);
});
test('dispatcher IDs are stable path-safe identities, including manual lanes', () => {
  assert.equal(validateId('Project-Backend'), 'project-backend');
  for (const id of ['', '../other', 'a/b', 'a,b', 'has space', 'a'.repeat(65), undefined]) {
    assert.throws(() => validateId(id), /needs id/);
  }
  const folder = laneRunFolder('/manual/runs', 'project-backend');
  assert.equal(folder, '/manual/runs/crew-dispatchers/project-backend');
  assert.equal(laneRunFolder(folder, 'project-backend'), folder);
  assert.throws(() => laneRunFolder(folder, 'another'), /another dispatcher/);
});
test('Docker failure fails closed before any queue read', async t => {
  const f = await setup(t, {dockerFailure: true});
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.equal(f.calls.length, 0);
});
test('empty queue leaves Herdr tabs unchanged', async t => {
  const f = await setup(t, {empty: true});
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Tickets with tags \[workspace=test, tags=crew, strict=true\]: 0 open · ready to work: 0/);
  assert.ok(!fs.readFileSync(f.events, 'utf8').includes('create'));
});
test('count failure reports unavailable and still dispatches the next ticket', async t => {
  const f = await setup(t, {countFailure: true});
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Tickets with tags \[workspace=test, tags=crew, strict=true\]: unavailable/);
  assert.match(result.stdout, /Starting new one with ticket: T1/);
  assert.equal(queueReads(f), 1);
  assert.ok(!f.calls.some(call => call.url.startsWith('/v1/tickets/T1/start')));
});
test('open tickets with no NTK candidate show blocked and zero ready without claiming', async t => {
  const f = await setup(t, {noReady: true});
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /17 open \(blocked\) · ready to work: 0/);
  assert.equal(queueReads(f), 1);
  assert.ok(!f.calls.some(call => call.url.startsWith('/v1/tickets/T1/start')));
  assert.ok(!fs.readFileSync(f.events, 'utf8').includes('create'));
});
test('lock refuses a second dispatcher before it selects work', async t => {
  const f = await setup(t);
  fs.mkdirSync(path.join(f.stateDir, 'dispatcher.lock'), {recursive: true});
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Dispatcher lock exists/);
  assert.equal(f.calls.length, 0);
});
test('Docker and its pending reservation count as one lane', async t => {
  const f = await setup(t);
  const dir = path.join(f.stateDir, 'runs', 'test');
  fs.mkdirSync(dir, {recursive: true});
  const runFolder = path.join(f.stateDir, 'runs/test/lane');
  save(path.join(dir, 'launch.json'), {runFolder, pane: 'test-pane'});
  const containers = dockerLanes(JSON.stringify({workflow: 'lane', runFolder}), f.config);
  assert.equal(activeCount({...f.config, stateDir: f.stateDir}, containers, new Set(['test-pane'])), 1);
});
test('dolber.sh reads adjacent dolber.json from another cwd and only previews with configured filters', async t => {
  const f = await setup(t, {launchLanes: false});
  const folder = path.join(f.root, 'dolber folder');
  fs.mkdirSync(folder);
  for (const file of ['dolber.sh', 'launcher.mjs', 'runtime.mjs', 'ntk.mjs', 'scope.mjs',
    'dashboard.mjs', 'joppa.mjs', 'joppa-api.mjs', 'mcp-client.mjs', 'dependencies.mjs',
    'requirement-delivery.mjs', 'publication-guard.mjs', 'requirement-finalizer.mjs']) {
    fs.copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), path.join(folder, file));
  }
  fs.copyFileSync(fileURLToPath(new URL('../../notify.mjs', import.meta.url)), path.join(f.root, 'notify.mjs'));
  const config = {...f.config, tags: ['open', 'agent-ready'], strict: false,
    preferTags: ['KYC', 'ceo60', 'KYT'], intervalSeconds: 60,
    project: '', sourceRoot: '', cbmMcpCommand: '', sshDir: '', gateCommands: []};
  delete config.launchLanes; // Omission must also default to preview.
  save(path.join(folder, 'dolber.json'), config);
  const result = await execute(path.join(folder, 'dolber.sh'), ['--once'], f.env,
    {bin: 'bash', cwd: f.root});
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split('\n').filter(line => !/^─+$/.test(line));
  assert.equal(lines[0], 'Running lanes 0 of 1');
  assert.equal(lines[1], 'Tickets with tags [workspace=test, tags=open,agent-ready, strict=false]: 17 open · ready to work: ≥1');
  assert.equal(lines[2], 'checking params:');
  assert.equal(lines[3], '  tags: open, agent-ready');
  assert.equal(lines[4], '  prefer: KYC → ceo60 → KYT');
  assert.equal(lines[5], 'Starting new one with ticket: T1 (preview: запуск отключён)');
  const query = queueQuery(f);
  assert.equal(query.searchParams.get('tag'), 'open,agent-ready');
  assert.equal(query.searchParams.get('prefer'), 'KYC,ceo60,KYT');
  assert.equal(query.searchParams.get('strict'), 'false');
  assert.equal(query.searchParams.get('dry_run'), 'true');
  assert.equal(query.searchParams.has('project'), false);
  assert.equal(f.calls.length, 2);
  for (const call of countReads(f)) {
    const countQuery = new URL(call.url, 'http://fixture');
    assert.equal(countQuery.searchParams.get('workspace'), 'test');
    assert.equal(countQuery.searchParams.get('tag'), 'open,agent-ready');
    assert.equal(countQuery.searchParams.get('strict'), 'false');
    assert.equal(countQuery.searchParams.has('project'), false);
    assert.equal(countQuery.searchParams.has('prefer'), false);
  }
  assert.ok(!fs.existsSync(f.events), 'preview must not call Herdr at all');
  assert.deepEqual(runDirectories(f.stateDir), []);
});
test('--dry-run overrides live config, previews once and never calls Herdr or claims work', async t => {
  const f = await setup(t);
  save(f.configFile, {...f.config, project: '', sourceRoot: '', cbmMcpCommand: '', sshDir: '', gateCommands: []});
  const before = fs.readFileSync(f.configFile, 'utf8');
  fs.rmSync(path.join(f.bins, 'medulla'));
  fs.rmSync(path.join(f.bins, 'jq'));
  const result = await execute(fileURLToPath(new URL('../dolber.sh', import.meta.url)),
    [path.basename(f.configFile), '--dry-run'], f.env, {bin: 'sh', cwd: f.root});
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /T1 \(preview: запуск отключён\)/);
  assert.doesNotMatch(result.stdout, /pause /);
  assert.equal(f.calls.length, 2);
  const query = queueQuery(f);
  assert.equal(query.pathname, '/v1/tickets/next');
  assert.equal(query.searchParams.get('dry_run'), 'true');
  assert.ok(!fs.existsSync(f.events));
  assert.deepEqual(runDirectories(f.stateDir), []);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
});
test('--dry-run exits with an error when Docker cannot be inspected', async t => {
  const f = await setup(t, {dockerFailure: true});
  const result = await execute(launcher, ['--config', f.configFile, '--dry-run'], f.env);
  assert.equal(result.code, 1);
  assert.equal(f.calls.length, 0);
  assert.ok(!fs.existsSync(f.events));
});
test('preview loop repeats after its interval and Ctrl+C releases the dispatcher lock', async t => {
  const f = await setup(t, {launchLanes: false});
  save(f.configFile, {...f.config, intervalSeconds: 1});
  const child = spawn(process.execPath, [launcher, '--config', f.configFile], {env: f.env});
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '', signalled = false;
  child.stdout.on('data', data => {
    output += data;
    if (!signalled && (output.match(/preview: запуск отключён/g) || []).length === 2) {
      signalled = true;
      child.kill('SIGINT');
    }
  });
  child.stderr.on('data', data => errors += data);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('loop did not stop')); }, 5000);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(code, 0, errors);
  assert.equal(f.calls.length, 4);
  assert.ok(!fs.existsSync(f.events));
  assert.ok(!fs.existsSync(path.join(f.stateDir, 'dispatcher.lock')));
});
test('terminal dashboard refreshes the countdown and Ctrl+C releases the lock', async t => {
  const f = await setup(t, {launchLanes: false});
  save(f.configFile, {...f.config, intervalSeconds: 10});
  const tty = path.join(f.root, 'tty.cjs');
  fs.writeFileSync(tty, 'process.stdout.isTTY = true;\n');
  const child = spawn(process.execPath, ['--require', tty, launcher, '--config', f.configFile],
    {env: {...f.env, FORCE_COLOR: '0'}});
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '', signalled = false;
  child.stdout.on('data', data => {
    output += data;
    if (!signalled && /Next check in 00:0[4-6]/.test(output)) {
      signalled = true; child.kill('SIGINT');
    }
  });
  child.stderr.on('data', data => errors += data);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('countdown did not stop')); }, 8000);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(code, 0, errors);
  assert.match(output, /Next check in 00:10/);
  assert.match(output, /Next check in 00:0[4-6]/);
  assert.match(output, /Stopped/);
  assert.equal(queueReads(f), 1);
  assert.ok(!fs.existsSync(path.join(f.stateDir, 'dispatcher.lock')));
});
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
