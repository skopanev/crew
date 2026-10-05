import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {candidates, runResult, settings} from './dispatch.mjs';

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

test('a retained lane worktree holds the ticket for an operator', () => {
  const {ready, held} = candidates([ticket('A', '1'), ticket('W', '1')], {tickets: {}}, '/src',
    file => file === path.join('/src', '.worktrees', 'W'));
  assert.deepEqual(ready.map(t => t.id), ['A']);
  assert.deepEqual(held.map(t => t.id), ['W']);
});

test('settings select blocked tickets without the dispatch tag and validate it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'config.json');
  const base = {id: 'x', workspace: 'w', stateDir: dir, sourceRoot: dir, tags: ['agent-ready', 'ifa-ama']};
  fs.writeFileSync(file, JSON.stringify({...base, planning: {dispatchTag: 'agent-ready'}}));
  const config = settings(file);
  assert.deepEqual(config.filterTags, ['ifa-ama']);
  assert.equal(config.interval, 60);
  fs.writeFileSync(file, JSON.stringify(base));
  assert.throws(() => settings(file), /dispatchTag must be one of the dispatcher tags/);
});

test('the newest run started by this tick decides between a verdict and an environment failure', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-runs-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const config = {stateDir: dir};
  assert.equal(runResult(config, Date.now()), null);
  const since = Date.now();
  fs.mkdirSync(path.join(dir, 'runs/r1/artifacts'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'runs/r1/artifacts/result.json'), JSON.stringify({verdict: 'NOT_READY', id: 'A'}));
  assert.equal(runResult(config, since).ticket_unchanged, undefined);
  fs.writeFileSync(path.join(dir, 'runs/r1/artifacts/result.json'), JSON.stringify({verdict: 'NOT_READY', ticket_unchanged: true}));
  assert.equal(runResult(config, since).ticket_unchanged, true);
  assert.equal(runResult(config, Date.now() + 60000), null);
});
