// Lane worker outcome steps after the lane process ends.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {save, read, runDirectories} from './runtime.mjs';
import {api, finishTask, noteHeldTask} from './joppa.mjs';
import {parsePublication} from './requirement-delivery.mjs';
import {repositoryGit} from './publication-guard.mjs';

// Announce the latest failure report and its failed checks. Returns its artifacts folder.
export function failureDetails(run, announce) {
  let artifacts = null;
  try {
    // Only inspect run artifacts, never recurse into retained worktrees.
    const root = run.runFolder;
    artifacts = fs.existsSync(root) ? fs.readdirSync(root)
      .map(name => path.join(root, name, 'artifacts'))
      .filter(folder => fs.existsSync(path.join(folder, 'failure.txt')))
      .sort((a, b) => fs.statSync(path.join(b, 'failure.txt')).mtimeMs - fs.statSync(path.join(a, 'failure.txt')).mtimeMs)[0] : null;
    if (artifacts) {
      announce(`[lane] ${fs.readFileSync(path.join(artifacts, 'failure.txt'), 'utf8').trim()}`);
      const gates = path.join(artifacts, 'gates');
      const receipts = fs.existsSync(gates) ? fs.readdirSync(gates)
        .map(name => path.join(gates, name, 'receipt.json')).filter(file => fs.existsSync(file))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) : [];
      for (const check of (receipts[0] ? read(receipts[0]).checks : []) || []) {
        if (check.exit_code !== 0 || check.stdout_matches === false) {
          const command = typeof check.command === 'string' ? check.command : JSON.stringify(check.command);
          announce(`[lane] FAILED check: ${command} · exit ${check.exit_code} · stdout match ${check.stdout_matches ?? true} · log: ${check.log}`);
        }
      }
    }
  } catch (error) { announce(`[lane] Cannot read failure details: ${error.message}`); }
  return artifacts;
}

// Confirm a Requirement finalization or record its failure note. Returns the artifacts folder.
export async function finishFinalization({run, dir, stateFile, result, artifacts, announce}) {
  result.held = false;
  result.blocked = false;
  if (result.code === 0) {
    try {
      artifacts ||= fs.readdirSync(run.runFolder).map(name => path.join(run.runFolder, name, 'artifacts'))
        .find(folder => fs.existsSync(path.join(folder, 'landing.txt')) || fs.existsSync(path.join(folder, 'verification.txt')));
      const receipt = ['landing.txt', 'verification.txt'].map(name => path.join(artifacts || '', name)).find(fs.existsSync);
      if (!receipt) throw new Error('Finalization publication evidence is missing');
      const {sha, target} = parsePublication(fs.readFileSync(receipt, 'utf8'));
      if (target !== run.repository.targetBranch) throw new Error('Finalization target differs from configuration');
      const git = args => repositoryGit(run.config, run.repository, args);
      const head = (await git(['ls-remote', 'origin', `refs/heads/${target}`])).split(/\s/)[0];
      if (!head) throw new Error('Finalization target is absent');
      await git(['fetch', '--no-write-fetch-head', 'origin', head]);
      await git(['merge-base', '--is-ancestor', sha, head]);
      result.completed = true;
      announce(`[lane] FINALIZED ${run.requirement} · ${sha} on ${target}`);
    } catch (error) {
      result.status = 'failed'; result.code = 2;
      result.error = `REQUIREMENT_FINALIZE_UNCONFIRMED: ${error.message}`;
    }
  }
  if (!result.completed && run.requirementDelivery) {
    const {head, targetHead, fingerprint} = run.requirementDelivery;
    let reasonCode;
    try { reasonCode = JSON.parse(fs.readFileSync(path.join(artifacts, 'origin.json'), 'utf8')).signal; } catch {}
    if (['MERGE_CONFLICT', 'REQUIREMENT_GATE_FAIL'].includes(reasonCode)) {
      result.finalizeFailed = {head, targetHead, fingerprint, reasonCode};
    }
    try {
      const noted = runDirectories(run.config.stateDir).some(priorDir => {
        if (path.resolve(priorDir) === path.resolve(dir)) return false;
        let prior;
        try { prior = read(path.join(priorDir, 'launch.json')); }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        const previous = prior.requirementDelivery;
        return prior.finalizeOnly && prior.finalizationFailureRequest && prior.requirement === run.requirement &&
          (prior.repositoryId || prior.repository?.id) === run.repository.id && previous?.head === head &&
          previous.targetHead === targetHead && previous.fingerprint === fingerprint;
      });
      if (!noted) {
        const failure = artifacts && path.join(artifacts, 'failure.txt');
        const details = failure && fs.existsSync(failure) ? fs.readFileSync(failure, 'utf8') : result.error || 'Finalization failed';
        run.finalizationFailureRequest = {workspace: run.workspace, request_id: randomUUID(), command: {op: 'note',
          target: run.requirement, id: randomUUID(), reply_to: null,
          text: `Requirement finalization failed.\nBranch: ${run.deliveryBranch}\nHead: ${head}\nTarget head: ${targetHead}\nRun: ${path.basename(dir)}\n${details.slice(0, 1500)}`}};
        save(stateFile, run);
        await api(run.config, run.joppaWorker, 'joppa_command', run.finalizationFailureRequest);
      }
    } catch (error) { result.noteError = error.message; }
  }
  return artifacts;
}

