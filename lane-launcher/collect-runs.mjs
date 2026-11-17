#!/usr/bin/env node
// Append completed native run evidence. Lock the output file with lockf or flock.
import fs from 'node:fs';
import path from 'node:path';
import {completionEvent, reasonCode} from '../notify.mjs';

const json = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const dirs = root => fs.existsSync(root) ? fs.readdirSync(root, {withFileTypes: true})
  .filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name)) : [];
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const unique = values => [...new Set(values.filter(Boolean))];
const seconds = (start, end) => Number.isFinite(start) && Number.isFinite(end) && end >= start
  ? Math.round((end - start) / 10) / 100 : null;

function stages(run, ended) {
  const journal = rows(path.join(run, 'journal.jsonl'));
  const steps = journal.map(row => ({step: row.step, node: row.node, signal: row.signal,
    duration_s: row.duration_s ?? null, attempts: row.attempts ?? null,
    ...(row.model ? {model: row.model} : {})}));
  for (const folder of dirs(path.join(run, 'steps'))) {
    const match = /^(\d+)-(.+)$/.exec(path.basename(folder));
    if (!match || steps.some(step => step.step === Number(match[1]))) continue;
    const started = fs.statSync(folder).birthtimeMs;
    steps.push({step: Number(match[1]), node: match[2], duration_s: null, incomplete: true,
      observed_until_run_end_s: started > 0 ? seconds(started, ended) : null});
  }
  steps.sort((a, b) => a.step - b.step);
  const groups = {implement: ['implement_code'], gates: ['prepare_review'],
    review: ['expert_review', 'expert_review_synthesis', 'reject_gate'],
    publish: ['git_landing', 'publish', 'cleanup', 'clean_success', 'clean_failure']};
  const stage_seconds = Object.fromEntries(Object.entries(groups).map(([name, nodes]) => {
    const selected = steps.filter(step => nodes.includes(step.node));
    return [name, !selected.length || selected.some(step => step.duration_s == null) ? null :
      Math.round(selected.reduce((sum, step) => sum + step.duration_s, 0) * 100) / 100];
  }));
  return {steps, stage_seconds, review_rounds: journal.filter(row => row.node === 'expert_review').length};
}

function lane(folder) {
  const run = json(path.join(folder, 'launch.json')), result = run?.result;
  if (!result?.finishedAt) return null;
  const native = dirs(run.runFolder || path.join(folder, 'lane')).sort().at(-1);
  const artifacts = native && path.join(native, 'artifacts');
  const outcome = native && json(path.join(native, 'outcome.json'));
  const event = completionEvent(run, result, artifacts);
  const code = reasonCode(event);
  const status = result.pendingDelivery ? 'PENDING_LANDING' : result.completed ? 'DONE' :
    outcome?.error?.code === 'E_DEADLINE' || event.event === 'TIMEOUT' || code === 'OVER_TIME' ? 'OVER_TIME' :
    result.held ? 'OUTCOME_UNCONFIRMED' : code || 'FAILED';
  const members = run.claim?.tasks || run.tasks || [];
  const acs = unique([run.claim?.parent?.criterion && run.claim.parent.address,
    ...members.map(item => item.parent?.criterion && item.parent.address),
    ...(run.claim?.contexts || []).filter(item => item.criterion).map(item => item.address)]);
  const start = run.worker?.startedAt || run.createdAt, end = result.finishedAt;
  return {source: 'dolber', run_id: path.basename(folder), task: run.task || run.ticket,
    tasks: unique(members.map(item => item.address).concat(run.task || run.ticket)), ac: acs[0] || null, acs,
    started_at: start, ended_at: end, duration_s: seconds(Date.parse(start), Date.parse(end)), status,
    reason_code: code || null, reason: event.summary || null,
    claim_released: result.completed || result.pendingDelivery || result.released || result.blockConfirmed || false,
    delivery: run.pendingDeliveryRequest?.operations?.[0]?.command?.data?.delivery || null,
    ...(native ? stages(native, Date.parse(end)) : {steps: [], stage_seconds: {}, review_rounds: 0})};
}

