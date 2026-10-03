#!/usr/bin/env node
// Internal lane completion, not a general ticket CLI.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
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
  const findings = [...new Set(fs.readFileSync(path.join(artifacts, 'followups.txt'), 'utf8')
    .split('\n').map(line => line.trim()).filter(line => /^- (MED|LOW)\s/.test(line)))];
  const errors = [];
  for (const finding of findings) {
    try { await recordFinding(finding); }
    catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

async function recordFinding(finding) {
  const key = createHash('sha256').update(finding).digest('hex');
  const receiptFile = path.join(artifacts, `finding-${key}.json`);
  const reportFile = path.join(artifacts, `finding-${key}.txt`);
  let receipt;
  if (fs.existsSync(receiptFile)) {
    receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    if (receipt.source !== id || receipt.workspace !== workspace || receipt.finding !== finding || !receipt.id) {
      throw new Error(`Finding ticket creation is unconfirmed; check NTK and ${receiptFile} before retrying`);
    }
  } else {
    const source = await getTicket(id, workspace);
    if (source.id.toLowerCase() !== id.toLowerCase() || source.status !== 'to_test' || !source.project) {
      throw new Error('Findings require the source ticket in to_test with a project');
    }
    const sections = [`Review finding from ${id}\nWorkspace: ${workspace}\nRun: ${runDir}`, finding];
    for (const name of ['landing.txt', 'verification.txt', 'architecture.md', 'security.md', 'codereview.md']) {
      const file = path.join(artifacts, name);
      if (fs.existsSync(file)) sections.push(`--- ${name} ---\n${fs.readFileSync(file, 'utf8')}`);
    }
    fs.writeFileSync(reportFile, sections.join('\n\n') + '\n');
    // NTK create has no idempotency key. Mark the attempt before sending it;
    // an uncertain response must not trigger a second ticket on resume.
    receipt = {source: id, workspace, finding};
    fs.writeFileSync(receiptFile, JSON.stringify(receipt) + '\n', {flag: 'wx'});
    const summary = finding.replace(/^- (MED|LOW)\s+-?\s*/, '').split(' - ')[0];
    const created = await request('POST', '/v1/tickets', {}, {
      workspace, project: source.project, ...(source.module ? {module: source.module} : {}),
      title: Array.from(`[FINIDING] ${summary}`).slice(0, 256).join(''),
      status: 'blocked', deps: [id],
      tags: [...new Set([...(source.tags || []), 'findings'])],
      body: `Non-blocking finding from ${id}.\n\n` +
        'Full finding, evidence and proposed fixes in attachment finding-report.txt.\n' +
        `Depends on ${id}. Review before scheduling.`,
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
    throw new Error('NTK to_test failed after 3 attempts; checked code is already on target, do not rerun work');
  }
  if (mode !== 'blocked') throw new Error('Expected to-test, blocked or findings');

  const sections = [`Lane failure: ${id}\nWorkspace: ${workspace}\nRun: ${runDir}`];
  for (const name of ['failure.txt', 'origin.json', 'scout.txt', 'coder-report.txt', 'git-fix-report.txt', 'rejects.txt', 'panel-findings.txt',
    'architecture.md', 'security.md', 'codereview.md', 'gates/current.json', 'fetch.txt', 'preflight.txt',
    'bun-install.txt', 'commit.txt', 'landing-log.txt', 'rebase-log.txt', 'rebase-status.txt',
    'scout-contract.txt.err', 'qa-contract.txt.err']) {
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
        sections.push(`--- gate ${entry.name} (full log) ---\n${fs.readFileSync(file, 'utf8')}`);
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
