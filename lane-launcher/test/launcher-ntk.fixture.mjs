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

const queueReads = f => f.calls.filter(call => call.url.startsWith('/v1/tickets/next')).length;
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


export {launcher, worker, queueReads, countReads, queueQuery, runState, existingClaim, execute, notificationEnv, setup};