function lander(folder) {
  const outcomeFile = path.join(folder, 'outcome.json'), outcome = json(outcomeFile);
  if (!outcome) return null;
  const art = path.join(folder, 'artifacts'), result = json(path.join(art, 'result.json'));
  const input = json(path.join(art, 'input.json')), state = json(path.join(art, 'lander.json'));
  const items = input?.items || (input?.selected ? [input.selected] : []);
  const ended = fs.statSync(outcomeFile).mtimeMs, duration = outcome.duration_s;
  const batch = items.map(item => ({task: item.address, ac: item.document?.parent || null,
    ...item.document?.data?.delivery}));
  const checks = dirs(path.join(art, 'checks')).flatMap(attempt =>
    dirs(path.join(attempt, 'artifacts/gates')).flatMap(gate => {
      const receipt = json(path.join(gate, 'receipt.json'));
      return receipt ? [{attempt: path.basename(attempt), passed: receipt.passed,
        checks: (receipt.checks || []).map(check => ({command: check.command,
          duration_s: check.duration_s ?? seconds(check.started_at * 1000, check.finished_at * 1000),
          exit_code: check.exit_code}))}] : [];
    }));
  const measured = checks.flatMap(attempt => attempt.checks).map(check => check.duration_s);
  const latencies = [];
  for (const branch of unique(batch.map(item => item.branch))) {
    const selected = batch.filter(item => item.branch === branch);
    if (!state?.landed_at || !selected.some(item => state.accepted?.some(head => head.address === item.task))) continue;
    latencies.push({branch, seconds: seconds(Date.parse(selected[0].pushed_at), Date.parse(state.landed_at))});
  }
  const code = outcome.error?.code === 'E_DEADLINE' ? 'OVER_TIME' :
    result?.reason_code || state?.pending || (result?.needs_recovery ? 'OUTCOME_UNCONFIRMED' :
      /^Owner stopped/.test(result?.reason || '') ? 'OWNER_STOPPED' : outcome.error?.code || 'UNKNOWN');
  const acs = unique(batch.map(item => item.ac));
  return {source: 'lander', run_id: path.basename(folder), task: items[0]?.address || null,
    tasks: items.map(item => item.address), ac: acs[0] || null, acs,
    started_at: Number.isFinite(duration) ? new Date(ended - duration * 1000).toISOString() : null,
    ended_at: new Date(ended).toISOString(), duration_s: duration ?? null,
    status: code, reason_code: code, reason: result?.reason || outcome.error?.message || null,
    claim_released: result?.claim_released ?? null, publication_confirmed: result?.claim_released === true && !result?.needs_recovery,
    batch, batch_size: unique(batch.map(item => item.branch)).length,
    full_checks: checks, full_check_seconds: measured.length && measured.every(Number.isFinite)
      ? Math.round(measured.reduce((sum, value) => sum + value, 0) * 100) / 100 : null,
    delivery: state?.landed ? {head: state.landed, landed_at: state.landed_at} : null,
    push_to_landing: latencies, ...stages(folder, ended)};
}

try {
  const [dolberFile, landerFile, output] = process.argv.slice(2);
  if (!dolberFile || !landerFile || !output || process.argv.length !== 5) {
    throw new Error('Usage: node collect-runs.mjs DOLBER.json LANDER.json OUTPUT (lock OUTPUT to serialize collectors)');
  }
  const dolber = json(dolberFile), integration = json(landerFile);
  const previous = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
  if (previous && !previous.endsWith('\n')) throw new Error('The output has an incomplete final row. Preserve it before repair.');
  const seen = new Set(previous.split('\n').filter(Boolean).map(line => {
    const row = JSON.parse(line); return row.source + ':' + row.run_id;
  }));
  fs.mkdirSync(path.dirname(path.resolve(output)), {recursive: true});
  const file = fs.openSync(output, 'a', 0o600);
  let added = 0, errors = 0;
  try {
    for (const [source, root, collect] of [
      ['dolber', path.join(dolber.stateDir, 'runs'), lane], ['lander', integration.runs_folder, lander],
    ]) {
      for (const folder of dirs(root)) {
        const key = source + ':' + path.basename(folder);
        if (seen.has(key)) continue;
        try {
          const row = collect(folder);
          if (!row) continue;
          fs.writeSync(file, JSON.stringify({schema: 1, ...row}) + '\n');
          seen.add(key); added++;
        } catch (error) { errors++; console.error(key + ': ' + error.message); }
      }
    }
    if (added) fs.fsyncSync(file);
  } finally { fs.closeSync(file); }
  console.log(JSON.stringify({output: path.resolve(output), appended: added, errors}));
  if (errors) process.exitCode = 1;
} catch (error) { console.error('collect-runs: ' + error.message); process.exitCode = 2; }
