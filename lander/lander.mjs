// Deterministic batch integration. Shared flow stages own every native claim and mutation.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {read, write, require, git, ancestor, remoteHead, targetHead, create, pin, candidate,
  environment, cleanup, tooling} from './git.mjs';

const root = path.join(process.env.MEDULLA_RUN_DIR, 'artifacts');
const stateFile = path.join(root, 'lander.json');
const signal = (code, message) => console.log('<signal:' + code + '>' + message + '</signal:' + code + '>');
const config = () => read(process.env.PLANNING_JOPPA_CONFIG);
const repository = state => config().repositories.find(repo => repo.id === state.repository);
function settings() {
  const value = config(), assignment = read(path.join(root, 'input.json'));
  const items = assignment.items || [assignment.selected], ids = new Set(items.map(item => item.document.data.repository));
  require(ids.size === 1, 'The claimed batch must use one configured repository');
  const repo = value.repositories?.find(item => item.id === [...ids][0]);
  require(repo && path.isAbsolute(repo.path) && Array.isArray(repo.gateCommands) && repo.gateCommands.length &&
    repo.gateCommands.every(command => typeof command === 'string' && command.trim()), 'Repository needs path and full gateCommands');
  require(repo.preflight == null || typeof repo.preflight === 'string', 'Repository preflight must be a shell command');
  require(repo.gateTimeoutSeconds == null || Number.isSafeInteger(repo.gateTimeoutSeconds) && repo.gateTimeoutSeconds > 0,
    'Repository gateTimeoutSeconds must be positive');
  const failedData = JSON.parse(process.env.FAILED_DATA || '{}');
  require(failedData && typeof failedData === 'object' && !Array.isArray(failedData) && Object.keys(failedData).length &&
    !Object.keys(failedData).some(key => ['assignee', 'commit', 'repository', 'delivery', 'acceptance'].includes(key)),
  'FAILED_DATA must be a nonempty native patch without host-owned fields');
  return {value, assignment, items, repo, failedData};
}
function output(state, landed = []) {
  const {value, assignment, items, failedData} = settings(), operations = [];
  const done = new Set(landed.map(item => item.address));
  for (const item of items) {
    const address = item.address, reason = state.failed[address] || state.pending || 'NOT_LANDED';
    if (done.has(address)) {
      operations.push({command: {op: 'archive_object', target: address,
        revision: assignment.claim_revisions[address], reason: 'Checked head ' + item.document.data.commit +
          ' is in target ancestry. Tested candidate: ' + state.checked.commit}});
      continue;
    }
    if (state.failed[address] && !['BRANCH_MOVED', 'BRANCH_UNAVAILABLE'].includes(state.failed[address])) operations.push({command: {op: 'save_object', kind: item.kind,
      id: address.slice(address.indexOf(':') + 1), revision: assignment.claim_revisions[address],
      data: {...failedData, delivery: null}, reason: 'Lander excluded this branch: ' + reason}});
    operations.push({command: {op: 'note', target: address,
      id: 'lander-' + process.env.MEDULLA_RUN_ID + '-' + createHash('sha256').update(address).digest('hex').slice(0, 12),
      text: reason + '. Original branch retained. Run: ' + process.env.MEDULLA_RUN_ID +
        '. Evidence: ' + path.join(root, 'checks')}});
  }
  const complete = done.size === items.length;
  const reason = complete ? 'All claimed heads are in the checked target ancestry.' :
    String(done.size) + ' of ' + items.length + ' heads landed. ' + (state.pending || 'Excluded branches require review.');
  write(path.join(root, value.publication.file), {operations, outcome: {status: complete ? 'published' : 'blocked',
    reason_code: complete ? 'LANDED' : state.pending || 'PARTIAL_LANDING', reason}});
}
function build() {
  const {repo, items} = settings();
  const state = {...create(repo, process.env.WORKTREE_ROOT, process.env.MEDULLA_RUN_ID),
    repository: repo.id, pins: [], failed: {}, rebuilds: 0};
  write(stateFile, state);
  state.base = targetHead(state);
  for (const [index, item] of items.entries()) {
    try { state.pins.push(pin(state, item, index)); }
    catch (error) {
      if (!/^(BRANCH_MOVED|BRANCH_UNAVAILABLE):/.test(error.message)) throw error;
      state.failed[item.address] = error.message.split(':')[0];
    }
  }
  const selected = candidate(state, repo, state.pins, root);
  Object.assign(state, selected, {failed: {...state.failed, ...selected.failed}});
  write(stateFile, state);
  if (state.pending || !state.accepted.length) { output(state); signal('REPORT', state.pending || 'No branch can land.'); }
  else signal('BUILT', 'Combined candidate passed the full configured gates.');
}
function verifiedInputs() {
  const result = spawnSync(process.env.PLANNING_PYTHON || 'python3', [process.env.CREW_FLOW_STAGES, 'verify'], {stdio: 'inherit'});
  require(result.status === 0, 'Claimed inputs changed before target publication');
}
function push() {
  const state = read(stateFile), repo = repository(state);
  for (let pass = 0; pass < 2; pass++) {
    const now = targetHead(state), moved = state.pins.filter(item =>
      !ancestor(state.checkout, item.head, now) && remoteHead(state.checkout, item.branch) !== item.head);
    const rebuild = now !== state.base || moved.length || pass;
    if (rebuild) {
      if (state.rebuilds >= 1) {
        state.pending = 'TARGET_MOVED_AGAIN'; write(stateFile, state); output(state); signal('REPORT', state.pending); return;
      }
      state.rebuilds++;
      for (const item of moved) state.failed[item.address] = 'BRANCH_MOVED';
      state.pins = state.pins.filter(item => !state.failed[item.address]);
      state.base = now;
      const selected = candidate(state, repo, state.pins, root);
      Object.assign(state, selected, {failed: {...state.failed, ...selected.failed}});
    }
    write(stateFile, state);
    if (state.pending || !state.accepted.length) { output(state); signal('REPORT', state.pending || 'No branch can land.'); return; }
    // A rebuilt candidate needs a new input fence, not an old approval.
    if (rebuild) verifiedInputs();
    require(state.checked?.passed === true, 'The push needs a candidate that passed the full configured gates');
    git(state.checkout, 'reset', '--hard', state.checked.commit);
    const log = fs.openSync(path.join(root, 'push-' + pass + '.log'), 'a');
    let result;
    try { result = spawnSync('bash', [path.join(tooling, 'lane/bin/land.sh'), state.target],
      {cwd: state.checkout, env: environment(state, repo, state.checked.attempt), timeout: (repo.gateTimeoutSeconds || 900) * 1000,
        stdio: ['ignore', log, log]}); }
    finally { fs.closeSync(log); }
    const after = targetHead(state);
    if (ancestor(state.checkout, state.checked.commit, after)) {
      const landed = state.accepted.filter(item => ancestor(state.checkout, item.head, after));
      state.landed = after; state.landed_at = new Date().toISOString();
      write(stateFile, state); output(state, landed); signal('REPORT', 'Target ancestry confirmed.'); return;
    }
    if (after === state.base || pass === 1) {
      state.pending = result.status === 0 ? 'TARGET_UNCONFIRMED' : 'PUSH_FAILED';
      write(stateFile, state); output(state); signal('REPORT', state.pending); return;
    }
  }
}
function main(command) {
  if (command === 'build') build();
  else if (command === 'push') push();
  else if (command === 'cleanup') cleanup(fs.existsSync(stateFile) ? read(stateFile) : null, process.env.WORKTREE_ROOT);
  else throw new Error('Unknown Lander stage: ' + command);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv[2]); }
  catch (error) {
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'failure.txt'), 'Lander ' + process.argv[2] + ': ' + error.message.slice(0, 900));
    console.error('lander: ' + error.message); process.exitCode = 2;
  }
}
