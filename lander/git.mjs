// Private integration candidates and existing gate receipts. Canonical repositories remain unchanged.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const tooling = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const require = (ok, message) => { if (!ok) throw new Error(message); };
export const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args],
  {encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe']}).trim();
export function ancestor(checkout, head, target) {
  const value = spawnSync('git', ['-C', checkout, 'merge-base', '--is-ancestor', head, target], {timeout: 120000});
  require([0, 1].includes(value.status), 'Git ancestry check failed');
  return value.status === 0;
}
export function branch(checkout, name) {
  require(typeof name === 'string' && name, 'A configured branch is missing');
  git(checkout, 'check-ref-format', 'refs/heads/' + name);
  return name;
}
export function remoteHead(checkout, name) {
  branch(checkout, name);
  const rows = git(checkout, 'ls-remote', 'origin', 'refs/heads/' + name).split('\n').filter(Boolean);
  require(rows.length <= 1, 'Remote returned more than one branch head');
  return rows[0]?.split(/\s/)[0] || null;
}
export function targetHead(state) {
  const ref = 'refs/heads/' + branch(state.checkout, state.target);
  const tracking = 'refs/remotes/origin/' + state.target;
  git(state.checkout, 'fetch', '--quiet', '--no-write-fetch-head', 'origin', '+' + ref + ':' + tracking);
  return git(state.checkout, 'rev-parse', tracking + '^{commit}');
}
export function create(repo, root, run) {
  require(path.isAbsolute(root), 'WORKTREE_ROOT must be absolute');
  fs.mkdirSync(root, {recursive: true});
  require(fs.realpathSync(root) === root, 'WORKTREE_ROOT must not be a symlink');
  const checkout = fs.mkdtempSync(path.join(root, 'lander-' + run + '-'));
  git(root, 'clone', '--quiet', '--no-hardlinks', '--no-checkout', repo.path, checkout);
  git(checkout, 'remote', 'set-url', 'origin', git(repo.path, 'remote', 'get-url', 'origin'));
  git(checkout, 'config', 'user.name', 'Crew Lander');
  git(checkout, 'config', 'user.email', 'crew-lander@local');
  const hooks = spawnSync('git', ['-C', repo.path, 'config', '--get', 'core.hooksPath'], {encoding: 'utf8'});
  require([0, 1].includes(hooks.status), 'Cannot read repository hook configuration');
  if (hooks.status === 0) git(checkout, 'config', 'core.hooksPath', hooks.stdout.trim());
  const stat = fs.lstatSync(checkout);
  return {checkout, dev: stat.dev, ino: stat.ino, target: branch(checkout, repo.targetBranch), cache: {}};
}
export function pin(state, item, index) {
  const data = item.document.data, delivery = data.delivery;
  require(delivery?.state === 'pending' && delivery.target === state.target &&
    /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(delivery.head) && delivery.head === data.commit,
  'Task has no matching checked branch head: ' + item.address);
  branch(state.checkout, delivery.branch);
  // A previous push may have succeeded before its native publication failed.
  const known = spawnSync('git', ['-C', state.checkout, 'cat-file', '-e', delivery.head + '^{commit}']);
  if (known.status !== 0 || !ancestor(state.checkout, delivery.head, state.base)) {
    const current = remoteHead(state.checkout, delivery.branch);
    require(current === delivery.head, (current ? 'BRANCH_MOVED: ' : 'BRANCH_UNAVAILABLE: ') + item.address);
    const ref = 'refs/heads/' + delivery.branch;
    git(state.checkout, 'fetch', '--quiet', '--no-write-fetch-head', 'origin', '+' + ref + ':refs/remotes/origin/lander-' + index);
    require(git(state.checkout, 'rev-parse', 'refs/remotes/origin/lander-' + index + '^{commit}') === delivery.head,
      'BRANCH_MOVED: ' + item.address);
  }
  return {address: item.address, branch: delivery.branch, head: delivery.head};
}
export function environment(state, repo, attempt) {
  return {...process.env, MEDULLA_RUN_DIR: attempt, ticket_id: 'lander-' + process.env.MEDULLA_RUN_ID,
    project_dir: repo.path, module_name: '.', gate_commands: JSON.stringify(repo.gateCommands),
    gate_timeout_seconds: String(repo.gateTimeoutSeconds || 900), VERIFY_ONLY: 'false',
    LANE_TEST_BINDINGS_REQUIRED: 'false'};
}
function prepare(state, repo, attempt, log) {
  return !repo.preflight || spawnSync('bash', ['-lc', repo.preflight],
    {cwd: state.checkout, env: environment(state, repo, attempt), timeout: (repo.gateTimeoutSeconds || 900) * 1000,
      stdio: ['ignore', log, log]}).status === 0;
}
export function check(state, repo, heads, root) {
  const key = JSON.stringify([state.base, heads.map(item => item.head)]);
  const cached = state.cache[key];
  if (cached) {
    git(state.checkout, 'reset', '--hard', cached.commit);
    git(state.checkout, 'clean', '-fdx');
    if (cached.passed && repo.preflight) {
      const log = fs.openSync(path.join(cached.attempt, 'output.log'), 'a');
      try { if (!prepare(state, repo, cached.attempt, log)) return {...cached, passed: false}; }
      finally { fs.closeSync(log); }
    }
    return cached;
  }
  const merged = merge(state, heads);
  if (merged.conflict) return {passed: false, ...merged};
  const commit = git(state.checkout, 'rev-parse', 'HEAD');
  const attempt = path.join(root, 'checks', String(Object.keys(state.cache).length + 1));
  fs.mkdirSync(path.join(attempt, 'artifacts'), {recursive: true});
  const log = fs.openSync(path.join(attempt, 'output.log'), 'a');
  const env = environment(state, repo, attempt);
  let passed;
  try {
    passed = prepare(state, repo, attempt, log) && spawnSync('python3', [path.join(tooling, 'lane/bin/gates.py'), 'run'],
      {cwd: state.checkout, env, timeout: (repo.gateTimeoutSeconds || 900) * repo.gateCommands.length * 1000 + 10000,
        stdio: ['ignore', log, log]}).status === 0;
  } finally { fs.closeSync(log); }
  const result = {passed, commit, attempt};
  state.cache[key] = result;
  return result;
}
function merge(state, heads) {
  git(state.checkout, 'reset', '--hard', state.base);
  git(state.checkout, 'clean', '-fdx');
  for (const item of heads) {
    try { git(state.checkout, 'merge', '--no-ff', '--no-edit', '-m', 'Integrate checked Task branch', item.head); }
    catch (error) {
      if (!git(state.checkout, 'diff', '--name-only', '--diff-filter=U')) throw error;
      git(state.checkout, 'merge', '--abort');
      return {conflict: item.address};
    }
  }
  return {};
}
export function candidate(state, repo, heads, root) {
  let accepted = [], failed = {};
  for (const item of heads) {
    const merged = merge(state, [...accepted, item]);
    if (merged.conflict) failed[item.address] = 'MERGE_CONFLICT';
    else accepted.push(item);
  }
  let checked = check(state, repo, accepted, root);
  if (checked.passed) return {accepted, failed, checked};
  const baseline = check(state, repo, [], root);
  if (!baseline.passed) return {accepted: [], failed: {}, pending: 'BASELINE_RED', checked: baseline};
  const alone = accepted.filter(item => {
    const result = check(state, repo, [item], root);
    if (!result.passed) failed[item.address] = 'BRANCH_GATE_FAIL';
    return result.passed;
  });
  accepted = [];
  for (const item of alone) {
    const result = check(state, repo, [...accepted, item], root);
    if (result.passed) accepted.push(item);
    else failed[item.address] = result.conflict ? 'INTERACTION_CONFLICT' : 'INTERACTION_FAIL';
  }
  checked = check(state, repo, accepted, root);
  return {accepted, failed, checked};
}
export function cleanup(state, root) {
  if (!state?.checkout || !fs.existsSync(state.checkout)) return;
  const stat = fs.lstatSync(state.checkout);
  require(path.dirname(state.checkout) === root && stat.isDirectory() && !stat.isSymbolicLink() &&
    stat.dev === state.dev && stat.ino === state.ino, 'Lander checkout identity changed');
  fs.rmSync(state.checkout, {recursive: true});
}
