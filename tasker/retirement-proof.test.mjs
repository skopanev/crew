import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {retirementRequired, retirementBinding, retirementProblems} from './retirement-proof.mjs';

const complete = 'export const Body = {}; export function strict() {}\n';
function fixture(t, source = complete) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-retirement-'));
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const env = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'};
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {env, encoding: 'utf8'}).trim();
  git('init', '-q');
  const commit = text => {
    fs.writeFileSync(path.join(repo, 'entry.ts'), text); git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'Fixture');
    return git('rev-parse', 'HEAD');
  };
  const sha = commit(source), trees = {repo: {path: repo, repo, sha}};
  const input = {selected: {address: 'task:old', kind: 'task', current_revision: 9,
    document: {data: {repository: 'repo', body: 'Repository: repo\nDo:\n1. Export Body and strict for the dependent Task.\nChecks: existing checks'}}},
    schema: {types: {task: {role: 'task', fields: {repository: {type: 'enum', values: ['repo']}}}}}};
  const draft = {verdict: 'STALE', needs_code: false, done_commit: sha,
    retirement_proof: {...retirementBinding(input, trees), files: [{path: 'entry.ts', exports: ['Body', 'strict']}]} };
  const args = {input, repair: {ac_text_changed: false}, draft, trees};
  return {repo, input, draft, trees, args, commit, git, check: change => retirementProblems({...args, ...change})};
}

test('both unchanged Task retirement variants and every false completion need proof', () => {
  for (const needs_code of [true, false]) assert.equal(retirementRequired({ac_text_changed: false}, {verdict: 'STALE', needs_code}), true);
  assert.equal(retirementRequired({ac_text_changed: true}, {verdict: 'STALE', needs_code: false}), true);
  assert.equal(retirementRequired({ac_text_changed: true}, {verdict: 'STALE', needs_code: true}), false);
  assert.equal(retirementRequired({}, {verdict: 'READY'}), false);
  assert.deepEqual(retirementProblems({repair: {ac_text_changed: true}, draft: {verdict: 'STALE', needs_code: true}}), []);
});

test('binding copies the original revision and every Do line without editing the assignment', t => {
  const f = fixture(t), before = structuredClone(f.input);
  f.input.claim_revision = 10;
  const binding = retirementBinding(f.input, f.trees);
  assert.equal(binding.revision, 9);
  assert.deepEqual(binding.obligations, ['1. Export Body and strict for the dependent Task.']);
  delete f.input.claim_revision;
  assert.deepEqual(f.input, before);
  assert.deepEqual(f.check(), []);
});

test('sample0001: an existing registrar and ancestor do not prove private Body and strict exports', t => {
  const f = fixture(t, 'const Body = {}; async function strict() {}\nexport function registerTravelRulePartyEntryRoute() {}\n');
  for (const needs_code of [true, false]) {
    const problems = f.check({draft: {...f.draft, needs_code}});
    assert.match(problems.join('\n'), /missing runtime exports Body, strict/);
  }
});

test('missing proof, each wrong binding, empty inventory and missing obligations refuse retirement', t => {
  const f = fixture(t);
  assert.match(f.check({draft: {...f.draft, retirement_proof: undefined}}).join(), /retirement_proof is required/);
  for (const [key, value] of [['task', 'task:another'], ['revision', 10], ['repository', 'another'], ['develop', 'a'.repeat(40)]]) {
    assert.match(f.check({draft: {...f.draft, retirement_proof: {...f.draft.retirement_proof, [key]: value}}}).join(), new RegExp(key));
  }
  for (const change of [{files: []}, {obligations: []}]) assert.ok(f.check({draft: {...f.draft,
    retirement_proof: {...f.draft.retirement_proof, ...change}}}).length);
  f.input.selected.document.data.body = 'No structured Do obligations';
  assert.ok(f.check().length);
});

