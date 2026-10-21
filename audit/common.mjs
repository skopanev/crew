import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

export const require = (ok, message) => { if (!ok) throw new Error(message); };
export const text = value => typeof value === 'string' && value.trim().length > 0;
export const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function parseReport(body) {
  try { return JSON.parse(body.trim()); } catch {}
  const blocks = [...body.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/g)];
  require(blocks.length === 1, 'Return one final JSON report');
  return JSON.parse(blocks[0][1]);
}
export function write(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(file + '.tmp', file);
}
export function command(binary, args, options = {}) {
  return execFileSync(binary, args, {encoding: 'utf8', timeout: 60_000, ...options});
}
export function successfulCalls(events, harness) {
  if (harness === 'codex') return events.filter(event => event.type === 'item.completed'
    && event.item?.type === 'mcp_tool_call' && event.item.status === 'completed'
    && !event.item.error && !event.item.result?.isError).map(event => ({
      server: event.item.server, tool: event.item.tool, arguments: event.item.arguments}));
  const calls = [], pending = new Map();
  if (harness === 'claude-code') for (const event of events) for (const block of event.message?.content || []) {
    const match = block.type === 'tool_use' && /^mcp__(.+?)__(.+)$/.exec(block.name || '');
    if (event.type === 'assistant' && match) pending.set(block.id, {server: match[1], tool: match[2], arguments: block.input});
    if (event.type === 'user' && block.type === 'tool_result' && !block.is_error && pending.has(block.tool_use_id)) {
      calls.push(pending.get(block.tool_use_id));
    }
  }
  return calls;
}
export function source(repo) {
  const git = (...args) => command('git', ['-C', repo.path, ...args]).trim();
  require(!git('status', '--porcelain', '--untracked-files=no'), `Tracked source is dirty: ${repo.id}`);
  return git('rev-parse', 'HEAD');
}
function trackedFile(item, repositories) {
  const repo = repositories.find(repo => repo.id === item.repository);
  require(repo && text(item.path) && !path.isAbsolute(item.path)
    && !item.path.split(/[\\/]/).includes('..'), 'Invalid code evidence path');
  const root = fs.realpathSync(repo.path), file = fs.realpathSync(path.join(root, item.path));
  require(file.startsWith(root + path.sep), 'Code evidence escapes its repository');
  require(command('git', ['--literal-pathspecs', '-C', root, 'ls-files', '-z', '--error-unmatch', '--', item.path]) === item.path + '\0',
    'Code evidence must identify one tracked file');
  return file;
}
export function codeEvidence(item, repositories) {
  const file = trackedFile(item, repositories);
  require(Number.isSafeInteger(item.line) && item.line > 0 && text(item.quote), 'Code evidence needs a line and quote');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const quote = item.quote.split('\n');
  require(lines.slice(item.line - 1, item.line - 1 + quote.length).join('\n') === item.quote,
    `Code evidence does not match ${item.repository}:${item.path}:${item.line}`);
}
export function validate(report, input) {
  require(report && Array.isArray(report.findings) && Array.isArray(report.inspected)
    && Array.isArray(report.limitations) && report.limitations.every(text), 'Invalid audit report');
  for (const item of report.inspected) {
    const file = trackedFile(item, input.repositories);
    require(fs.statSync(file).size > 0, 'An inspected source file is empty');
  }
  require(input.repositories.every(repo => report.inspected.some(item => item.repository === repo.id)),
    'Audit must inspect every configured repository');
  const ids = new Set();
  for (const finding of report.findings) {
    require(text(finding.id) && !ids.has(finding.id), 'Finding IDs must be unique');
    ids.add(finding.id);
    require(['contradiction', 'uncovered'].includes(finding.kind), 'Only implemented contradictions or uncovered behavior may enter the inbox');
    for (const key of ['title', 'actual', 'impact']) require(text(finding[key]), `Finding needs ${key}`);
    if (input.title_limit !== undefined) require(Number.isSafeInteger(input.title_limit)
      && input.title_limit > 0 && [...finding.title].length <= input.title_limit,
      `Finding title exceeds the configured ${input.title_limit} character limit`);
    require(Array.isArray(finding.code) && finding.code.length, 'Finding needs code evidence');
    finding.code.forEach(item => codeEvidence(item, input.repositories));
    require(Array.isArray(finding.spec), 'Finding needs a specification evidence list');
    if (finding.kind === 'uncovered') {
      require(input.specification_complete === true, 'Partial specification cannot establish uncovered behavior');
      require(finding.spec.length === 0 && Array.isArray(finding.spec_searches) && finding.spec_searches.length
        && finding.spec_searches.every(text) && text(finding.why_uncovered) && text(finding.decision),
        'Uncovered behavior needs specification searches, an explanation and an owner decision');
    } else require(text(finding.required) && finding.spec.length, 'Contradiction needs the requirement and authoritative specification evidence');
    for (const reference of finding.spec) {
      const spec = input.specification.find(item => item.address === reference.address);
      require(spec && spec.revision === reference.revision && text(reference.quote)
        && spec.text.includes(reference.quote),
        `Finding ${finding.id}: quote must exactly match ${reference.address}@${reference.revision} in input.specification[].text`);
    }
  }
  return report;
}
export function confirmed(report, review) {
  require(review && Array.isArray(review.verdicts), 'Independent review is missing');
  const expected = new Set(report.findings.map(item => item.id));
  require(review.verdicts.length === expected.size, 'Review must cover every finding');
  const seen = new Set();
  for (const item of review.verdicts) {
    require(expected.has(item.id) && !seen.has(item.id) && ['confirmed', 'dismissed'].includes(item.verdict)
      && text(item.reason), 'Invalid independent finding verdict');
    seen.add(item.id);
  }
  return report.findings.filter(finding => review.verdicts.find(item => item.id === finding.id).verdict === 'confirmed');
}
export function corrected(report, previous) {
  for (const finding of Array.isArray(previous?.findings) ? previous.findings : []) {
    if (!text(finding?.id) || report.findings.some(item => item.id === finding.id)) continue;
    const prefix = `Withdrawn ${finding.id}: `;
    require(report.limitations.some(item => item.startsWith(prefix) && text(item.slice(prefix.length))),
      `Explain withdrawal of finding ${finding.id} in limitations as 'Withdrawn ${finding.id}: <reason>'`);
  }
}
export function findingKey(finding) {
  return hash({kind: finding.kind,
    code: finding.code.map(({repository, path, quote}) => ({repository, path, quote})).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    spec: finding.spec.map(({address, quote}) => ({address, quote})).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))});
}
