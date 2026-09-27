#!/usr/bin/env node
// Internal lane completion, not a general ticket CLI.
import fs from 'node:fs';
import path from 'node:path';
import {updateStatus, attachReport} from '../../lane-launcher/ntk.mjs';

const {ticket_id: id, project_name: workspace, MEDULLA_RUN_DIR: runDir} = process.env;
const artifacts = path.join(runDir || '', 'artifacts');

function requireClaim() {
  const claim = JSON.parse(fs.readFileSync(path.join(artifacts, 'claim.json'), 'utf8'));
  if (!id || !workspace || !runDir || claim.claimed !== true || claim.status !== 'in_progress' ||
      claim.id?.toLowerCase() !== id.toLowerCase() || claim.workspace !== workspace || claim.run_dir !== runDir) {
    throw new Error('No confirmed claim for this ticket and run; NTK was not modified');
  }
}

async function main(mode) {
  requireClaim();
  if (mode === 'to-test') {
    const errors = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await updateStatus({id, workspace, status: 'to_test'});
        console.log(`NTK: ${id} → to_test (attempt ${attempt}/3)`);
        return;
      } catch (error) {
        const message = `attempt ${attempt}/3: ${error.message}`;
        errors.push(message);
        console.error(message);
        fs.writeFileSync(path.join(artifacts, 'to-test-errors.txt'), errors.join('\n') + '\n');
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error('NTK to_test failed after 3 attempts; code already landed, do not rerun implementation');
  }
  if (mode !== 'blocked') throw new Error('Expected to-test or blocked');

  const sections = [`Lane failure: ${id}\nWorkspace: ${workspace}\nRun: ${runDir}`];
  for (const name of ['failure.txt', 'scout.txt', 'coder-report.txt', 'git-fix-report.txt', 'rejects.txt', 'panel-findings.txt',
    'architecture.md', 'security.md', 'codereview.md', 'gates/current.json']) {
    const file = path.join(artifacts, name);
    if (fs.existsSync(file)) sections.push(`--- ${name} ---\n${fs.readFileSync(file, 'utf8')}`);
  }
  // Failed gates deliberately have no current.json pointer. Keep their evidence too.
  const gates = path.join(artifacts, 'gates');
  if (fs.existsSync(gates)) {
    const receipts = fs.readdirSync(gates, {withFileTypes: true})
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(gates, entry.name, 'receipt.json'))
      .filter(file => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (receipts.length) {
      const folder = path.dirname(receipts[0]);
      sections.push(`--- latest gate receipt ---\n${fs.readFileSync(receipts[0], 'utf8')}`);
      for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
        if (!entry.isFile() || !/^\d+\.log$/.test(entry.name)) continue;
        const file = path.join(folder, entry.name);
        const size = fs.statSync(file).size;
        const tail = Buffer.alloc(Math.min(size, 16384));
        const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, tail, 0, tail.length, size - tail.length); }
        finally { fs.closeSync(fd); }
        sections.push(`--- gate ${entry.name} (last ${tail.length} of ${size} bytes) ---\n${tail.toString('utf8')}`);
      }
    }
  }
  const report = sections.join('\n\n') + '\n';
  const filename = `lane-failure-${path.basename(runDir)}.txt`;
  fs.writeFileSync(path.join(artifacts, 'ntk-failure-report.txt'), report);
  const errors = [];
  // Status and report are independent: failure of either must not suppress the other.
  try {
    await updateStatus({id, workspace, status: 'blocked', force: true});
  } catch (error) { errors.push(`blocked status: ${error.message}`); }
  try {
    await attachReport(id, workspace, filename, report);
    console.log(`NTK report attached: ${filename}`);
  } catch (error) { errors.push(`failure report: ${error.message}`); }
  if (errors.length) throw new Error(errors.join('\n'));
}

main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
