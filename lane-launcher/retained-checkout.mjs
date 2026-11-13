// A failed Task run can leave its clean checkout for the next run of the same Task.
// The failed launch state records the checkout; a later claim of that Task reuses it only on an exact match.
import fs from 'node:fs';
import path from 'node:path';
import {command, readRun, runDirectories} from './runtime.mjs';
import {api, claimTasks, contractDigest} from './joppa-common.mjs';
import {heldBy} from './joppa-claims.mjs';
import {runHoldsTasks} from './joppa-selection.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };
const sha = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const HIGH = /^[ \t]*[-*][ \t]+(?:\*\*|__)?HIGH(?![A-Za-z0-9])/m;
const REJECT = /^- [^:\r\n]+: REJECT\b/m;
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const readText = file => exists(file) ? fs.readFileSync(file, 'utf8') : null;
const inside = (child, parent) => !path.relative(parent, child).startsWith('..') && !path.isAbsolute(path.relative(parent, child));

export const checkoutPath = run => path.join(run.config.worktreeRoot, run.executionId);

// Git for an agent-written checkout. Refuse redirecting or executable configuration before any Git command.
function laneGit(checkout) {
  const stat = fs.lstatSync(checkout);
  require(stat.isDirectory() && fs.realpathSync(checkout) === checkout, 'checkout is not a plain directory');
  const dotGit = path.join(checkout, '.git');
  require(fs.lstatSync(dotGit).isDirectory(), 'checkout has no private .git directory');
  for (const name of ['objects/info/alternates', 'commondir', 'config.worktree', 'rebase-merge', 'rebase-apply',
    'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'index.lock']) {
    require(!exists(path.join(dotGit, name)), `checkout has .git/${name}`);
  }
  // Agents can write .git/config. Read it as a plain file first: Git status would run a filter it names.
  const keys = command('git', ['config', '--file', path.join(dotGit, 'config'), '--no-includes', '--list', '--name-only'])
    .split('\n').filter(key => /^(filter|include|includeif)\.|^extensions\.worktreeconfig$/i.test(key));
  require(!keys.length, `checkout .git/config sets ${keys.join(', ')}`);
  // Explicit paths: a local core.worktree or hook setting written by an agent must not steer host Git.
  return (...args) => command('git', ['--no-optional-locks', `--git-dir=${dotGit}`, `--work-tree=${checkout}`,
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args]);
}

// Throw on anything but a clean lane branch with a commit above lane-base.
export function checkoutState(checkout, executionId) {
  const git = laneGit(checkout), dotGit = path.join(checkout, '.git');
  const branch = git('symbolic-ref', '-q', 'HEAD');
  require(branch === `refs/heads/ticket-${executionId}`, `checkout is on ${branch || 'a detached HEAD'}`);
  const head = git('rev-parse', '--verify', 'HEAD^{commit}'), tree = git('rev-parse', '--verify', 'HEAD^{tree}');
  const base = fs.readFileSync(path.join(dotGit, 'lane-base'), 'utf8').trim();
  require(sha.test(head) && sha.test(tree) && sha.test(base) && head !== base, 'checkout has no lane commit above lane-base');
  git('merge-base', '--is-ancestor', base, head);
  require(!git('status', '--porcelain', '--untracked-files=all', '--ignore-submodules=all'), 'checkout has uncommitted changes');
  return {checkout, branch, head, tree, base};
}

// The old lane process group and every container of its run or with this checkout mounted are gone.
export function writerGone(run, checkout) {
  if (!Number.isSafeInteger(run.launchPgid) || run.launchPgid <= 1) return false;
  try { process.kill(-run.launchPgid, 0); return false; }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  const folders = new Set([run.runFolder, exists(run.runFolder) ? fs.realpathSync(run.runFolder) : null].filter(Boolean));
  const ids = command('docker', ['ps', '-q', '--no-trunc']).split('\n').filter(Boolean);
  if (!ids.length) return true;
  return !JSON.parse(command('docker', ['inspect', ...ids])).some(row =>
    folders.has(row.Config?.Labels?.['medulla.runs_under']) || (row.Mounts || []).some(mount => mount.Source === checkout));
}

// Record the retained checkout in the failed launch state. Null when it cannot be proven.
export function recordRetained(run, artifacts) {
  try {
    if (run.finalizeOnly || run.requirementDelivery || !['target', 'branch'].includes(run.config.delivery)) return null;
    const checkout = checkoutPath(run);
    if (!artifacts || !inside(artifacts, run.runFolder) || !exists(checkout) || !writerGone(run, checkout)) return null;
    const origin = JSON.parse(fs.readFileSync(path.join(artifacts, 'origin.json'), 'utf8'));
    // A retained checkout that changed after the host check is evidence only.
    if (origin.signal === 'RETAINED_CHANGED') return null;
    return {...checkoutState(checkout, run.executionId), node: origin.node, signal: origin.signal, artifacts};
  } catch { return null; }
}

export const retainedLine = retained => `Checkout: ${retained.head} ${retained.tree} ${retained.base}`;

// This selects the next step, not acceptance. Current hooks, gates, bindings and reviews always run again.
function route({node, signal, artifacts}) {
  if (node === 'implement_code' && signal === 'GATE_FAIL' || node === 'reject_gate' && signal === 'TOO_MANY_ROUNDS') return 'coder';
  require(node === 'expert_review_synthesis' && signal === 'REVIEW_INCOMPLETE', `failure ${node}/${signal} cannot resume`);
  const rounds = (readText(path.join(artifacts, 'panel-findings.txt')) || '').split(/^---$/m).filter(part => part.trim());
  const last = rounds.at(-1);
  return !last || REJECT.test(last) || HIGH.test(last) ? 'coder' : 'review';
}

// Each changed file stays inside the writable roots of the old and the new Task contract.
const within = (file, roots) => Array.isArray(roots) && roots.length > 0 && file.length > 0 && !/[\r\n]/.test(file) &&
  !file.split('/').includes('..') && roots.some(scope => scope === '.' || file === scope || file.startsWith(scope.replace(/\/+$/, '') + '/'));

const contexts = claim => (claim.contexts || []).map(item => `${item.address}=${item.digest}`).sort().join(',');
const repository = run => JSON.stringify([run.repository?.id, run.repository?.path, run.repository?.targetBranch]);

// The latest failed non-73 run of this Task owns the checkout. Throw with the reason when it does not match.
function owner(run, dir, checkout) {
  const runs = runDirectories(run.config.stateDir).filter(other => path.resolve(other) !== path.resolve(dir))
    .flatMap(other => {
      const file = path.join(other, 'launch.json');
      return exists(file) ? [{dir: other, run: readRun(file)}] : [];
    }).filter(item => item.run.executionId === run.executionId);
  require(!runs.some(item => runHoldsTasks(item.run)), 'another run of this Task still holds it');
  const failed = runs.filter(item => item.run.claim && item.run.result && item.run.result.code !== 73)
    .sort((a, b) => String(a.run.createdAt).localeCompare(String(b.run.createdAt))).at(-1);
  require(failed, 'no failed run of this Task recorded a checkout');
  const prior = failed.run, retained = prior.retained;
  require(prior.result.status === 'failed' && prior.result.blockConfirmed === true && !prior.result.completed,
    'the latest run of this Task has no confirmed failure');
  require(retained?.checkout === checkout, 'the latest failed run recorded no checkout');
  require(prior.workspace === run.workspace && prior.config.joppa?.url === run.config.joppa.url &&
    prior.task === run.task && (prior.tasks?.length ?? 1) === 1 &&
    prior.config.delivery === run.config.delivery && !prior.requirementDelivery &&
    repository(prior) === repository(run), 'workspace, Joppa, repository or delivery changed');
  const [was] = claimTasks(prior), [now] = claimTasks(run);
  require(was.digest === now.digest && contexts(prior.claim) === contexts(run.claim), 'Task contract or context changed');
  // A soft reset and a new commit change HEAD for the same code. The budget is one retry per HEAD and per tree.
  const retried = prior.claim.ticket?.retained;
  require(!retried || retried.head !== retained.head && retried.tree !== retained.tree, 'this checkout was already retried once');
  require(inside(retained.artifacts, prior.runFolder), 'failure artifacts are outside the failed run');
  return {dir: failed.dir, run: prior, retained};
}

// Validate the retained checkout for this claimed run. Returns {retained, inputs} or {reason}; absent checkout gives {}.
export async function retainedCheckout(run, dir) {
  try {
    const checkout = checkoutPath(run);
    if (!exists(checkout) || fs.lstatSync(checkout).isDirectory() && !fs.readdirSync(checkout).length) return {};
    require(!run.finalizeOnly && !run.requirementDelivery && ['target', 'branch'].includes(run.config.delivery) &&
      claimTasks(run).length === 1, 'reuse needs a single Task with target or branch delivery');
    const prior = owner(run, dir, checkout), {retained} = prior;
    const object = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: run.task});
    const note = prior.run.blockRequest?.operations?.map(({command}) => command)
      .find(command => command.op === 'note' && command.target === run.task);
    const comment = note && object.annotations?.comments?.[note.id];
    // The live Task is current, held by this run's claim and unchanged since that claim.
    require(object.address === run.task && heldBy(run, object) && contractDigest(object) === claimTasks(run)[0].digest,
      'the live Task is not held by this claim or changed after it');
    require(comment && comment.withdrawn !== true &&
      comment.actor === prior.run.joppaWorker?.actor && comment.text === note.text &&
      note.text.includes(`\nRun: ${path.basename(prior.dir)}\n`) && note.text.includes(retainedLine(retained)),
      'Joppa shows no matching failure note for the retained checkout');
    require(writerGone(prior.run, checkout), 'the failed run has no stopped process group, or a container uses the checkout');
    const state = checkoutState(checkout, run.executionId);
    for (const key of ['branch', 'head', 'tree', 'base']) require(state[key] === retained[key], `checkout ${key} changed`);
    const files = laneGit(checkout)('diff', '-z', '--no-renames', '--name-only', `${state.base}..${state.head}`).split('\0').filter(Boolean);
    require(files.length && files.every(file => within(file, prior.run.claim.ticket?.modulePaths) &&
      within(file, run.claim.ticket?.modulePaths)), 'checkout changes files outside the Task modulePaths');
    // Read the remote as a plain config file. The canonical repository is host configuration.
    const remote = command('git', ['config', '--file', path.join(checkout, '.git', 'config'), '--no-includes', '--get', 'remote.origin.url']);
    require(remote === command('git', ['-C', run.repository.path, 'remote', 'get-url', 'origin']),
      'checkout origin differs from the repository origin');
    return {retained: {head: state.head, tree: state.tree, base: state.base, route: route(retained),
      previousRun: path.basename(prior.dir)}, inputs: retained.artifacts};
  } catch (error) { return {reason: error.message}; }
}

