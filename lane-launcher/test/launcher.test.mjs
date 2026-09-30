import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {activeCount, dockerLanes, configFrom} from '../launcher.mjs';
import {scopeDirectory, laneRunFolder, validateId} from '../scope.mjs';
import {save, read, laneArgs} from '../runtime.mjs';

const launcher = fileURLToPath(new URL('../launcher.mjs', import.meta.url));
const worker = fileURLToPath(new URL('../worker.mjs', import.meta.url));
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
test('worker records completion before notifying; bus failure preserves lane outcome', async t => {
  const f = await setup(t);
  fs.writeFileSync(path.join(f.bins, 'bash'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  fs.writeFileSync(path.join(f.bins, 'agentbus'), `#!${process.execPath}
import fs from 'node:fs';
if (!fs.existsSync(process.env.TEST_RESULT)) process.exit(99);
fs.writeFileSync(process.env.TEST_NOTIFY, JSON.stringify(process.argv.slice(2)));
console.error('fixture delivery failure');
process.exit(1);
`, {mode: 0o755});
  const dir = path.join(f.root, 'worker');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'launch.json');
  save(file, {config: {...f.config, notify: {to: 'fixture', room: 'fixture', from: 'crew-fixture'}},
    ticket: 'T1', args: [], pane: 'fixture', runFolder: path.join(dir, 'lane')});
  const sent = path.join(dir, 'sent.json');
  const result = await execute(worker, [file], {...f.env, TEST_RESULT: path.join(dir, 'result.json'), TEST_NOTIFY: sent});
  assert.equal(result.code, 0, result.stderr);
  assert.equal(read(path.join(dir, 'result.json')).code, 0);
  assert.match(read(sent).at(-1), /^CREW READY \| T1 \|/);
  assert.match(read(path.join(dir, 'notification-error.json')).error, /fixture delivery failure/);
});
const queueReads = f => f.calls.filter(call => call.url.startsWith('/v1/tickets/next')).length;
const runState = f => {
  const [runId] = fs.readdirSync(path.join(f.stateDir, 'runs'));
  return path.join(f.stateDir, 'runs', runId);
};
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
async function setup(t, {empty = false, dockerFailure = false, launchLanes = true, claimRefused = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-launcher-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const bins = path.join(root, 'bin');
  fs.writeFileSync(path.join(root, 'cbm-mcp.py'), '# connector fixture\n');
  for (const dir of [bins, path.join(root, 'sources/repo/.git'), path.join(root, 'ssh')]) {
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
  // A tab may open only for a ticket this dispatcher already claimed.
  if (!fs.readFileSync(process.env.TEST_REQUESTS, 'utf8').includes('/start')) process.exit(3);
  if (process.env.TEST_CREATE_FAILURE === '1') process.exit(1);
  panes.push({pane_id: 'test-pane'});
  fs.writeFileSync(process.env.TEST_PANES, JSON.stringify(panes));
  result = {root_pane: {pane_id: 'test-pane'}};
}
if (args[1] === 'list') result = {panes};
if (args[1] === 'close' && process.env.TEST_RESULT) {
  if (!fs.existsSync(process.env.TEST_RESULT)) process.exit(2);
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
    calls.push({method: req.method, url: req.url, body: body ? JSON.parse(body) : null});
    fs.appendFileSync(requests, `${req.method} ${req.url}\n`);
    if (empty) { res.writeHead(204); res.end(); }
    else if (req.url.startsWith('/v1/tickets/T1/start') && claimRefused) {
      res.writeHead(409); res.end('{"error":"fixture conflict"}');
    }
    else if (req.url.startsWith('/v1/tickets/T1/start')) {
      ticketStatus = 'in_progress';
      res.end('{"id":"T1","status":"in_progress","claimed":true}');
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
    cbmMcpCommand: path.join(root, 'cbm-mcp.py'), sshDir: path.join(root, 'ssh'), gateCommands: ['true'],
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
  const query = new URL(f.calls[0].url, 'http://fixture');
  assert.equal(query.pathname, '/v1/tickets/next');
  for (const [key, value] of Object.entries({workspace: 'test', tag: 'crew',
    dry_run: 'true', has_module: 'true', strict: 'true'})) assert.equal(query.searchParams.get(key), value);
  assert.equal(query.searchParams.has('project'), false);
  const events = fs.readFileSync(f.events, 'utf8').trim().split('\n').map(JSON.parse);
  const create = events.find(args => args[1] === 'create');
  assert.deepEqual(create.slice(0, 4), ['tab', 'create', '--workspace', 'workspace']);
  assert.ok(create.includes('--no-focus'));
  assert.ok(events.find(args => args[1] === 'run')[3].includes('worker.mjs'));
  result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running lanes 1 of 1/);
  assert.equal(queueReads(f), 1);
});
test('claim refusal opens no tab and does not modify the ticket', async t => {
  const f = await setup(t, {claimRefused: true});
  assert.equal((await f.run()).code, 1);
  assert.equal(read(path.join(runState(f), 'result.json')).status, 'claim-refused');
  assert.ok(!f.calls.some(call => call.method === 'PATCH'));
  assert.ok(!fs.readFileSync(f.events, 'utf8').includes('create'));
});
test('tab creation failure reopens the confirmed claim', async t => {
  const f = await setup(t);
  f.env.TEST_CREATE_FAILURE = '1';
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /reopened/);
  assert.deepEqual(f.calls.find(call => call.method === 'PATCH').body,
    {workspace: 'test', status: 'open', force: true});
  assert.equal(read(path.join(runState(f), 'result.json')).reopened, true);
});
test('worker startup failure reopens; adopted workflow failure and changed tickets do not', async t => {
  for (const scenario of ['startup', 'adopted', 'done']) {
    const f = await setup(t);
    assert.equal((await f.run()).code, 0);
    const dir = runState(f), run = read(path.join(dir, 'launch.json'));
    fs.writeFileSync(path.join(f.bins, 'bash'), '#!/bin/sh\nexit 2\n', {mode: 0o755});
    if (scenario === 'adopted') {
      const artifacts = path.join(run.runFolder, 'fixture', 'artifacts');
      fs.mkdirSync(artifacts, {recursive: true});
      save(path.join(artifacts, 'claim.json'), {...run.claim, run_dir: path.dirname(artifacts)});
    }
    if (scenario === 'done') f.setStatus('done');
    await execute(worker, [path.join(dir, 'launch.json')], f.env);
    const result = read(path.join(dir, 'result.json'));
    assert.equal(result.reopened === true, scenario === 'startup', scenario);
    assert.equal(f.calls.some(call => call.method === 'PATCH'), scenario === 'startup', scenario);
    if (scenario === 'done') assert.match(result.reopenError, /Ticket changed/);
  }
});
test('existing external Docker lane prevents a queue read', async t => {
  const f = await setup(t);
  fs.writeFileSync(f.docker, JSON.stringify({workflow: 'lane', runFolder: scopeDirectory('/manual, runs', f.config.id)}));
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.calls.length, 0);
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
  save(path.join(f.stateDir, 'runs', runId, 'result.json'), {status: 'exited', code: 0});
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
  assert.match(result.stdout, /no open tickets/);
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
  for (const file of ['dolber.sh', 'launcher.mjs', 'runtime.mjs', 'ntk.mjs', 'scope.mjs']) {
    fs.copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), path.join(folder, file));
  }
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
  assert.equal(lines[1], 'checking params:');
  assert.equal(lines[2], '  tags: open, agent-ready');
  assert.equal(lines[3], '  prefer: KYC → ceo60 → KYT');
  assert.equal(lines[4], 'Starting new one with ticket: T1 (preview: запуск отключён)');
  const query = new URL(f.calls[0].url, 'http://fixture');
  assert.equal(query.searchParams.get('tag'), 'open,agent-ready');
  assert.equal(query.searchParams.get('prefer'), 'KYC,ceo60,KYT');
  assert.equal(query.searchParams.get('strict'), 'false');
  assert.equal(query.searchParams.get('dry_run'), 'true');
  assert.equal(query.searchParams.has('project'), false);
  assert.equal(f.calls.length, 1);
  assert.ok(!fs.existsSync(f.events), 'preview must not call Herdr at all');
  assert.deepEqual(fs.readdirSync(path.join(f.stateDir, 'runs')), []);
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
  assert.equal(f.calls.length, 1);
  const query = new URL(f.calls[0].url, 'http://fixture');
  assert.equal(query.pathname, '/v1/tickets/next');
  assert.equal(query.searchParams.get('dry_run'), 'true');
  assert.ok(!fs.existsSync(f.events));
  assert.deepEqual(fs.readdirSync(path.join(f.stateDir, 'runs')), []);
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
  assert.equal(f.calls.length, 2);
  assert.ok(!fs.existsSync(f.events));
  assert.ok(!fs.existsSync(path.join(f.stateDir, 'dispatcher.lock')));
});
for (const exitCode of [0, 7]) for (const closeTabOnExit of [false, true]) {
  test(`worker saves exit ${exitCode}; closeTabOnExit=${closeTabOnExit}`, async t => {
    const f = await setup(t);
    // Stand in for the lane process; exercise the real worker and Herdr dispatch.
    fs.writeFileSync(path.join(f.bins, 'bash'), `#!/bin/sh\nprintf 'lane-output\\n'\nexit ${exitCode}\n`, {mode: 0o755});
    const dir = path.join(f.root, 'worker');
    fs.mkdirSync(dir);
    const artifacts = path.join(dir, 'lane/fixture/artifacts');
    fs.mkdirSync(path.join(artifacts, 'gates/check'), {recursive: true});
    fs.writeFileSync(path.join(artifacts, 'failure.txt'), 'candidate checks failed');
    save(path.join(artifacts, 'gates/check/receipt.json'), {checks: [
      {command: 'bun run docs:links', exit_code: 1, log: '/fixture/gates/1.log'}]});
    const file = path.join(dir, 'launch.json');
    save(file, {config: {...f.config, closeTabOnExit}, args: ['--ticket-id', 'T1'], pane: 'owned-pane', runFolder: path.join(dir, 'lane')});
    const result = await execute(worker, [file], {...f.env, TEST_RESULT: path.join(dir, 'result.json')});
    assert.equal(result.code, 0, result.stderr);
    assert.equal(read(path.join(dir, 'result.json')).code, exitCode);
    assert.match(fs.readFileSync(path.join(dir, 'output.log'), 'utf8'), /lane-output/);
    if (exitCode) assert.match(result.stdout, /FAILED check: bun run docs:links · exit 1/);
    else assert.doesNotMatch(result.stdout, /FAILED check:/);
    const events = fs.existsSync(f.events)
      ? fs.readFileSync(f.events, 'utf8').trim().split('\n').map(JSON.parse) : [];
    assert.deepEqual(events, closeTabOnExit ? [['pane', 'close', 'owned-pane']] : []);
    if (!closeTabOnExit) assert.match(result.stdout, /Tab kept open/);
  });
}
