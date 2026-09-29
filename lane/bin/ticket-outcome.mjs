#!/usr/bin/env node
// Internal lane completion, not a general ticket CLI.
import fs from 'node:fs';
import path from 'node:path';
import {updateStatus, attachReport, getTicket, request} from '../../lane-launcher/ntk.mjs';

const {ticket_id: id, project_name: workspace, MEDULLA_RUN_DIR: runDir} = process.env;
const artifacts = path.join(runDir || '', 'artifacts');

function requireClaim() {
  const claim = JSON.parse(fs.readFileSync(path.join(artifacts, 'claim.json'), 'utf8'));
  if (!id || !workspace || !runDir || claim.claimed !== true || claim.status !== 'in_progress' ||
      claim.id?.toLowerCase() !== id.toLowerCase() || claim.workspace !== workspace || claim.run_dir !== runDir) {
    throw new Error('No confirmed claim for this ticket and run; NTK was not modified');
  }
}

async function recordFindings() {
  const findings = fs.readFileSync(path.join(artifacts, 'followups.txt'), 'utf8').trim();
  if (!findings) return;
  const receiptFile = path.join(artifacts, 'finding-ticket.json');
  const reportFile = path.join(artifacts, 'finding-report.txt');
  let receipt;
  if (fs.existsSync(receiptFile)) {
    receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    if (receipt.source !== id || receipt.workspace !== workspace || !receipt.id) {
      throw new Error(`Finding ticket creation is unconfirmed; check NTK and ${receiptFile} before retrying`);
    }
  } else {
    const source = await getTicket(id, workspace);
    if (source.id.toLowerCase() !== id.toLowerCase() || source.status !== 'to_test' || !source.project) {
      throw new Error('Findings require the source ticket in to_test with a project');
    }
    const sections = [`Review findings from ${id}\nWorkspace: ${workspace}\nRun: ${runDir}`, findings];
    for (const name of ['landing.txt', 'architecture.md', 'security.md', 'codereview.md']) {
      const file = path.join(artifacts, name);
      if (fs.existsSync(file)) sections.push(`--- ${name} ---\n${fs.readFileSync(file, 'utf8')}`);
    }
    fs.writeFileSync(reportFile, sections.join('\n\n') + '\n');
    // NTK create has no idempotency key. Mark the attempt before sending it;
    // an uncertain response must not trigger a second ticket on resume.
    receipt = {source: id, workspace};
    fs.writeFileSync(receiptFile, JSON.stringify(receipt) + '\n', {flag: 'wx'});
    const created = await request('POST', '/v1/tickets', {}, {
      workspace, project: source.project, ...(source.module ? {module: source.module} : {}),
      title: Array.from(`[FINIDING] ${source.title}`).slice(0, 256).join(''),
      status: 'blocked', deps: [id],
      body: `Nonblocking review findings from ${id}.\n\n` +
        'The complete findings, evidence and proposed fixes are in the finding-report.txt attachment.\n' +
        `This ticket depends on ${id}. Review the findings before deciding on further work.`,
    });
    if (typeof created?.id !== 'string' || !created.id) throw new Error('NTK returned no finding ticket ID');
    receipt.id = created.id;
    saveReceipt();
  }
  if (!receipt.attached) {
    await attachReport(receipt.id, workspace, 'finding-report.txt', fs.readFileSync(reportFile, 'utf8'));
    receipt.attached = true;
    saveReceipt();
  }
  console.log(`NTK findings: ${receipt.id} (created blocked; depends on ${id})`);

  function saveReceipt() {
    fs.writeFileSync(receiptFile + '.tmp', JSON.stringify(receipt) + '\n');
    fs.renameSync(receiptFile + '.tmp', receiptFile);
  }
}

async function main(mode) {
  requireClaim();
  if (mode === 'findings') return recordFindings();
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
  if (mode !== 'blocked') throw new Error('Expected to-test, blocked or findings');

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