test('unsafe, absent, duplicate and symlink paths cannot supply deliverables', t => {
  const f = fixture(t);
  for (const name of ['../entry.ts', '/entry.ts', 'a/../entry.ts', 'a\\entry.ts', 'absent.ts']) {
    assert.ok(f.check({draft: {...f.draft, retirement_proof: {...f.draft.retirement_proof,
      files: [{path: name, exports: []}]}}}).length, name);
  }
  fs.symlinkSync('entry.ts', path.join(f.repo, 'link.ts'));
  const sha = f.commit(complete + '// keep\n'); f.trees.repo.sha = sha;
  f.draft.retirement_proof = {...retirementBinding(f.input, f.trees), files: [{path: 'link.ts', exports: []}]};
  f.draft.done_commit = sha;
  assert.match(f.check().join(), /not a tracked regular file/);
  f.draft.retirement_proof.files = [{path: 'entry.ts', exports: []}, {path: 'entry.ts', exports: []}];
  assert.match(f.check().join(), /unique/);
});

test('proof checks both the ancestor and develop blobs, and ignores working-tree substitutions', t => {
  const f = fixture(t, 'export function strict() {}\n');
  const done = f.draft.done_commit, head = f.commit(complete);
  f.trees.repo.sha = head;
  f.draft.retirement_proof = {...retirementBinding(f.input, f.trees), files: [{path: 'entry.ts', exports: ['Body', 'strict']}]};
  assert.match(f.check().join(), new RegExp(done + ': missing runtime exports Body'));
  f.draft.done_commit = head;
  assert.deepEqual(f.check(), []);
  const later = f.commit('export function strict() {}\n'); f.trees.repo.sha = later;
  f.draft.retirement_proof.develop = later;
  fs.writeFileSync(path.join(f.repo, 'entry.ts'), complete);
  assert.match(f.check().join(), new RegExp(later + ': missing runtime exports Body'));
});

test('a commit outside selected develop ancestry and an unavailable repository refuse proof', t => {
  const f = fixture(t), ahead = f.commit(complete + '// later\n');
  assert.match(f.check({draft: {...f.draft, done_commit: ahead}}).join(), /not an ancestor/);
  assert.match(f.check({draft: {...f.draft, done_commit: 'a'.repeat(40)}}).join(), /absent/);
  f.input.selected.document.data.repository = 'conflicting';
  assert.match(f.check().join(), /repository binding/);
});

test('reviewed publication requires both exact digest-bound completeness attestations', t => {
  const f = fixture(t), digest = 'a'.repeat(64);
  const review = {draft_digest: digest, verdict: 'APPROVE', checks: {already_in_develop: {ok: true, task_deliverables_complete: true}}};
  assert.deepEqual(f.check({digest, reviews: [review, structuredClone(review)]}), []);
  for (const changed of [{draft_digest: 'b'.repeat(64)},
    {checks: {already_in_develop: {ok: true}}}, {checks: {already_in_develop: {ok: false, task_deliverables_complete: true}}}]) {
    assert.ok(f.check({digest, reviews: [review, {...review, ...changed}]}).length);
  }
  // crew m_49e4475b: publication.jq already approved a REWORK with advice only, so the proof needs no APPROVE verdict.
  assert.deepEqual(f.check({digest, reviews: [review, {...review, verdict: 'REWORK', findings: [{problem: 'p', advice: 'a'}]}]}), []);
  assert.ok(f.check({digest, reviews: []}).length);
});

test('unresolved reexports, imported aliases and type-only evidence fail closed', t => {
  const examples = [
    'export {Missing as Body} from "./absent.ts"; export function strict() {}',
    'export * from "./absent.ts";',
    'import {Missing as Body} from "./absent.ts"; export /*comment*/ {Body}; export function strict() {}',
    'export type Body = {}; export function strict() {}',
    'export interface Body {} export function strict() {}',
    'const Body={}; export {Body}; export function strict() {}',
  ];
  for (const source of examples) {
    const f = fixture(t, source);
    assert.match(f.check().join(), /unsupported export/);
  }
});

test('comments, strings, malformed source and an unavailable Bun cannot prove exports', t => {
  for (const source of ['// export const Body={}\nconst text="strict";', 'export const Body = (']) {
    const f = fixture(t, source); assert.ok(f.check().length);
  }
  const f = fixture(t), before = process.env.TASKER_BUN;
  process.env.TASKER_BUN = path.join(f.repo, 'missing-bun');
  try { assert.ok(f.check().length); }
  finally {
    if (before === undefined) delete process.env.TASKER_BUN;
    else process.env.TASKER_BUN = before;
  }
});
