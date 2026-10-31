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
import './requirement-dependencies.cases.mjs';

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
  Object.assign(data, {body: 'Goal: existing result', repository: 'repo', module: 'core',
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
  other.document.data.body = 'Repository: another\nOther work.';
  other.remote_links = [{...link, status: {...link.status, satisfied: false}}];
  const pin = (await requirementPlan(f.run, f.read)).fingerprint;
  ignored.remote_links[0].revision += 1;
  other.remote_links[0].revision += 1;
  assert.equal((await requirementPlan(f.run, f.read)).fingerprint, pin);
});
