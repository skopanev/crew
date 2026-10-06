import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {candidates, incomplete, lock, replanForDrift, runResult, settings} from './dispatch.mjs';

const ticket = (id, updated, status = updated) => ({id, updated_at: updated, current_status_at: status, title: id});

test('the longest-blocked changed ticket goes first; unchanged ones are skipped', () => {
  const state = {tickets: {B: {stamp: '2'}}};
  const {ready, held} = candidates([ticket('A', '3', '3'), ticket('B', '2'), ticket('C', '5', '1')], state, '/src', () => false);
  assert.deepEqual(ready.map(t => t.id), ['C', 'A']);
  assert.deepEqual(held, []);
});

test('a ticket changed after the last attempt is planned again', () => {
  const {ready} = candidates([ticket('B', '3')], {tickets: {B: {stamp: '2'}}}, '/src', () => false);
  assert.deepEqual(ready.map(t => t.id), ['B']);
});

test('a retained lane worktree remains eligible for blocked-ticket planning', () => {
  const {ready, held} = candidates([ticket('A', '1'), ticket('W', '1')], {tickets: {}}, '/src',
    file => file === path.join('/src', '.worktrees', 'W'));
  assert.deepEqual(ready.map(t => t.id), ['A', 'W']);
  assert.deepEqual(held, []);
});

test('settings select blocked tickets by every configured tag and reject an empty filter', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'config.json');
  const base = {id: 'x', workspace: 'w', stateDir: dir, sourceRoot: dir, tags: ['agent-ready', 'team-a']};
  fs.writeFileSync(file, JSON.stringify({...base, planning: {dispatchTag: 'agent-ready'}}));
  const config = settings(file);
  assert.deepEqual(config.filterTags, ['agent-ready', 'team-a']);
  assert.equal(config.interval, 60);
  fs.writeFileSync(file, JSON.stringify(base));
  assert.throws(() => settings(file), /dispatchTag must be one of the dispatcher tags/);
  fs.writeFileSync(file, JSON.stringify({...base, tags: ['crew']}));
  assert.deepEqual(settings(file).filterTags, ['crew']);
  fs.writeFileSync(file, JSON.stringify({...base, tags: ['crew', ' '], planning: {dispatchTag: 'crew'}}));
  assert.throws(() => settings(file), /non-empty tags/);
});

test('the named run decides between a verdict and an incomplete run', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-runs-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const config = {stateDir: dir};
  const save = (name, value) => {
    fs.mkdirSync(path.join(dir, 'runs', name, 'artifacts'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'runs', name, 'artifacts/result.json'), JSON.stringify(value));
  };
  assert.equal(runResult(config, 'mine'), null);
  assert.equal(incomplete(runResult(config, 'mine')), true);
  save('other', {verdict: 'NOT_READY', id: 'A'});
  assert.equal(runResult(config, 'mine'), null, 'another run is never read');
  save('mine', {verdict: 'NOT_READY', id: 'A'});
  assert.equal(incomplete(runResult(config, 'mine')), false);
  save('mine', {verdict: 'NOT_READY', ticket_unchanged: true});
  assert.equal(incomplete(runResult(config, 'mine')), true);
  save('mine', {verdict: 'NOT_READY', ticket_unchanged: false, publication_uncertain: true});
  assert.equal(incomplete(runResult(config, 'mine')), true);
});

test('the dispatcher lock fails closed on any existing lock file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-lock-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = lock(dir);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  assert.throws(() => lock(dir, 1), /Another dispatcher holds .*pid \d+.*remove the file/);
  fs.writeFileSync(file, '999999999');
  assert.throws(() => lock(dir, 4242), /pid 999999999/, 'a dead owner is not removed automatically');
  fs.writeFileSync(file, '');
  assert.throws(() => lock(dir, 4242), /Another dispatcher holds/, 'an empty lock is a live one being written');
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

test('code drift re-plans once, only for the exact unpublished drift result', () => {
  const drift = {verdict: 'NOT_READY', published: false, ticket_unchanged: true, code_drift: true};
  assert.equal(replanForDrift(drift, 0), true);
  assert.equal(replanForDrift(drift, 1), false, 'a second drift stops');
  assert.equal(replanForDrift({...drift, code_drift: undefined}, 0), false, 'other failures do not retry');
  assert.equal(replanForDrift({...drift, ticket_unchanged: false, publication_uncertain: true}, 0), false);
  assert.equal(replanForDrift({...drift, publication_uncertain: true}, 0), false, 'contradictory flags stop');
  assert.equal(replanForDrift({...drift, published: true}, 0), false, 'a published result never retries');
  assert.equal(replanForDrift(null, 0), false);
});
