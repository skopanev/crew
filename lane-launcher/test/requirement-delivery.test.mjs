import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {requirementBranch, requirementPlan, assertRequirementHead, parsePublication} from '../requirement-delivery.mjs';
import {publicationReader} from '../publication-guard.mjs';
import {dependencyCheck, remoteDependencyBlocker} from '../dependencies.mjs';

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
  assert.equal(parsePublication(`Landed SHA: ${sha}\nTarget: req/example\n`, sha).sha, sha);
  assert.equal(parsePublication(`Landed SHA: ${sha}\nTarget: req/example\n`, null).sha, sha);
  assert.throws(() => parsePublication(`Landed SHA: ${sha}\nTarget: req/example\n`, 'b'.repeat(40)), /Task commit differs/);
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

test('requirement delivery groups mixed inline and structured Task contracts without rewriting them', async () => {
  const f = fixture(), data = f.objects.get('work:two').document.data;
  Object.assign(data, {contract: 'Goal: existing result', repository: 'repo', module: 'core',
    steps: ['Preserve the required result.'], checks: ['Exercise the result => Required output']});
  const before = JSON.stringify(data);
  const plan = await requirementPlan(f.run, f.read);
  assert.equal(plan.final, true);
  assert.equal(plan.publications.length, 1);
  assert.equal(JSON.stringify(data), before);
});

