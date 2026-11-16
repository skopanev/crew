// Host-owned failed checkout disposal. The launch state is outside the container's writable mounts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID, createHash} from 'node:crypto';
import {save, command} from './runtime.mjs';
import {checkoutPath, writerGone, laneGit} from './retained-checkout.mjs';

const stat = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const require = (condition, message) => { if (!condition) throw new Error(message); };
const matches = (record, file) => {
  const current = stat(file);
  return current?.isDirectory() && !current.isSymbolicLink() && current.dev === record.dev && current.ino === record.ino;
};

// An atomic mkdir proves ownership. A pre-existing directory is left for run.sh to refuse.
export function prepareDiscardCheckout(run, persist) {
  if (run.config.discardFailedWorktree !== true || run.finalizeOnly) return '';
  const checkout = checkoutPath(run), root = path.resolve(run.config.worktreeRoot);
  require(path.dirname(checkout) === root, 'Discard checkout escapes worktreeRoot');
  fs.mkdirSync(root, {recursive: true});
  require(fs.realpathSync(root) === root, 'Discard worktreeRoot must not be a symlink');
  try { fs.mkdirSync(checkout); }
  catch (error) { if (error.code === 'EEXIST') return ''; throw error; }
  const {dev, ino} = fs.lstatSync(checkout);
  run.discardCheckout = {path: checkout, dev, ino};
  persist();
  return `${dev}:${ino}`;
}

// An early startup exit can precede run.sh's trap. rmdir cannot remove implementation files.
export function removeEmptyDiscardCheckout(run, announce) {
  const record = run.discardCheckout;
  if (!record || run.config.discardFailedWorktree !== true) return;
  try {
    if (record.path !== checkoutPath(run) || !matches(record, record.path) || fs.readdirSync(record.path).length ||
        run.launchPgid && !writerGone(run, record.path)) return;
    fs.rmdirSync(record.path);
    record.removed = true;
    announce(`run.sh: removed unused worktree: ${record.path}`);
  } catch (error) { announce(`[lane] Empty checkout cleanup failed: ${error.message}`); }
}

// A private index captures the working tree without changing the lane's real index.
function saveRecovery(run, checkout, artifacts) {
  const root = fs.realpathSync(run.runFolder);
  artifacts ||= path.join(root, 'artifacts');
  fs.mkdirSync(artifacts, {recursive: true, mode: 0o700});
  const folder = fs.realpathSync(artifacts);
  require(folder.startsWith(root + path.sep), 'Recovery artifacts escape the run folder');
  const patch = path.join(folder, 'recovery.patch'), failure = path.join(folder, 'failure.txt');
  const existing = stat(patch);
  require(!existing || existing.isFile() && !existing.isSymbolicLink(), 'Recovery patch is not a plain file');
  require(!stat(failure) || stat(failure).isFile() && !stat(failure).isSymbolicLink(), 'Failure report is not a plain file');
  const git = laneGit(checkout);
  const recorded = fs.readFileSync(path.join(checkout, '.git/lane-base'), 'utf8').trim();
  require(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(recorded), 'Recovery base is invalid');
  const previous = existing && stat(failure) && fs.readFileSync(failure, 'utf8').match(/Recovery base: ([0-9a-f]{40}(?:[0-9a-f]{24})?)\b/g)?.at(-1)?.slice('Recovery base: '.length);
  const target = previous || run.recoveryBase || command('git', ['-C', run.repository.path, 'rev-parse', '--verify',
    `refs/remotes/origin/${run.repository.targetBranch}^{commit}`]);
  require(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(target), 'Host recovery base is invalid');
  const base = previous || git('merge-base', '--octopus', recorded, 'HEAD', target);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-recovery-'));
  const pending = patch + '.' + randomUUID() + '.tmp';
  try {
    const env = {...process.env, GIT_INDEX_FILE: path.join(temp, 'index')};
    const index = laneGit(checkout, {env});
    index('read-tree', base);
    index('add', '-A', '--', '.');
    require(!index('ls-files', '--stage', '-z').split('\0').some(row => row.startsWith('160000 ')),
      'Recovery patch cannot preserve a nested repository; checkout retained');
    const tree = index('write-tree');
    if (existing) {
      index('read-tree', base);
      if (existing.size) index('apply', '--cached', '--binary', patch);
      require(index('write-tree') === tree, 'Existing recovery patch does not restore the current checkout');
      return patch;
    }
    const fd = fs.openSync(pending, 'wx', 0o600);
    try {
      laneGit(checkout, {env, stdio: ['ignore', fd, 'pipe']})('diff', '--cached', '--binary', '--full-index',
        '--no-ext-diff', '--no-textconv', base, '--');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    index('read-tree', base);
    if (fs.statSync(pending).size) index('apply', '--cached', '--binary', pending);
    require(index('write-tree') === tree, 'Recovery patch does not restore the complete working tree');
    fs.linkSync(pending, patch);
    fs.unlinkSync(pending);
    const digest = createHash('sha256').update(fs.readFileSync(patch)).digest('hex');
    fs.appendFileSync(failure, `\nRecovery patch: ${patch}\nRecovery base: ${base}\nRecovery SHA-256: ${digest}\n`, {mode: 0o600});
    return patch;
  } finally {
    if (stat(pending)) fs.unlinkSync(pending);
    fs.rmSync(temp, {recursive: true, force: true});
  }
}

// Called only after the worker saved the outcome. Never discard an uncertain or foreign checkout.
export function discardFailedCheckout(run, stateFile, announce, artifacts = null) {
  const record = run.discardCheckout, result = run.result;
  if (run.config.discardFailedWorktree !== true || !record || record.removed || result?.status !== 'failed' || result.code === 73) return;
  try {
    if (!stat(record.path)) return;
    require(result.held !== true && (result.blockConfirmed === true ||
      result.released === true && run.releaseConfirmed === true), 'Joppa outcome is not confirmed');
    require(record.path === checkoutPath(run) && fs.realpathSync(path.dirname(record.path)) === path.dirname(record.path),
      'Discard checkout path changed');
    require(matches(record, record.path), 'Discard checkout identity changed');
    require(writerGone(run, record.path), 'A lane process or container can still write the checkout');
    const patch = saveRecovery(run, record.path, artifacts);
    announce(`[lane] Recovery patch saved: ${patch}`);
    const discarded = fs.mkdtempSync(path.join(path.dirname(record.path), '.discard-'));
    fs.renameSync(record.path, discarded);
    record.discardedPath = discarded;
    save(stateFile, run);
    if (!matches(record, discarded)) {
      if (!stat(record.path)) fs.renameSync(discarded, record.path);
      throw new Error('Renamed checkout identity changed; directory preserved');
    }
    fs.rmSync(discarded, {recursive: true});
    record.removed = true;
    announce('[lane] DISCARDED failed checkout; recovery patch preserved');
  } catch (error) {
    record.error = error.message;
    announce(`[lane] CHECKOUT_DISCARD_FAILED: ${error.message}`);
  }
  save(stateFile, run);
}
