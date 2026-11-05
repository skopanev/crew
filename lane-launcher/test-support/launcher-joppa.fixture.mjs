import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {activeCount, dockerLanes, configFrom} from '../launcher.mjs';
import {scopeDirectory, laneRunFolder, validateId} from '../scope.mjs';
import {save, read, laneArgs, runDirectories} from '../runtime.mjs';
import {claimTask, finishTask, nextTask, executionId, runHoldsTasks, contractDigest, guardTaskClaims} from '../joppa.mjs';
import {cleanupBlockedTasks} from '../../planning-joppa/cleanup.mjs';
import {readyCriteria, groupRequirements} from '../../planning-joppa/dashboard.mjs';

async function packageFixture(t, mode = 'success') {
  // The run folder name is the launch UUID, as in launcher state.
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-package-')));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const runId = randomUUID(), root = path.join(temp, runId);
  fs.mkdirSync(root);
  const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, 'fixture-token');
  const objects = new Map(), calls = [], queue = ['task:t2', 'task:t1'];
  const make = (address, kind, parent, data) => ({address, kind, historical: false, current_revision: 3,
    work_ready: true, status: {tone: 'grey'}, document: {present: true, parent, data, links: []},
    process: {}, annotations: {comments: {}}});
  objects.set('req:r', make('req:r', 'req', null, {title: 'Requirement'}));
  for (let index = 1; index <= 2; index++) {
    objects.set(`ac:a${index}`, make(`ac:a${index}`, 'ac', 'req:r', {title: `AC ${index}`}));
    objects.set(`task:t${index}`, make(`task:t${index}`, 'task', `ac:a${index}`, {
      title: `[0${index}] Task ${index}`, projects: ['app'],
      body: `Goal: scoped change ${index}\nRepository: app\nModule: m${index}\nChecks: exact check ${index}`}));
  }
  // Tests can add Task references, a test type or test_results rules to this schema.
  const types = {req: {role: 'requirement'}, ac: {role: 'ac'},
    task: {role: 'task', ...(mode === 'no-question' ? {} : {question: 'Which change does this Task make?'})}};
  const schema = {types};
  let created = 0;
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
    if (name === 'joppa_tree') value = {schema: structuredClone(schema)};
    else if (name === 'joppa_objects' && args.address) value = objects.get(args.address);
    else if (name === 'joppa_objects') {
      assert.equal(Object.hasOwn(args, 'work_filter'), false);
      const kinds = args.kind && [args.kind].flat(), tones = args.status && [args.status].flat();
      const descendant = object => {
        if (!args.parent || args.parent === '*') return true;
        let parent = object.document.parent, depth = 1;
        while (parent) {
          if (parent === args.parent) return !args.depth || depth <= args.depth;
          parent = objects.get(parent)?.document.parent;
          depth++;
        }
        return false;
      };
      const rows = [...objects.values()].filter(object => descendant(object) &&
        (!kinds || kinds.includes(object.kind)) && (object.kind !== 'task' || queue.includes(object.address)))
        .map(object => ({address: object.address, revision: object.current_revision,
          kind: object.kind, parent: object.document.parent, present: object.document.present,
          status: object.document.present ? object.status?.tone || 'grey' : 'purple',
          title: object.document.data.title, work_ready: object.work_ready,
          'data.assignee': object.document.data.assignee ?? null, 'data.commit': object.document.data.commit ?? null,
          'data.projects': object.document.data.projects ?? null, 'data.priority': object.document.data.priority ?? null,
          'process.assessment': object.process.assessment ?? null,
          ...Object.fromEntries((args.fields || []).filter(field => field.startsWith('data.') &&
            !['data.assignee', 'data.commit', 'data.projects', 'data.priority'].includes(field))
            .map(field => [field, object.document.data[field.slice(5)] ?? null]))}))
        .filter(row => tones ? tones.includes(row.status) : row.present);
      const start = Number(args.cursor || 0), end = start + Math.min(args.limit || 25, 25);
      value = {items: rows.slice(start, end).map(row => Object.fromEntries(Object.entries(row)
        .filter(([key]) => key === 'address' || args.fields?.includes(key)))),
        ...(end < rows.length ? {next_cursor: String(end)} : {})};
    }
    else if (name === 'joppa_tasks') throw new Error('The removed Task tool was called');
    else if (name === 'joppa_batch') {
      const commands = args.operations.map(({command}) => command);
      // Joppa reserves data.acceptance for process commands. Earlier fixtures accepted it.
      const reserved = commands.findIndex(command => command.op === 'save_object' && Object.hasOwn(command.data || {}, 'acceptance'));
      const claim = commands.every(command => command.op === 'save_object' && command.data.assignee);
      const release = commands.every(command => command.op === 'save_object' && !command.data.assignee);
      // A new node save has revision 0 and no ID. The fixture gives it the next address of its type.
      for (const command of commands) if (command.op === 'save_object' && command.revision === 0 && !command.id) {
        command.id = `n${++created}`;
        objects.set(`${command.kind}:${command.id}`, {address: `${command.kind}:${command.id}`, kind: command.kind,
          historical: false, current_revision: 0, work_ready: true, status: {tone: 'orange'},
          document: {present: true, parent: command.parent, data: {}, links: []}, process: {}, annotations: {comments: {}}});
      }
      const target = command => objects.get(command.target || `${command.kind}:${command.id}`);
      if (mode === 'release-unknown' && release) { res.destroy(); return; }
      // Revision checks refuse the whole batch. A changed save advances the revision; batch refs read the saved one.
      const planned = new Map(), refs = new Map();
      for (const [index, command] of commands.entries()) if (command.op === 'save_object') {
        const revision = JSON.stringify(target(command).document.data) === JSON.stringify(command.data)
          ? command.revision : command.revision + 1;
        planned.set(target(command), revision);
        if (args.operations[index].ref) refs.set(`${args.operations[index].ref}/saved_revision`, revision);
      }
      const resolve = value => value?.$ref ? refs.get(value.$ref) : value;
      const stale = commands.some(command => command.op === 'save_object' ? target(command)?.current_revision !== command.revision
        : command.op === 'archive_object' && (planned.get(target(command)) ?? target(command)?.current_revision) !== resolve(command.revision));
      if (reserved >= 0) {
        rejected = true; value = {error: `operation ${reserved + 1}: use process commands for acceptance`};
      }
      else if (mode === 'reject' || mode === 'outcome-reject' && !claim || stale) {
        rejected = true; value = {error: 'operation 2 revision changed'};
      }
      else {
        value = {results: commands.map(command => {
          const object = target(command);
          if (command.op === 'save_object') {
            const data = mode === 'wrong-commit' && command.data.commit ? {...command.data, commit: '0'.repeat(40)} : command.data;
            applyData(object.document.data, data);
            object.current_revision = planned.get(object);
            return {command: {op: command.op}, object: {address: object.address, revision: object.current_revision}};
          }
          if (command.op === 'assess') object.process = command.ready ? {assessment: {state: 'ready', actor: 'lane-1'}} :
            {assessment: {state: 'waiting', reason: command.reason, actor: mode === 'wrong-assessor' ? 'other' : 'lane-1'}};
          if (command.op === 'note') object.annotations.comments[command.id] = {actor: 'lane-1', text: command.text, withdrawn: false};
          if (command.op === 'archive_object' && mode !== 'archive-present') {
            object.document.present = false;
            object.current_revision++;
            if (mode === 'archive-historical') object.historical = true;
            if (mode === 'archive-assigned') object.document.data.assignee = 'other-run';
            if (mode === 'archive-missing-commit') delete object.document.data.commit;
          }
          return {command: {...command, ...(command.op === 'archive_object' ? {revision: resolve(command.revision)} : {})}};
        })};
        if (['postclaim-race', 'sameactor-race', 'release-unknown'].includes(mode) && claim) {
          const foreign = structuredClone(objects.get('task:t1'));
          foreign.address = 'task:foreign';
          foreign.document.data.projects = ['project:other'];
          foreign.document.data.body = 'Repository: app\nModule: unconfigured';
          foreign.document.data.assignee = mode === 'sameactor-race' ? commands[0].data.assignee : 'foreign-worker';
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
  return {root, runId, run, stateFile, calls, objects, queue, schema, persist: () => save(stateFile, run)};
}

// Update a document in place so test getters on unchanged fields keep working.
function applyData(target, data) {
  for (const key of Object.keys(target)) if (!Object.hasOwn(data, key)) delete target[key];
  for (const [key, value] of Object.entries(data)) {
    if (JSON.stringify(target[key]) !== JSON.stringify(value)) target[key] = value;
  }
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
  run.blockRequest = {operations: []};
  const tasks = f.run.tasks.map(({address}) => {
    const id = `failure-${address.split(':')[1]}`;
    const text = `CREW_FAILURE\nTask: ${address}\nRun: ${runId}\nReason: GATE_FAIL\nGate failed.`;
    run.blockRequest.operations.push({command: {op: 'note', target: address, id, text}});
    return {address, kind: 'task', current_revision: 3, historical: false,
      document: {present: true, data: {title: address}, links: [], parent: 'ac:a1'},
      process: {assessment: {state: 'waiting', reason: 'GATE_FAIL'}},
      annotations: {comments: {[id]: {actor: run.joppaWorker.actor, text}}}};
  });
  save(path.join(runs, runId, 'launch.json'), run);
  const operations = tasks.map(task => ({command: {op: 'archive_object', target: task.address, revision: 3, reason: 'Retire'}}));
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
