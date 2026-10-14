#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {save, read, herdr, laneArgs} from './runtime.mjs';
import {claimTicket, reopenStartupClaim, blockStartupClaim, attachReport} from './ntk.mjs';
import {claimTask, finishTask, noteHeldTask} from './joppa.mjs';
import {formatLaneLine} from './lane-log.mjs';
import {notifyCompletion} from '../notify.mjs';

const stateFile = path.resolve(process.argv[2]);
const dir = path.dirname(stateFile);
// The worker owns this state after dispatch. The launcher must not change it while the worker lives.
let run = read(stateFile);
const joppa = run.config.source === 'joppa';
if (joppa) {
  const lock = path.join(dir, 'worker.lock');
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.error('Joppa worker lock exists. Inspect the current run before retrying.');
    process.exit(2);
  }
  process.once('exit', () => fs.rmdirSync(lock));
  run = read(stateFile);
  if (run.worker || run.claimRequest || run.result) {
    console.error('Joppa run already started. Inspect its claim and publication before retrying.');
    process.exit(2);
  }
}
const log = fs.openSync(path.join(dir, 'output.log'), 'a', 0o600);
const color = process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== '0' &&
  (process.stdout.isTTY || process.env.FORCE_COLOR === '1');
function announce(message) {
  fs.writeSync(log, message + '\n');
  process.stdout.write(formatLaneLine(message, color) + '\n');
}
run.worker = {pid: process.pid, startedAt: new Date().toISOString()};
save(stateFile, run);
const script = fileURLToPath(new URL('../lane/run.sh', import.meta.url));
let child, signal;
const stop = value => {
  signal = value;
  if (child?.pid) {
    try { process.kill(-child.pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGHUP', () => stop('SIGTERM'));
let result, claimRefused = false;
let artifacts = null;
try {
  announce(`[lane] START ${run.ticket || '(ticket)'} · pane ${run.pane}`);
  announce(`[lane] logs: ${path.join(dir, 'output.log')}`);
  if (signal) throw new Error(`Startup interrupted by ${signal}`);
  announce(`[lane] CLAIM ${run.ticket}`);
  const claimed = run.claim || await (joppa ? claimTask(run, () => save(stateFile, run)) : claimTicket(run.ticket, run.workspace));
  if (claimed?.claimed !== true || claimed.status !== 'in_progress' ||
      String(claimed.id).toLowerCase() !== String(run.executionId || run.ticket).toLowerCase()) {
    delete run.claim;
    claimRefused = true;
    throw new Error(`${joppa ? 'Joppa' : 'NTK'} did not confirm claim for ${run.ticket}`);
  }
  run.claim = {...claimed, workspace: run.workspace};
  save(stateFile, run);
  announce(`[lane] CLAIMED ${run.ticket} · in_progress`);
  if (joppa) {
    run.args = laneArgs({...run.config, gateCommands: run.repository.gateCommands, testCommand: run.repository.testCommand,
      gateTimeoutSeconds: run.repository.gateTimeoutSeconds ?? run.config.gateTimeoutSeconds}, run.executionId);
    save(stateFile, run);
  }
  if (signal) throw new Error(`Startup interrupted by ${signal}`);
  // Dedicated process group lets a stopped worker stop all of its shell children.
  child = spawn('bash', [script, ...run.args], {cwd: path.dirname(path.dirname(script)),
    env: {...process.env, LANE_RUNS_FOLDER: run.runFolder,
      ...(joppa ? {LANE_SOURCE: 'joppa', LANE_REPOSITORY_JSON: JSON.stringify(run.repository),
        LANE_REPOSITORIES_JSON: JSON.stringify(run.config.repositories), LANE_WORKTREE_ROOT: run.config.worktreeRoot,
        LANE_DELIVERY: run.config.delivery, LANE_DELIVERY_BRANCH: run.deliveryBranch || '',
        EQUILL_STORE: run.config.equillStore || process.env.EQUILL_STORE || ''} : {}),
      ...(run.claim ? {LANE_CLAIM_JSON: JSON.stringify(run.claim)} : {})}, detached: true,
    stdio: ['ignore', 'pipe', 'pipe']});
  for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    // Keep original bytes on disk; presentation colors apply only to the tab.
    stream.on('data', data => fs.writeSync(log, data));
    if (color || stream === child.stderr) {
      createInterface({input: stream, crlfDelay: Infinity}).on('line', line => {
        if (color) target.write(formatLaneLine(line, true) + '\n');
      });
    }
    if (!color) stream.on('data', data => target.write(data));
  }
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, receivedSignal) => resolve({code, signal: receivedSignal || signal}));
  });
  result = {...outcome, status: outcome.code === 0 ? 'exited' : 'failed'};
  if (result.status === 'failed') result.error = `Lane exited ${result.code ?? result.signal}; full output: ${path.join(dir, 'output.log')}`;
} catch (error) {
  const message = run.claim || signal ? error.message :
    claimRefused || error.rejected || /^NTK HTTP 4\d\d/.test(error.message) ? `CLAIM_REFUSED: ${error.message}` :
      `CLAIM_UNCERTAIN: ${error.message}; check ${run.ticket} in ${joppa ? 'Joppa' : 'NTK'} before retrying`;
  result = {status: 'failed', code: 2,
    error: message};
  process.exitCode = 2;
} finally {
  announce(`[lane] ${result.status === 'exited' ? 'EXIT' : 'FAILED'} · code ${result.code ?? '?'}${result.signal ? ` · ${result.signal}` : ''}${result.error ? ` · ${result.error}` : ''}`);
  if (!joppa && result.status !== 'exited' && run.claim) {
    const adopted = fs.existsSync(run.runFolder) && fs.readdirSync(run.runFolder).some(name => {
      try {
        const claim = read(path.join(run.runFolder, name, 'artifacts/claim.json'));
        return claim.claimed === true && claim.status === 'in_progress' && claim.workspace === run.workspace &&
          String(claim.id).toLowerCase() === String(run.ticket).toLowerCase();
      } catch { return false; }
    });
    if (!adopted) {
      const preexisting = result.code === 73 && fs.readFileSync(path.join(dir, 'output.log'), 'utf8')
        .match(/^run\.sh: WORKTREE PREEXISTED: [^\r\n]+/m)?.[0];
      try {
        if (preexisting) {
          await blockStartupClaim(run.claim);
          result.blocked = true;
          result.error = preexisting.replace(/^run\.sh: /, '');
          announce(`[lane] ${run.ticket} blocked: ${result.error}`);
          const report = `Ticket: ${run.ticket}\n${result.error}\nLane did not start. Worktree and branches were not modified.\n`;
          try {
            fs.writeFileSync(path.join(dir, 'startup-failure.txt'), report, {mode: 0o600});
            await attachReport(run.ticket, run.workspace, `lane-startup-failure-${path.basename(dir)}.txt`, report);
          }
          catch (error) {
            result.reportError = error.message;
            announce(`[lane] Ticket blocked; cannot attach startup report: ${error.message}`);
          }
        } else {
          await reopenStartupClaim(run.claim);
          result.reopened = true;
          announce(`[lane] ${run.ticket} reopened: startup failed`);
        }
      } catch (error) {
        result[preexisting ? 'blockError' : 'reopenError'] = error.message;
        announce(`[lane] Cannot ${preexisting ? 'block' : 'reopen'} ${run.ticket}: ${error.message}`);
      }
    }
  }
  if (result.status !== 'exited') {
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
  }
  if (joppa) {
    try {
      artifacts ||= fs.existsSync(run.runFolder) ? fs.readdirSync(run.runFolder).sort().reverse()
        .map(name => path.join(run.runFolder, name, 'artifacts'))
        .find(folder => fs.existsSync(path.join(folder, 'landing.txt')) || fs.existsSync(path.join(folder, 'verification.txt'))) : null;
      await finishTask(run, stateFile, result, artifacts);
      const tasks = (run.tasks || [{address: run.task}]).map(task => task.address).join(', ');
      if (result.completed) announce(`[lane] DONE ${tasks} · Joppa confirmed`);
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
  }
  // Record completion first: closing this pane can terminate this process immediately.
  run.result = {...result, finishedAt: new Date().toISOString()};
  if (joppa) process.exitCode = result.code || (result.status === 'exited' ? 0 : 2);
  save(stateFile, run);
  try {
    if (await notifyCompletion(run, result, artifacts)) {
      announce('[lane] Notification sent to channel');
    }
  } catch (error) {
    // Notification delivery does not change the ticket outcome or occupy a lane slot.
    save(path.join(dir, 'notification-error.json'), {error: error.message});
    announce(`[lane] Notification failed: ${error.message}`);
  }
  fs.closeSync(log);
  if (run.config.closeTabOnExit === true) {
    try { herdr(run.config, ['pane', 'close', run.pane]); }
    catch (error) { console.error(`Lane ended; cannot close ${run.pane}: ${error.message}`); }
  } else {
    console.log(`[lane] Finished. Tab kept open; logs: ${path.join(dir, 'output.log')}`);
  }
}
