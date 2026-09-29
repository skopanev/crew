#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {save, read, herdr} from './runtime.mjs';
import {formatLaneLine} from './lane-log.mjs';

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
let result;
try {
  announce(`[lane] START ${run.ticket || '(ticket)'} · pane ${run.pane}`);
  announce(`[lane] logs: ${path.join(dir, 'output.log')}`);
  // Dedicated process group lets a stopped worker stop all of its shell children.
  child = spawn('bash', [script, ...run.args], {cwd: path.dirname(path.dirname(script)),
    env: {...process.env, LANE_RUNS_FOLDER: run.runFolder}, detached: true,
    stdio: ['ignore', 'pipe', 'pipe']});
  for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    // Keep original bytes on disk; presentation colors apply only to the tab.
    stream.on('data', data => fs.writeSync(log, data));
    if (color) {
      createInterface({input: stream, crlfDelay: Infinity}).on('line', line => {
        target.write(formatLaneLine(line, true) + '\n');
      });
    } else stream.on('data', data => target.write(data));
  }
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, receivedSignal) => resolve({code, signal: receivedSignal || signal}));
  });
  result = {...outcome, status: outcome.code === 0 ? 'exited' : 'failed'};
} catch (error) {
  result = {status: 'failed', error: error.message};
} finally {
  announce(`[lane] ${result.status === 'exited' ? 'EXIT' : 'FAILED'} · code ${result.code ?? '?'}${result.signal ? ` · ${result.signal}` : ''}${result.error ? ` · ${result.error}` : ''}`);
  if (result.status !== 'exited') {
    try {
      // Only inspect run artifacts, never recurse into retained worktrees.
      const root = path.join(run.runFolder, 'lane');
      const artifacts = fs.existsSync(root) ? fs.readdirSync(root)
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
  fs.closeSync(log);
  if (run.config.closeTabOnExit === true) {
    try { herdr(run.config, ['pane', 'close', run.pane]); }
    catch (error) { console.error(`Lane ended; cannot close ${run.pane}: ${error.message}`); }
  } else {
    console.log(`[lane] Finished. Tab kept open; logs: ${path.join(dir, 'output.log')}`);
  }
}
