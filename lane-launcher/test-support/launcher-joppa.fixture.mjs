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
      title: `[0${index}] Task ${index}`,
      body: `Goal: scoped change ${index}\nRepository: app\nModule: m${index}\nChecks: exact check ${index}`}));
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
    assert.equal(Object.hasOwn(args, 'purpose'), false, 'The removed purpose filter was sent');
    let value, rejected = false;
    if (name === 'joppa_tree') value = {schema: {types: {req: {role: 'requirement'}, ac: {role: 'ac'}, task: {role: 'task'}}}};
    else if (name === 'joppa_objects' && args.address) value = objects.get(args.address);
    else if (name === 'joppa_objects') {
      const rows = [...objects.values()].filter(object => object.kind === 'ac').map(object => ({
        address: object.address, revision: object.current_revision, contract_revision: object.contract_revision,
        kind: object.kind,
        title: object.document.data.title, work_ready: object.work_ready, review_required: object.review_required,
        process: object.process, work_summary: {active: 0, done: 0}}));
      const start = Number(args.cursor || 0), end = start + Math.min(args.limit || 25, 25);
      value = {items: rows.slice(start, end).map(row => Object.fromEntries(Object.entries(row)
        .filter(([key]) => key === 'address' || args.fields?.includes(key)))),
        ...(end < rows.length ? {next_cursor: String(end)} : {})};
    }
    else if (name === 'joppa_tests') value = {items: args.ac.split(',').map(address => ({address, status: 'grey'}))};
    else if (name === 'joppa_tasks') value = args.view === 'mine' ? {total: 0} : {
      tasks: queue.map(address => ({address, revision: 3, title: objects.get(address).document.data.title,
        projects: objects.get(address).document.data.projects || ['project:app'],
        status: objects.get(address).process.status, assignee: objects.get(address).process.assignee}))
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
          foreign.document.data.body = 'Repository: app\nModule: unconfigured';
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


export {packageFixture, blockedPackage, packageLanding};
