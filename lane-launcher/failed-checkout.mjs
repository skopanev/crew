// Host-owned failed checkout disposal. The launch state is outside the container's writable mounts.
import fs from 'node:fs';
import path from 'node:path';
import {save} from './runtime.mjs';
import {checkoutPath, writerGone} from './retained-checkout.mjs';

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
    if (!matches(record, record.path) || fs.readdirSync(record.path).length ||
        run.launchPgid && !writerGone(run, record.path)) return;
    fs.rmdirSync(record.path);
    announce(`run.sh: removed unused worktree: ${record.path}`);
  } catch (error) { announce(`[lane] Empty checkout cleanup failed: ${error.message}`); }
}

// Called only after the worker saved the outcome. Never discard an uncertain or foreign checkout.
export function discardFailedCheckout(run, stateFile, announce) {
  const record = run.discardCheckout, result = run.result;
  if (run.config.discardFailedWorktree !== true || !record || result?.status !== 'failed' || result.code === 73) return;
  try {
    if (!stat(record.path)) return;
    require(result.held !== true && (result.blockConfirmed === true ||
      result.released === true && run.releaseConfirmed === true), 'Joppa outcome is not confirmed');
    require(record.path === checkoutPath(run) && fs.realpathSync(path.dirname(record.path)) === path.dirname(record.path),
      'Discard checkout path changed');
    require(matches(record, record.path), 'Discard checkout identity changed');
    require(writerGone(run, record.path), 'A lane process or container can still write the checkout');
    const discarded = path.join(path.dirname(record.path), `.discard-${path.basename(path.dirname(stateFile))}`);
    require(!stat(discarded), 'Discard destination already exists');
    fs.renameSync(record.path, discarded);
    record.discardedPath = discarded;
    save(stateFile, run);
    if (!matches(record, discarded)) {
      if (!stat(record.path)) fs.renameSync(discarded, record.path);
      throw new Error('Renamed checkout identity changed; directory preserved');
    }
    fs.rmSync(discarded, {recursive: true});
    record.removed = true;
    announce('[lane] DISCARDED failed checkout and its local branch');
  } catch (error) {
    record.error = error.message;
    announce(`[lane] CHECKOUT_DISCARD_FAILED: ${error.message}`);
  }
  save(stateFile, run);
}
