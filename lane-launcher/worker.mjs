#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {save, read, herdr} from './runtime.mjs';
import {claimTicket, reopenStartupClaim, blockStartupClaim, attachReport} from './ntk.mjs';
import {formatLaneLine} from './lane-log.mjs';
import {notifyCompletion} from '../notify.mjs';

const stateFile = path.resolve(process.argv[2]);
const dir = path.dirname(stateFile);
const run = read(stateFile);
const log = fs.openSync(path.join(dir, 'output.log'), 'a', 0o600);
const color = process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== '0' &&
  (process.stdout.isTTY || process.env.FORCE_COLOR === '1');
function announce(message) {
  fs.writeSync(log, message + '\n');
  process.stdout.write(formatLaneLine(message, color) + '\n');
}
save(path.join(dir, 'worker.json'), {pid: process.pid, startedAt: new Date().toISOString()});
const script = fileURLToPath(new URL('../lane/run.sh', import.meta.url));
let child, signal, lastStderr;
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
  const claimed = run.claim || await claimTicket(run.ticket, run.workspace);
  if (claimed?.claimed !== true || claimed.status !== 'in_progress' ||
      String(claimed.id).toLowerCase() !== String(run.ticket).toLowerCase()) {
    delete run.claim;
    claimRefused = true;
    throw new Error(`NTK did not confirm claim for ${run.ticket}`);
  }
  run.claim = {...claimed, workspace: run.workspace};
  save(stateFile, run);
  announce(`[lane] CLAIMED ${run.ticket} · in_progress`);
  if (signal) throw new Error(`Startup interrupted by ${signal}`);
  // Dedicated process group lets a stopped worker stop all of its shell children.
  child = spawn('bash', [script, ...run.args], {cwd: path.dirname(path.dirname(script)),
    env: {...process.env, LANE_RUNS_FOLDER: run.runFolder,
      ...(run.claim ? {LANE_CLAIM_JSON: JSON.stringify(run.claim)} : {})}, detached: true,
    stdio: ['ignore', 'pipe', 'pipe']});
  for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    // Keep original bytes on disk; presentation colors apply only to the tab.
    stream.on('data', data => fs.writeSync(log, data));
    if (color || stream === child.stderr) {
      createInterface({input: stream, crlfDelay: Infinity}).on('line', line => {
        if (stream === child.stderr && line.trim()) lastStderr = line;
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
  if (result.status === 'failed' && lastStderr) result.error = lastStderr;
} catch (error) {
  const message = run.claim || signal ? error.message :
    claimRefused || /^NTK HTTP 4\d\d/.test(error.message) ? `CLAIM_REFUSED: ${error.message}` :
      `CLAIM_UNCERTAIN: ${error.message}; check ${run.ticket} in NTK before retrying`;
  result = {status: 'failed', code: 2,
    error: message};
  process.exitCode = 2;
} finally {
  announce(`[lane] ${result.status === 'exited' ? 'EXIT' : 'FAILED'} · code ${result.code ?? '?'}${result.signal ? ` · ${result.signal}` : ''}${result.error ? ` · ${result.error}` : ''}`);
  if (result.status !== 'exited' && run.claim) {
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
          if (check.exit_code !== 0) announce(`[lane] FAILED check: ${check.command} · exit ${check.exit_code} · log: ${check.log}`);
        }
      }
    } catch (error) { announce(`[lane] Cannot read failure details: ${error.message}`); }
  }
  // Record completion first: closing this pane can terminate this process immediately.
  save(path.join(dir, 'result.json'), {...result, finishedAt: new Date().toISOString()});
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