// Record the Joppa outcome of claimed Tasks. Returns the final result and artifacts folder.
export async function recordTaskOutcome({run, stateFile, result, artifacts, announce}) {
  try {
    artifacts ||= fs.existsSync(run.runFolder) ? fs.readdirSync(run.runFolder).sort().reverse()
      .map(name => path.join(run.runFolder, name, 'artifacts'))
      .find(folder => fs.existsSync(path.join(folder, 'landing.txt')) || fs.existsSync(path.join(folder, 'verification.txt'))) : null;
    await finishTask(run, stateFile, result, artifacts);
    const tasks = (run.tasks || [{address: run.task}]).map(task => task.address).join(', ');
    if (result.completed) announce(`[lane] DONE ${tasks} · Joppa confirmed`);
    if (result.released) {
      announce(result.checkpointed
        ? `[lane] RELEASED ${tasks} · checkpoint ${run.recovery.sha.slice(0, 12)} saved on ${run.recovery.ref}; Joppa confirmed`
        : `[lane] RELEASED ${tasks} · startup failed; Joppa confirmed; no agent work`);
      if (run.recovery?.cleanupError) announce(`[lane] Cleanup failed: ${run.recovery.cleanupError}`);
    }
    if (result.blockConfirmed) announce(`[lane] BLOCKED ${tasks} · Joppa confirmed; claims released`);
    if (result.held) announce(`[lane] HELD ${tasks} · claims retained with failure evidence`);
  } catch (error) {
    result = {...result, status: 'failed', code: 2, held: true, blocked: false,
      error: `JOPPA_OUTCOME_UNCONFIRMED: ${error.message}`};
    announce(`[lane] ${result.error}`);
    if (run.claim && !run.failureRequest) {
      try {
        await noteHeldTask(run, stateFile, result.error);
        announce(`[lane] ${run.task} · unconfirmed outcome note recorded`);
      } catch (noteError) {
        result.noteError = noteError.message;
        announce(`[lane] Cannot record outcome note: ${noteError.message}`);
      }
    }

  }
  return {result, artifacts};
}

// After a failed intermediate Task, note a Requirement head that moved anyway.
export async function checkRequirementHead({run, stateFile, result, announce}) {
  try {
    const {branch, head: before} = run.requirementDelivery;
    const head = (await repositoryGit(run.config, run.repository,
      ['ls-remote', 'origin', `refs/heads/${branch}`])).split(/\s/)[0] || '';
    if (head && head !== before) {
      const diagnosis = `REQUIREMENT_HEAD_UNCONFIRMED: ${branch} moved from ${before || '<absent>'} to ${head} during failed Task ${run.task}. Completion was not confirmed. Inspect the saved completion request. Retry it only if the Task contract is unchanged. Otherwise, the operator must restore the prior Requirement head.`;
      announce(`[lane] ${diagnosis}`);
      run.publicationFailureRequest ||= {workspace: run.workspace, request_id: randomUUID(),
        command: {op: 'note', target: run.requirement, id: randomUUID(), reply_to: null, text: diagnosis}};
      save(stateFile, run);
      await api(run.config, run.joppaWorker, 'joppa_command', run.publicationFailureRequest);
    }
  } catch (error) {
    result.noteError = error.message;
    announce(`[lane] Requirement publication check failed: ${error.message}`);
  }
}
