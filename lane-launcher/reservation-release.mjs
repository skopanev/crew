// A newer Joppa release can supersede a dead pre-landing reservation without changing its failure evidence.
import fs from 'node:fs';
import path from 'node:path';
import {alive} from './runtime.mjs';
import {claimTasks, hasRecoveryCheckpoint} from './joppa-common.mjs';
import {nodeAssignee} from './joppa-nodes.mjs';
import {writerGone} from './container-cleanup.mjs';

const landing = node => ['git_landing', 'cleanup', 'notify_success'].includes(node);
function beforeLanding(run) {
  let seen = false;
  for (const name of fs.readdirSync(run.runFolder)) {
    const folder = path.join(run.runFolder, name);
    if (!fs.statSync(folder).isDirectory()) continue;
    const journal = path.join(folder, 'journal.jsonl');
    if (!fs.existsSync(journal)) continue;
    const rows = fs.readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    if (typeof rows.at(-1)?.node !== 'string' || typeof rows.at(-1)?.next !== 'string' ||
        rows.some(row => landing(row.node) || landing(row.next))) return false;
    const origin = path.join(folder, 'artifacts/origin.json');
    if (fs.existsSync(origin)) {
      const value = JSON.parse(fs.readFileSync(origin, 'utf8'));
      if (landing(value.node) || value.signal === 'PUBLICATION_UNCERTAIN') return false;
    }
    const outcome = path.join(folder, 'outcome.json');
    if (fs.existsSync(outcome) && landing(JSON.parse(fs.readFileSync(outcome, 'utf8')).error?.node)) return false;
    for (const file of ['landing.txt', 'verification.txt', 'landing-log.json']) {
      if (fs.existsSync(path.join(folder, 'artifacts', file))) return false;
    }
    seen = true;
  }
  return seen;
}

export async function reservationReleased(run, read, gone = writerGone) {
  try {
    if (!run.result?.held || !run.result.finishedAt || run.result.publicationUncertain || run.finalizeOnly ||
        !run.claim?.assignee || alive(run.worker?.pid) || run.completionRequest || run.blockRequest ||
        run.releaseRequest || run.recoveryNoteRequest || hasRecoveryCheckpoint(run.recovery)) return false;
    const tasks = claimTasks(run);
    if (!tasks.length || tasks.some(task => !Number.isSafeInteger(task.revision))) return false;
    for (const task of tasks) {
      const object = await read('joppa_objects', {address: task.address});
      if (object?.address !== task.address || object.historical !== false || object.document?.present !== true ||
          !Number.isSafeInteger(object.current_revision) || object.current_revision <= task.revision ||
          nodeAssignee(object)) return false;
    }
    const checkout = path.join(run.config.worktreeRoot, run.executionId);
    try { fs.lstatSync(checkout); return false; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return beforeLanding(run) && gone(run, checkout);
  } catch { return false; }
}
