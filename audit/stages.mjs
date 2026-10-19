import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {command, confirmed, hash, read, require, source, text, validate, write} from './common.mjs';

const artifacts = path.join(process.env.MEDULLA_RUN_DIR || '.', 'artifacts');
const config = () => read(process.env.AUDIT_CONFIG);
const adapter = async () => import(pathToFileURL(process.env.AUDIT_ADAPTER));
const signal = (name, value) => console.log(`<signal:${name}>${String(value).replace(/[<>\r\n]/g, ' ')}</signal:${name}>`);
const variable = (key, value) => {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  require(!body.includes('</signal:var>'), 'Reserved signal delimiter in input');
  console.log(`<signal:var key=${key}>${body}</signal:var>`);
};
function contract(settings) {
  const name = 'crew-audit-auditor';
  const reply = JSON.parse(command(process.env.EQUILL_BIN || 'equill', ['context', '--store', settings.equill_store,
    '--profile', 'agent.context.target', '--role', name, '--process', name,
    '--project', settings.project, '--coordinate', 'rules=none', '--json'],
    {env: {...process.env, EQUILL_ACTOR: settings.equill_actor}}));
  require(reply.ok && reply.receipt?.projection === 'ready' && !reply.receipt?.degraded && !reply.receipt?.empty
    && text(reply.content) && text(reply.bundle_digest) && reply.selected_record_ids?.length,
    'Audit Equill contract is unavailable');
  const records = reply.content.split('\n\n').filter(text).map(value => JSON.parse(value));
  require(records.some(item => item.name === name) && [10, 20, 30].every(step =>
    records.some(item => item.process === name && item.step === step)), 'Audit Equill steps are incomplete');
  return {content: reply.content, digest: reply.bundle_digest};
}
function result() {
  require(process.env.MEDULLA_BODY_RC === '0', 'Audit agent did not finish');
  const events = fs.readFileSync(process.env.MEDULLA_ATTEMPT_LOG, 'utf8').split('\n').flatMap(line => {
    try { return [JSON.parse(line.replace(/^\[out\] /, ''))]; } catch { return []; }
  });
  let body;
  if (process.env.MEDULLA_HARNESS === 'codex') {
    body = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item.text;
  } else if (process.env.MEDULLA_HARNESS === 'claude-code') {
    const last = events.filter(event => event.type === 'result').at(-1);
    require(last && !last.is_error, 'Review did not return a successful final result');
    body = last.result;
  }
  require(text(body), 'Agent must return final JSON');
  return JSON.parse(body.replace(/^```json\s*\n/, '').replace(/\n```\s*$/, '').trim());
}
async function prepare() {
  const settings = config();
  const input = await (await adapter()).prepare(settings);
  input.repositories = settings.repositories.map(repo => ({...repo, head: source(repo)}));
  const rules = contract(settings);
  write(path.join(artifacts, 'input.json'), input);
  write(path.join(artifacts, 'contract.json'), rules);
  write(path.join(artifacts, 'config-digest.json'), hash(settings));
  write(path.join(artifacts, 'config.json'), settings);
  variable('AUDIT_CONFIG', path.join(artifacts, 'config.json'));
  variable('AUDIT_INPUT', path.join(artifacts, 'input.json'));
  variable('AUDIT_CONTRACT', rules.content);
  variable('AUDIT_MCP_TOML', settings.reader_toml);
  variable('AUDIT_MCP_CONFIG', settings.reader_config);
  variable('AUDIT_READ_TOOLS', settings.reader_tools);
  signal('PREPARED', 'Current source, specification and audit rules loaded');
}
async function capture(kind) {
  const report = result();
  if (kind === 'audit') {
    validate(report, read(path.join(artifacts, 'input.json')));
    write(path.join(artifacts, 'findings.json'), report);
    variable('AUDIT_FINDINGS', path.join(artifacts, 'findings.json'));
    signal(report.findings.length ? 'FINDINGS' : 'NO_FINDINGS', `${report.findings.length} proposed finding(s)`);
  } else {
    confirmed(read(path.join(artifacts, 'findings.json')), report);
    write(path.join(artifacts, 'review.json'), report);
    signal('REVIEWED', 'Every proposed finding has an independent verdict');
  }
}
async function finish() {
  const settings = config();
  require(hash(settings) === read(path.join(artifacts, 'config-digest.json')), 'Audit configuration changed');
  const input = read(path.join(artifacts, 'input.json'));
  require(input.repositories.every(repo => source(repo) === repo.head), 'Source changed during audit; rerun it');
  require(contract(settings).digest === read(path.join(artifacts, 'contract.json')).digest, 'Audit rules changed; rerun it');
  const report = validate(read(path.join(artifacts, 'findings.json')), input);
  const findings = report.findings.length ? confirmed(report, read(path.join(artifacts, 'review.json'))) : [];
  const service = await adapter();
  await service.recheck(settings, input, findings);
  const publication = process.env.AUDIT_NO_PUBLISH === 'true' ? {published: [], preview: findings}
    : await service.publish(settings, findings, input, artifacts);
  write(path.join(artifacts, 'result.json'), {status: 'audited', acceptance_verified: false,
    inspected: report.inspected, limitations: report.limitations, confirmed: findings.length, ...publication});
  signal('AUDITED', `${findings.length} confirmed finding(s); acceptance was not assessed`);
}
try {
  const stage = process.argv[2];
  if (stage === 'prepare') await prepare();
  else if (stage === 'capture') await capture(process.argv[3]);
  else if (stage === 'finish') await finish();
  else throw new Error('Unknown audit stage');
} catch (error) {
  console.error(`audit: ${error.message}`);
  process.exitCode = 2;
}
