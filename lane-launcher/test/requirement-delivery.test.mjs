import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {requirementBranch, requirementPlan, assertRequirementHead, parsePublication} from '../requirement-delivery.mjs';
import {publicationReader} from '../publication-guard.mjs';

function fixture() {
  const branch = requirementBranch('spec:r', 'repo');
  const types = {spec: {role: 'requirement', parents: []},
    measure: {role: 'ac', parents: ['spec']}, work: {role: 'task', parents: ['measure']}};
  const objects = new Map();
  function add(address, parent, status) {
    const value = {address, kind: address.split(':')[0], historical: false, current_revision: 1,
      document: {present: true, parent, links: [], data: {title: address,
        ...(status ? {purpose: 'implementation', contract: 'Repository: repo\nImplement the selected behavior.'} : {})}},
      process: status ? {status, revision: 1} : {}};
    objects.set(address, value);
    return value;
  }
  add('spec:r', null);
  add('measure:a', 'spec:r');
  add('work:one', 'measure:a', 'in_progress');
  const sibling = add('work:two', 'measure:a', 'done');
  sibling.process.done = `Landed SHA: ${'a'.repeat(40)}\nTarget: ${branch}\n`;
  const read = async (tool, args) => {
    if (tool === 'joppa_tree') return {schema: {types}};
    if (tool === 'joppa_objects' && args.address) return structuredClone(objects.get(args.address));
    if (tool === 'joppa_objects') return {items: [...objects.values()].filter(x => x.document.parent === args.parent)
      .map(x => ({address: x.address, kind: x.kind, present: x.document.present})), next_cursor: null};
    if (tool === 'joppa_tasks') return {tasks: [...objects.values()].filter(x => x.kind === 'work')
      .map(x => ({address: x.address, revision: x.current_revision, status: x.process.status})), next_cursor: null};
    throw new Error(`Unexpected read ${tool}`);
  };
  const run = {requirement: 'spec:r', repository: 'repo', tasks: [{address: 'work:one', revision: 1}],
    config: {repositories: [{id: 'repo'}]}};
  return {objects, add, read, run, branch};
}

test('requirement publication evidence needs one exact SHA and target', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(parsePublication(`Landed SHA: ${sha}\nTarget: req/example\n`),
    {sha, target: 'req/example', kind: 'landed', verified: false});
  for (const evidence of ['Landed SHA: abc\nTarget: develop',
    `Landed SHA: ${sha}\nVerified existing SHA: ${sha}\nTarget: develop`,
    `Landed SHA: ${sha}\nTarget: develop\nTarget: other`,
    `Landed SHA: ${sha}\nTarget: refs/heads/main`]) assert.throws(() => parsePublication(evidence));
  assert.equal(requirementBranch('spec:r', 'repo'), requirementBranch('spec:r', {id: 'repo'}));
  assert.notEqual(requirementBranch('spec:r', 'repo'), requirementBranch('spec:other', 'repo'));
});

test('final requirement delivery waits for unfinished work and planning claims', async () => {
  const f = fixture();
  assert.equal((await requirementPlan(f.run, f.read)).final, true);
  const evidence = f.objects.get('work:two').process.done;
  f.objects.get('work:two').process.status = 'blocked';
  delete f.objects.get('work:two').process.done;
  assert.equal((await requirementPlan(f.run, f.read)).final, false);
  f.objects.get('work:two').process.status = 'done';
  f.objects.get('work:two').process.done = evidence;
  f.objects.get('measure:a').process.planning_claim = {actor: 'planner', position: 7};
  const held = await requirementPlan(f.run, f.read);
  assert.equal(held.final, false);
  assert.equal(held.planningHeld, true);
});

test('only current DONE publication evidence confirms a requirement head', async () => {
  const f = fixture(), head = 'a'.repeat(40);
  let plan = await requirementPlan(f.run, f.read);
  assert.doesNotThrow(() => assertRequirementHead(plan, head));
  f.objects.get('work:two').review_required = true;
  plan = await requirementPlan(f.run, f.read);
  assert.equal(plan.final, false);
  assert.throws(() => assertRequirementHead(plan, head), {code: 'REQUIREMENT_HEAD_UNCONFIRMED'});
  f.objects.get('work:two').review_required = false;
  f.objects.get('work:two').process.done = 'Work complete without an exact publication receipt';
  plan = await requirementPlan(f.run, f.read);
  assert.throws(() => assertRequirementHead(plan, head), {code: 'REQUIREMENT_HEAD_UNCONFIRMED'});
});

test('requirement fingerprint changes with current contracts and blocks retired own work', async () => {
  const f = fixture();
  const before = await requirementPlan(f.run, f.read);
  f.objects.get('measure:a').current_revision++;
  assert.notEqual((await requirementPlan(f.run, f.read)).fingerprint, before.fingerprint);
  f.objects.get('work:one').process.status = 'retired';
  await assert.rejects(requirementPlan(f.run, f.read), /already retired/);
});

test('finalize-only delivery needs completed work and no current planning holder', async () => {
  const f = fixture();
  f.objects.get('work:one').process.status = 'done';
  const run = {...f.run, tasks: [], finalizeOnly: true};
  assert.equal((await requirementPlan(run, f.read)).final, true);
  f.objects.get('spec:r').process.planning_claim = {actor: 'planner'};
  assert.equal((await requirementPlan(run, f.read)).final, false);
});

test('cross-requirement dependencies wait for the real target branch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-publication-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo'), remote = path.join(root, 'origin.git');
  fs.mkdirSync(repo);
  const env = {...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1'};
  const git = args => execFileSync('git', ['-C', repo, ...args], {env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git(['init', '-q', '-b', 'develop']);
  git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@local']);
  git(['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(repo, 'source'), 'base');
  git(['add', '.']); git(['commit', '-qm', 'base']); git(['push', '-q', 'origin', 'HEAD:develop']);
  fs.writeFileSync(path.join(repo, 'source'), 'dependency');
  git(['add', '.']); git(['commit', '-qm', 'dependency']);
  const sha = git(['rev-parse', 'HEAD']);
  const f = fixture();
  git(['push', '-q', 'origin', `HEAD:${f.branch}`]);
  f.objects.get('work:two').process.done = `Landed SHA: ${sha}\nTarget: ${f.branch}\n`;
  f.objects.get('work:one').document.links = [{relation: 'depends_on', blocking: true, target: 'work:two'}];
  const config = {delivery: 'requirement', repositories: [{id: 'repo', path: repo, targetBranch: 'develop'}]};
  const run = {...f.run, repository: config.repositories[0], config, requirementDelivery: {branch: f.branch}};
  await publicationReader(config, f.read)(run);
  f.add('spec:other', null); f.add('measure:b', 'spec:other');
  f.objects.get('work:two').document.parent = 'measure:b';
  await assert.rejects(publicationReader(config, f.read)(run), {code: 'DEPENDENCY_NOT_LANDED'});
  git(['push', '-q', 'origin', 'HEAD:develop']);
  await publicationReader(config, f.read)(run);
});
