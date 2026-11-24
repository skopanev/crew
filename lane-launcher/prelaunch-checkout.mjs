// Preserve an abandoned checkout before the next claimed run creates its directory.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {command, readRun, runDirectories} from './runtime.mjs';
import {checkoutPath, laneGit, writerGone} from './retained-checkout.mjs';
import {runHoldsTasks} from './joppa-selection.mjs';
import {saveRecovery} from './failed-checkout.mjs';

const need = (ok, message) => { if (!ok) throw new Error(message); };
const exists = file => fs.existsSync(file);

export function clearPreviousCheckout(run, dir, persist, announce) {
  if (run.config.discardFailedWorktree !== true || run.finalizeOnly) return;
  const checkout = checkoutPath(run), root = path.resolve(run.config.worktreeRoot);
  if (!exists(checkout)) return;
  const original = fs.lstatSync(checkout);
  need(path.dirname(checkout) === root && fs.realpathSync(root) === root && original.isDirectory() &&
    !original.isSymbolicLink(), 'Preexisting checkout has an unsafe path');
  if (!fs.readdirSync(checkout).length) return;
  const others = runDirectories(run.config.stateDir).filter(folder => path.resolve(folder) !== path.resolve(dir))
    .flatMap(folder => exists(path.join(folder, 'launch.json')) ? [readRun(path.join(folder, 'launch.json'))] : [])
    .filter(other => other.executionId === run.executionId);
  need(!others.some(runHoldsTasks), 'Another run still holds the preexisting checkout');
  const prior = others.filter(other => other.result?.status === 'failed' && other.result.code !== 73 &&
    other.result.blockConfirmed === true && (other.discardCheckout?.path === checkout || other.retained?.checkout === checkout))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1);
  need(prior && prior.workspace === run.workspace && prior.task === run.task &&
    prior.config.joppa?.url === run.config.joppa?.url && prior.repository?.path === run.repository.path &&
    prior.repository?.targetBranch === run.repository.targetBranch, 'No matching failed run owns the preexisting checkout');
  if (prior.discardCheckout) need(prior.discardCheckout.dev === original.dev && prior.discardCheckout.ino === original.ino,
    'The preexisting checkout identity changed');
  need(writerGone(prior, checkout), 'A process or container still uses the preexisting checkout');
  const dotGit = path.join(checkout, '.git');
  need(fs.lstatSync(dotGit).isDirectory() && fs.realpathSync(dotGit) === dotGit,
    'The preexisting checkout has no private Git directory');
  const artifacts = path.join(run.runFolder, 'prelaunch-recovery');
  fs.mkdirSync(artifacts, {recursive: true, mode: 0o700});
  const lock = path.join(checkout, '.git/index.lock');
  if (exists(lock)) {
    const before = fs.lstatSync(lock);
    need(before.isFile() && !before.isSymbolicLink() && before.size === 0, 'The Git index lock needs inspection');
    const owners = spawnSync('lsof', ['-F', 'pn', '--', lock], {encoding: 'utf8', timeout: 30_000});
    need(!owners.error && owners.status === 1 && !owners.stdout && !owners.stderr,
      'Cannot prove that the Git index lock has no owner');
    const after = fs.lstatSync(lock), saved = path.join(artifacts, 'stale-index.lock');
    need(before.dev === after.dev && before.ino === after.ino && after.size === 0 &&
      before.mtimeMs === after.mtimeMs && !exists(saved), 'The Git index lock changed');
    fs.renameSync(lock, saved);
  }
  const git = laneGit(checkout), head = git('rev-parse', '--verify', 'HEAD^{commit}');
  need(git('symbolic-ref', '-q', 'HEAD') === `refs/heads/ticket-${run.executionId}`, 'The preexisting checkout has another branch');
  if (!prior.discardCheckout) need(prior.retained.head === head &&
    prior.retained.tree === git('rev-parse', 'HEAD^{tree}'), 'The retained checkpoint changed');
  const ref = 'refs/crew-recovery/prelaunch-' + randomUUID();
  command('git', ['-C', run.repository.path, 'fetch', '--no-tags', checkout, `${head}:${ref}`]);
  need(command('git', ['-C', run.repository.path, 'rev-parse', ref]) === head, 'Recovery ref verification failed');
  const evidence = {...prior, runFolder: run.runFolder, recoveryBase: run.recoveryBase};
  const patch = saveRecovery(evidence, checkout, artifacts);
  const record = {checkout, head, ref, patch, priorRun: path.basename(path.dirname(prior.runFolder))};
  fs.writeFileSync(path.join(artifacts, 'preserved.json'), JSON.stringify(record, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  run.prelaunchRecovery = record;
  persist();
  need(writerGone(prior, checkout) && git('rev-parse', 'HEAD') === head, 'The checkout changed during recovery');
  saveRecovery(evidence, checkout, artifacts);
  const current = fs.lstatSync(checkout);
  need(current.dev === original.dev && current.ino === original.ino, 'The checkout identity changed during recovery');
  const discarded = path.join(root, '.discard-prelaunch-' + randomUUID());
  fs.renameSync(checkout, discarded);
  record.discardedPath = discarded;
  persist();
  fs.rmSync(discarded, {recursive: true});
  record.removed = true;
  persist();
  announce('[lane] Previous checkout removed; its recovery ref and patch are saved');
}
