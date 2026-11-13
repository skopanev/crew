import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {save} from '../runtime.mjs';
import {recordRetained, retainedLine} from '../retained-checkout.mjs';
import {contractDigest} from '../joppa.mjs';
import {packageFixture} from './launcher-joppa.fixture.mjs';
import {defaultWorkflow, workflowDigest} from '../workflow-config.mjs';

// A fake Docker answers from DOCKER_ROWS: an empty list means no running container.
export function fakeDocker(root) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const rows = JSON.parse(process.env.DOCKER_ROWS || '[]');
if (process.argv[2] === 'ps') console.log(rows.map((row, index) => 'c' + index).join('\\n'));
else console.log(JSON.stringify(rows));
`, {mode: 0o755});
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  process.env.DOCKER_ROWS = '[]';
  return () => { process.env.PATH = previous; delete process.env.DOCKER_ROWS; };
}

export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8',
  env: {...process.env, GIT_AUTHOR_NAME: 'lane', GIT_AUTHOR_EMAIL: 'lane@local', GIT_COMMITTER_NAME: 'lane',
    GIT_COMMITTER_EMAIL: 'lane@local'}}).trim();

export const ORIGIN = 'ssh://example.invalid/app.git';
// The process group of a lane that has already stopped.
export const stoppedPgid = () => spawnSync('true').pid;

// A clean lane branch with one commit above lane-base and ignored dependencies.
export function laneCheckout(checkout, executionId) {
  fs.mkdirSync(checkout, {recursive: true});
  git(checkout, 'init', '-q', '-b', `ticket-${executionId}`);
  git(checkout, 'remote', 'add', 'origin', ORIGIN);
  fs.writeFileSync(path.join(checkout, 'a.txt'), 'base\n');
  fs.writeFileSync(path.join(checkout, '.gitignore'), 'node_modules/\n');
  git(checkout, 'add', '-A'); git(checkout, 'commit', '-qm', 'base');
  fs.writeFileSync(path.join(checkout, '.git/lane-base'), git(checkout, 'rev-parse', 'HEAD') + '\n');
  fs.writeFileSync(path.join(checkout, 'a.txt'), 'change\n');
  git(checkout, 'commit', '-qam', 'change');
  // Ignored dependencies stay in place and do not make the checkout dirty.
  fs.mkdirSync(path.join(checkout, 'node_modules'));
  fs.writeFileSync(path.join(checkout, 'node_modules/dep.js'), '');
}

export async function reuseFixture(t, {node = 'implement_code', signal = 'GATE_FAIL'} = {}) {
  const f = await packageFixture(t);
  t.after(fakeDocker(f.root));
  const config = {...f.run.config, delivery: 'target', worktreeRoot: path.join(f.root, 'wt'),
    stateDir: path.join(f.root, 'state')};
  const file = path.join(f.root, 'workflow.yaml');
  fs.writeFileSync(file, fs.readFileSync(defaultWorkflow, 'utf8') + '\n# Custom review policy.\n');
  const workflow = {file, digest: workflowDigest(file)};
  const executionId = 'joppa-' + 'a'.repeat(32), checkout = path.join(config.worktreeRoot, executionId);
  laneCheckout(checkout, executionId);
  const canonical = path.join(f.root, 'canonical');
  fs.mkdirSync(canonical);
  git(canonical, 'init', '-q');
  git(canonical, 'remote', 'add', 'origin', ORIGIN);
  const repository = {id: 'app', path: canonical, targetBranch: 'main'};
  // The new claim holds the live Task. Its digest is the digest of the live contract.
  const task = f.objects.get('task:t1');
  task.document.data.assignee = 'crew-lane:new';
  const digest = contractDigest(task);
  const claim = (assignee, retained) => ({claimed: true, id: executionId, assignee, address: 'task:t1',
    tasks: [{address: 'task:t1', digest}], contexts: [{address: 'ac:a1', digest: 'c1'}],
    ticket: {id: executionId, modulePaths: ['a.txt'], ...(retained ? {retained} : {})}});
  const runDir = name => path.join(config.stateDir, 'runs', name);
  const priorId = randomUUID(), prior = {config, workspace: 'fixture', joppaWorker: f.run.joppaWorker, task: 'task:t1',
    executionId, repository, createdAt: '2026-11-13T10:00:00.000Z', runFolder: path.join(runDir(priorId), 'lane'),
    claim: claim('crew-lane:old'), launchPgid: stoppedPgid(), workflow: {...workflow}};
  const artifacts = path.join(prior.runFolder, 'm1', 'artifacts');
  fs.mkdirSync(path.join(prior.runFolder, 'm1', 'steps', '007-expert_review'), {recursive: true});
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'origin.json'), JSON.stringify({node, signal, message: 'stopped'}));
  for (const name of ['scout.txt', 'coder-report.txt', 'failure.txt', 'rejects.txt', 'security.md', 'reviewed-tree.txt',
    'test-bindings-receipt.json', 'test-bindings.json']) fs.writeFileSync(path.join(artifacts, name), `${name}\n`);
  fs.writeFileSync(path.join(prior.runFolder, 'm1', 'steps', '007-expert_review', 'inputs.json'),
    JSON.stringify([{slug: 'security'}, {slug: '../escape'}]));
  // The failure outcome records the checkout and notes it in the Task block.
  prior.retained = recordRetained(prior, artifacts);
  assert.ok(prior.retained, 'a clean lane checkout is recorded');
  const note = {op: 'note', target: 'task:t1', id: randomUUID(), reply_to: null,
    text: `CREW_FAILURE\nTask: task:t1\nRun: ${priorId}\nReason: ${signal}\n${retainedLine(prior.retained)}\nlane stopped`};
  prior.blockRequest = {operations: [{command: note}]};
  prior.result = {status: 'failed', code: 1, blocked: true, blockConfirmed: true};
  f.objects.get('task:t1').annotations.comments[note.id] = {actor: 'lane-1', text: note.text, withdrawn: false};
  const savePrior = () => { fs.mkdirSync(runDir(priorId), {recursive: true}); save(path.join(runDir(priorId), 'launch.json'), prior); };
  savePrior();
  const currentId = randomUUID();
  fs.mkdirSync(runDir(currentId), {recursive: true});
  const run = {config, workspace: 'fixture', joppaWorker: f.run.joppaWorker, task: 'task:t1', executionId, repository,
    createdAt: '2026-11-13T11:00:00.000Z', runFolder: path.join(runDir(currentId), 'lane'), claim: claim('crew-lane:new'), workflow};
  return {f, run, dir: runDir(currentId), prior, savePrior, artifacts, checkout, note};
}