test('compact traversal checks an archived container through its full detail', async () => {
  const f = fixture();
  f.add('group:hidden', 'spec:r').document.data.archived = true;
  f.add('measure:hidden', 'group:hidden').process.planning_claim = {actor: 'other-planner'};
  const read = async (tool, args) => {
    const value = await f.read(tool, args);
    if (tool !== 'joppa_tree') return value;
    const copy = structuredClone(value);
    copy.schema.types.group = {role: 'group', parents: ['spec']};
    copy.schema.types.measure.parents.push('group');
    return copy;
  };
  const plan = await requirementPlan(f.run, read);
  assert.equal(plan.planningHeld, false);
  assert.equal(plan.final, true);
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

test('requirement fingerprint keeps a criterion current after a test-list-only save', async () => {
  const f = fixture(), ac = f.objects.get('measure:a');
  ac.contract_revision = ac.current_revision;
  const before = (await requirementPlan(f.run, f.read)).fingerprint;
  ac.current_revision++;
  ac.document.data.tests = ['checks.test.js > required'];
  assert.equal((await requirementPlan(f.run, f.read)).fingerprint, before);
  ac.contract_revision = ac.current_revision;
  assert.notEqual((await requirementPlan(f.run, f.read)).fingerprint, before);
});

test('finalize-only delivery needs completed work and no current planning holder', async () => {
  const f = fixture();
  f.objects.get('work:one').process.status = 'done';
  const run = {...f.run, tasks: [], finalizeOnly: true};
  assert.equal((await requirementPlan(run, f.read)).final, true);
  f.objects.get('spec:r').process.planning_claim = {actor: 'planner'};
  assert.equal((await requirementPlan(run, f.read)).final, false);
});

test('remote dependency state gates publication and finalization with a distinct workspace identity', async () => {
  const f = fixture();
  const link = {workspace: 'remote', target: 'spec:r', relation: 'depends_on', blocking: true, revision: 1,
    status: {access: true, present: true, review_required: false, satisfied: true, current_revision: 1}};
  f.objects.get('spec:r').remote_links = [link];
  const before = await requirementPlan(f.run, f.read);
  await publicationReader(f.run.config, f.read)(f.run);
  link.status.satisfied = false;
  await assert.rejects(requirementPlan(f.run, f.read), {code: 'CANDIDATE_INVALID'});
  await assert.rejects(publicationReader(f.run.config, f.read)(f.run), error =>
    error.code === 'DEPENDENCY_NOT_LANDED' && error.message.includes('@remote/spec:r'));
  link.status.satisfied = true;
  assert.equal((await requirementPlan(f.run, f.read)).fingerprint, before.fingerprint);
  link.revision = link.status.current_revision = 2;
  assert.notEqual((await requirementPlan(f.run, f.read)).fingerprint, before.fingerprint);
  const ignored = f.add('work:retired', 'measure:a', 'retired');
  ignored.process.retired = {reason: 'Unnecessary'};
  ignored.remote_links = [{...link, status: {...link.status, satisfied: false}}];
  const other = f.add('work:other', 'measure:a', 'in_progress');
  other.document.data.contract = 'Repository: another\nOther work.';
  other.remote_links = [{...link, status: {...link.status, satisfied: false}}];
  const pin = (await requirementPlan(f.run, f.read)).fingerprint;
  ignored.remote_links[0].revision += 1;
  other.remote_links[0].revision += 1;
  assert.equal((await requirementPlan(f.run, f.read)).fingerprint, pin);
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
  Object.assign(f.objects.get('work:two').document.data, {
    contract: 'Goal: delivered dependency', repository: 'repo', module: 'core',
    steps: ['Preserve the delivered mechanism.'], checks: ['Exercise the mechanism => Required output']});
  await publicationReader(config, f.read)(run);
  f.objects.get('work:two').document.data.repository = 'unknown';
  await assert.rejects(publicationReader(config, f.read)(run), {code: 'DEPENDENCY_INVALID'});
  f.objects.get('work:two').document.data.repository = 'repo';
  f.objects.get('work:two').document.data.steps = null;
  await assert.rejects(publicationReader(config, f.read)(run), {code: 'DEPENDENCY_INVALID'});
});

test('top-level remote_links enforce access, presence, pinned revision, and satisfaction while failing closed', async () => {
  const f = fixture();
  f.add('spec:other', null);
  f.add('measure:b', 'spec:other');
  const localArchived = f.add('work:archived', 'measure:a', 'in_progress');
  localArchived.document.data.archived = true;
  const read = async (tool, args) => {
    if (tool === 'joppa_tests') {
      return {items: args.ac.split(',').map(address => ({address, status: address === 'measure:b' ? 'green' : 'red'}))};
    }
    return f.read(tool, args);
  };
  const remoteLink = (overrides = {}, statusOverrides = {}) => ({
    workspace: 'ws-remote',
    target: 'requirement:api',
    relation: 'depends_on',
    revision: 2,
    blocking: true,
    status: {
      access: true,
      present: true,
      current_revision: 2,
      review_required: false,
      satisfied: true,
      ...statusOverrides,
    },
    ...overrides,
  });

  // 1. Same-address local/remote collision: remote work:one (satisfied) does not collide with local in_progress work:one;
  //    remote measure:b (unsatisfied) is not satisfied by local green measure:b; local archived stays skipped.
  f.objects.get('work:one').document.links = [
    {relation: 'depends_on', blocking: true, target: 'work:archived', revision: 1},
    {relation: 'depends_on', blocking: true, target: 'measure:b', revision: 1},
  ];
  f.objects.get('work:one').remote_links = [
    remoteLink({target: 'work:one', revision: 1}, {current_revision: 1, satisfied: true}),
    remoteLink({target: 'requirement:docs', relation: 'related', blocking: false}, {access: false, satisfied: false}),
  ];
  assert.equal(remoteDependencyBlocker(f.objects.get('work:one')), null);
  assert.deepEqual(await dependencyCheck(read)('work:one'), {ready: true, blocker: null});

  const criterion = f.objects.get('measure:b');
  criterion.current_revision = 3;
  criterion.contract_revision = 1;
  assert.deepEqual(await dependencyCheck(read)('work:one'), {ready: true, blocker: null});
  criterion.contract_revision = 2;
  assert.deepEqual(await dependencyCheck(read)('work:one'), {ready: false, blocker: 'measure:b'});
  criterion.current_revision = 1;
  delete criterion.contract_revision;

  f.objects.get('work:one').remote_links = [remoteLink({}, {current_revision: 3, contract_revision: 2})];
  assert.equal(remoteDependencyBlocker(f.objects.get('work:one')), null);
  for (const contract_revision of [0, 3, 4, null, true, '2']) {
    f.objects.get('work:one').remote_links = [remoteLink({}, {current_revision: 3, contract_revision})];
    assert.equal(remoteDependencyBlocker(f.objects.get('work:one')), '@ws-remote/requirement:api');
  }

  f.objects.get('work:one').remote_links = [
    remoteLink({target: 'work:one', revision: 1}, {current_revision: 1, satisfied: true}),
    remoteLink({target: 'measure:b', revision: 1}, {current_revision: 1, satisfied: false}),
  ];
  assert.equal(remoteDependencyBlocker(f.objects.get('work:one')), '@ws-remote/measure:b');
  assert.deepEqual(await dependencyCheck(read)('work:one'), {ready: false, blocker: '@ws-remote/measure:b'});

  // 2. Missing, denied, archived/absent, stale, unpinned, or unsatisfied remote status (including Task with 0 criteria) fails closed
  for (const link of [
    remoteLink({status: undefined}),
    remoteLink({}, {access: false, present: undefined, current_revision: undefined, review_required: undefined, satisfied: false}),
    remoteLink({}, {present: false, current_revision: undefined, review_required: undefined, satisfied: false}),
    remoteLink({revision: 1}, {current_revision: 2, review_required: true}),
    remoteLink({revision: 1}, {current_revision: 2, review_required: false}),
    remoteLink({revision: undefined}),
    remoteLink({revision: 0}),
    remoteLink({}, {satisfied: false}),
  ]) {
    f.objects.get('work:one').remote_links = [link];
    assert.equal(remoteDependencyBlocker(f.objects.get('work:one')), '@ws-remote/requirement:api');
    assert.deepEqual(await dependencyCheck(read)('work:one'), {
      ready: false,
      blocker: '@ws-remote/requirement:api',
    });
  }

  // 3. Ancestor remote_links on parent AC/requirement also block descendant tasks
  f.objects.get('work:one').remote_links = [remoteLink()];
  f.objects.get('measure:a').remote_links = [
    remoteLink({workspace: 'ws-auth', target: 'ac:token'}, {satisfied: false}),
  ];
  assert.deepEqual(await dependencyCheck(read)('work:one'), {
    ready: false,
    blocker: '@ws-auth/ac:token',
  });
  f.objects.get('measure:a').remote_links = [];

  // 4. Optional workspace_key compatibility on tree/object responses and boundary/self-link rejection
  for (const obj of f.objects.values()) obj.workspace_key = 'ws-local';
  const readWithKey = async (tool, args) => {
    const res = await read(tool, args);
    return tool === 'joppa_tree' ? {...res, workspace_key: 'ws-local'} : res;
  };
  assert.deepEqual(await dependencyCheck(readWithKey)('work:one'), {ready: true, blocker: null});
  f.objects.get('work:one').remote_links = [remoteLink({workspace: 'ws-local'})];
  await assert.rejects(dependencyCheck(readWithKey)('work:one'), {code: 'DEPENDENCY_INVALID'});
  f.objects.get('work:one').remote_links = [remoteLink()];
  f.objects.get('measure:a').workspace_key = 'ws-other';
  await assert.rejects(dependencyCheck(readWithKey)('work:one'), {code: 'DEPENDENCY_INVALID'});
  f.objects.get('measure:a').workspace_key = 'ws-local';

  // 5. Malformed remote_links or workspace on document.links rejects with DEPENDENCY_INVALID
  f.objects.get('work:one').remote_links = [remoteLink({workspace: 'bad ws'})];
  await assert.rejects(dependencyCheck(read)('work:one'), {code: 'DEPENDENCY_INVALID'});
  f.objects.get('work:one').remote_links = [remoteLink({target: 'invalid-target'})];
  await assert.rejects(dependencyCheck(read)('work:one'), {code: 'DEPENDENCY_INVALID'});
  f.objects.get('work:one').remote_links = [remoteLink({relation: 'related', blocking: true})];
  await assert.rejects(dependencyCheck(read)('work:one'), {code: 'DEPENDENCY_INVALID'});
  f.objects.get('work:one').remote_links = [];
  f.objects.get('work:one').document.links = [
    {relation: 'depends_on', blocking: true, workspace: 'ws-remote', target: 'work:two', revision: 1},
  ];
  await assert.rejects(dependencyCheck(read)('work:one'), {code: 'DEPENDENCY_INVALID'});
});
