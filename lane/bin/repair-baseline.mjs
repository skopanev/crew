#!/usr/bin/env node
// Test explicit repair inputs on the fresh target before restoring earlier changes.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync, execFileSync} from 'node:child_process';

const git = (...args) => execFileSync('git', args, {encoding: 'utf8'}).trim();
let report;
try {
  const artifacts = path.join(process.env.MEDULLA_RUN_DIR, 'artifacts');
  report = path.join(artifacts, 'repair-baseline.txt');
  fs.writeFileSync(report, 'Repair baseline started.\n', {mode: 0o600});
  const ticket = JSON.parse(fs.readFileSync(path.join(artifacts, 'ticket.json'), 'utf8'));
  const tests = ticket.repair?.tests;
  const runner = JSON.parse(process.env.ticket_test_command || '[]');
  const seconds = process.env.gate_timeout_seconds || '900';
  const budget = process.env.REPAIR_BASELINE_TIMEOUT_S || seconds;
  const root = fs.realpathSync('.');
  if (!Array.isArray(tests) || !tests.length || !Array.isArray(runner) || !runner.length ||
      runner.some(arg => typeof arg !== 'string' || !arg.trim() || arg.includes('\0')) ||
      !/^[1-9]\d*$/.test(seconds) || !/^[1-9]\d*$/.test(budget)) {
    throw new Error('Repair baseline requires explicit test files, testCommand and a positive gate timeout');
  }
  for (const file of tests) {
    if (typeof file !== 'string' || !file || path.isAbsolute(file) || file.startsWith('-') ||
        /[\\\0\r\n]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Invalid repair test path: ${JSON.stringify(file)}`);
    }
    if (!fs.realpathSync(file).startsWith(root + path.sep) || !fs.statSync(file).isFile()) {
      throw new Error(`Repair test is not a file inside this checkout: ${file}`);
    }
    git('--literal-pathspecs', 'ls-files', '--error-unmatch', '--', file);
  }
  const head = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Fresh repair checkout is not clean');
  const file = report;
  const started = Date.now();
  const fd = fs.openSync(file, 'a', 0o600);
  let result;
  try {
    const argv = [...runner, ...tests.map(file => './' + file)];
    fs.writeSync(fd, `HEAD: ${head}\nCommand: ${JSON.stringify(argv)}\n`);
    result = spawnSync('timeout', ['--kill-after=5s', String(Math.min(Number(seconds), Number(budget))), ...argv], {stdio: ['ignore', fd, fd]});
    fs.writeSync(fd, `\nExit: ${result.status}\nElapsed: ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  } finally { fs.closeSync(fd); }
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(`Repair baseline could not complete; see ${file}`);
  }
  if (git('rev-parse', 'HEAD') !== head || git('status', '--porcelain', '--untracked-files=all')) {
    throw new Error(`Repair baseline changed the checkout; see ${file}`);
  }
  const outcome = result.status === 0 ? 'pass' : 'fail';
  fs.writeFileSync(path.join(artifacts, 'scout.txt'),
    `Recorded repair tests ${outcome} on fresh target ${head}. Read artifacts/repair-baseline.txt.\n`, {mode: 0o600});
  if (result.status !== 0) {
    console.error(`Repair tests fail on ${head}; continue implementation. See ${file}`);
    process.exitCode = 3;
  } else {
    fs.writeFileSync(path.join(artifacts, 'ticket-checks.json'), JSON.stringify(tests) + '\n', {mode: 0o600});
    console.log('<signal:var key=VERIFY_ONLY>true</signal:var>');
    console.log(`<signal:VERIFY_EXISTING>Repair tests pass on fresh target ${head}; run required gates and review.</signal:VERIFY_EXISTING>`);
  }
} catch (error) {
  if (report) fs.appendFileSync(report, `Error: ${error.message}\n`);
  console.error(`Repair baseline: ${error.message}`);
  process.exitCode = 1;
}
