import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {requirementBranch, requirementPlan, assertRequirementHead, parsePublication} from '../requirement-delivery.mjs';
import {publicationReader} from '../publication-guard.mjs';
import {dependencyCheck, remoteDependencyBlocker} from '../dependencies.mjs';

import {fixture} from './requirement-delivery.fixture.mjs';

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
    body: 'Goal: delivered dependency', repository: 'repo', module: 'core',
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