// Copy the prior reports for prepare. Gate receipts, reviewed snapshots and bindings receipts are never copied.
export function copyResumeInputs(artifacts, runFolder) {
  const target = path.join(runFolder, 'resume-inputs'), prior = path.join(target, 'prior');
  // The coder always reads the scout report. No report, no resume.
  const scout = path.join(artifacts, 'scout.txt');
  require(exists(scout) && fs.lstatSync(scout).isFile() && fs.statSync(scout).size > 0, 'prior scout.txt is missing or empty');
  fs.mkdirSync(prior, {recursive: true, mode: 0o700});
  const copy = (name, folder) => {
    const source = path.join(artifacts, name);
    if (exists(source) && fs.lstatSync(source).isFile()) fs.copyFileSync(source, path.join(folder, name), fs.constants.COPYFILE_EXCL);
  };
  // The prior coder report describes an older candidate. It stays under prior/.
  for (const name of ['scout.txt', 'test-bindings.json']) copy(name, target);
  for (const name of ['coder-report.txt', 'failure.txt', 'rejects.txt', 'panel-findings.txt']) copy(name, prior);
  // Panel reports are the seats of the latest expert_review step.
  const steps = path.join(path.dirname(artifacts), 'steps');
  const panel = exists(steps) ? fs.readdirSync(steps).filter(name => /-expert_review$/.test(name)).sort().at(-1) : null;
  const seats = panel && readText(path.join(steps, panel, 'inputs.json'));
  for (const {slug} of seats ? JSON.parse(seats) : []) {
    if (typeof slug === 'string' && /^[A-Za-z0-9_-]+$/.test(slug)) copy(`${slug}.md`, prior);
  }
}

// Put the validated record in the claim and copy the prior reports. Returns LANE_REUSE_HEAD, or '' for no reuse.
export async function prepareReuse(run, dir, announce, persist) {
  const reuse = await retainedCheckout(run, dir);
  if (reuse.reason) announce(`[lane] RETAINED checkout not reused: ${reuse.reason}`);
  if (!reuse.retained) return '';
  try { copyResumeInputs(reuse.inputs, fs.realpathSync(run.runFolder)); }
  catch (error) { announce(`[lane] RETAINED checkout not reused: prior reports not copied: ${error.message}`); return ''; }
  run.claim.ticket = {...run.claim.ticket, retained: reuse.retained};
  persist();
  announce(`[lane] REUSE ${reuse.retained.head.slice(0, 12)} from ${reuse.retained.previousRun} · route ${reuse.retained.route}`);
  return reuse.retained.head;
}
