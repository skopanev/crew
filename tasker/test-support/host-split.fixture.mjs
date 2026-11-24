import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {hostSplitReceipt} from '../host-split-replan.mjs';

const settings = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url))).vars;

export function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-host-split-')));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const env = {...process.env, ...Object.fromEntries(Object.entries(settings).map(([key, value]) =>
    [key, typeof value === 'string' ? value : JSON.stringify(value)])), DRY_RUN: 'false', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'};
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], {env, encoding: 'utf8'}).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'file.ts'), 'export const existing = true;\n');
  git('add', '.'); git('commit', '-q', '-m', 'Base');
  const sha = git('rev-parse', 'HEAD'), id = 'aabbccdd-1111-2222-3333-123456789abc';
  const stateDir = path.join(root, 'dispatcher'), outer = path.join(stateDir, 'crew-dispatchers', 'fixture', 'runs', id);
  const laneRoot = path.join(outer, 'lane'), lane = path.join(laneRoot, '2026-11-23_12-00-00-1234abcd');
  const artifacts = path.join(lane, 'artifacts'); fs.mkdirSync(artifacts, {recursive: true});
  const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  const hash = value => createHash('sha256').update(value).digest('hex');
  const node = (address, data) => ({address, kind: address.split(':')[0], current_revision: 11,
    document: {data, present: true}});
  const parent = node('ac:a', {title: 'Criterion', body: 'Required behavior'});
  const selected = node('task:t', {title: 'Existing Task', repository: 'repo', stage: 'to_review',
    body: 'Criterion: ac:a@11. Required behavior\nRepository: repo\nFiles: file.ts\nTests: none\nDo:\n1. Implement work.\nChecks: unit tests.'});
  const input = {workspace: 'fixture', selected, claim_revision: 12,
    schema: {types: {task: {role: 'task', fields: {repository: {type: 'enum', values: ['repo']}}}, ac: {role: 'ac'}, test: {role: 'test'}}},
    context: {parent, children: [], references: {}, incoming: []}};
  const ticket = {address: 'task:t', parent: 'ac:a', title: selected.document.data.title, body: selected.document.data.body,
    repository: 'repo', revision: 10, parentContext: {address: 'ac:a', data: parent.document.data}};
  const claim = {claimed: true, runId: id, revision: 10, digest: hash('contract'), ticket,
    tasks: [{address: 'task:t', revision: 10, digest: hash('contract'), ticket}]};
  const reason = 'разбить: 485 lines, 7 files. Split the required work.';
  const note = {id: 'host-note', actor: 'worker', withdrawn: false,
    text: `CREW_FAILURE\nTask: task:t\nRun: ${id}\nReason: SPLIT\nPlanning stopped before implementation.\n${reason}\n`};
  selected.annotations = {comments: {'host-note': note}};
  const run = {task: 'task:t', workspace: 'fixture', createdAt: '2026-11-23T12:00:00Z', runFolder: laneRoot,
    repository: {id: 'repo', path: repo}, claim, joppaWorker: {actor: 'worker'},
    result: {status: 'failed', code: 2, blockConfirmed: true, finishedAt: '2026-11-23T12:10:00Z',
      tasks: [{address: 'task:t', status: 'blocked', revision: 11}]},
    blockRequest: {workspace: 'fixture', operations: [{command: {op: 'save_object', kind: 'task', id: 't', revision: 10,
      data: {assignee: null, stage: 'to_review'}, reason: 'Crew lane failed: SPLIT.'}},
    {command: {op: 'note', target: 'task:t', id: 'host-note', text: note.text}}]}, workflow: {digest: hash('workflow')}};
  const state = {source: {head: sha, digest: hash('source')}, digest: hash('plan'), maxFiles: 8, maxLines: 300,
    plan: {verdict: 'SPLIT', files: 7, lines: 485}, reason, approved: false};
  const journal = [{node: 'plan_task', kind: 'decision', signal: 'SPLIT', next: 'plan_stop', step: 7, message: 'Plan is too large'},
    {node: 'plan_stop', kind: 'decision', signal: '__default__', next: '__exit_fail__', step: 8}];
  const configFile = path.join(root, 'dolber.json');
  write(configFile, {id: 'fixture', workspace: 'fixture', stateDir});
  write(path.join(outer, 'launch.json'), run); write(path.join(laneRoot, 'launch-claim.json'), claim);
  for (const [name, value] of Object.entries({'claim.json': claim, 'ticket.json': ticket, 'plan-state.json': state,
    'plan-outcome.json': {status: 'blocked', splitFile: 'split.md', reason},
    'origin.json': {node: 'plan_task', signal: 'SPLIT', message: reason}})) write(path.join(artifacts, name), value);
  write(path.join(lane, 'journal.jsonl'), journal.map(row => JSON.stringify(row)).join('\n') + '\n');
  write(path.join(lane, 'outcome.json'), {outcome: 'failed', exit_code: 2, error: {node: 'plan_stop'}});
  write(path.join(lane, 'workflow.yaml'), 'workflow'); write(path.join(artifacts, 'plan.md'), 'plan');
  const trees = {repo: {repo, path: repo, sha}}, repair = {ac_text_changed: false};
  const draft = {verdict: 'STALE', reason: 'The host requires bounded replanning', needs_code: true};
  const capture = () => hostSplitReceipt({input, repair, trees, configFile});
  const priorConfig = process.env.DOLBER_CONFIG; process.env.DOLBER_CONFIG = configFile;
  repair.split_replan = capture();
  const options = () => {
    const digest = hash(JSON.stringify(draft));
    const keys = ['gate', 'size', 'reporter_names', 'outside_files', 'already_in_develop', 'ac_test_consistency', 'ac_scope'];
    const review = {draft_digest: digest, verdict: 'APPROVE', findings: [],
      checks: Object.fromEntries(keys.map(key => [key, {ok: true, evidence: 'Verified receipt and replan'}]))};
    return {input, repair, draft, trees, digest, reviews: [structuredClone(review), structuredClone(review)], run: 'tasker-fixture'};
  };
  const change = (relative, update) => { const file = path.join(outer, relative); const value = JSON.parse(fs.readFileSync(file)); update(value); write(file, value); };
  return {root, repo, git, env, id, outer, lane, artifacts, configFile, input, repair, draft, trees, capture, options, write, change,
    cleanup() { if (priorConfig === undefined) delete process.env.DOLBER_CONFIG; else process.env.DOLBER_CONFIG = priorConfig;
      fs.rmSync(root, {recursive: true, force: true}); }};
}
