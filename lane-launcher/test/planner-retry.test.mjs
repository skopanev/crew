// The planner queue reads Crew's own failure marks from existing receipts and selects only a due retry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {retryDue, retryMarks} from '../../planning-joppa/retry-receipts.mjs';

const config = {workspace: 'example', url: 'https://example.invalid/mcp'};
const AC = 'criterion:a';

function run(root, name, receipts) {
  const artifacts = path.join(root, name, 'artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  for (const [file, body] of Object.entries(receipts)) fs.writeFileSync(path.join(artifacts, file), JSON.stringify(body));
}

const claim = (status = 'confirmed') => ({status, server: config.url, arguments: {workspace: 'example',
  operations: [{command: {op: 'save_object', kind: 'criterion', id: 'a', revision: 3}}]}});
const mark = (extra = {}) => ({position: 941, code: 'PLANNING_FAILED', revision: 5, marked_at: '2026-11-05T10:00:00+00:00',
  retry_after: '2026-11-05T10:01:00+00:00', retry_exhausted: false, retry_class: 'AGENT_INCOMPLETE', ...extra});
const row = (position = 941, revision = 5, reason = 'PLANNING_FAILED') =>
  ({address: AC, revision, 'process.assessment': {state: 'waiting', reason, position}});
const at = text => Date.parse(text);

test('the last run that claimed the AC supplies its mark, and an old receipt supplies none', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-retry-'));
  run(root, '2026-11-05_10-00-01-a', {'claim.json': claim(), 'release.json': {status: 'confirmed', marks: {[AC]: mark()}}});
  assert.equal(retryMarks(root, config).get(AC).position, 941);
  // A rejected retry claim applied nothing and keeps the earlier mark.
  run(root, '2026-11-05_10-00-02-b', {'claim.json': claim('rejected')});
  assert.equal(retryMarks(root, config).get(AC).position, 941);
  // An old release receipt without marks replaces the mark with none.
  run(root, '2026-11-05_10-00-03-c', {'claim.json': claim(), 'release.json': {status: 'confirmed', released: [AC]}});
  assert.equal(retryMarks(root, config).has(AC), false);
  run(root, '2026-11-05_10-00-04-d', {'claim.json': claim(), 'release.json': {status: 'confirmed', marks: {[AC]: mark()}},
    'publication.json': {status: 'uncertain'}});
  assert.equal(retryMarks(root, config).has(AC), false);
  assert.equal(retryMarks(root, {...config, workspace: 'other'}).size, 0);
});

test('a retry is due only for the exact own mark after its delay', () => {
  assert.equal(retryDue(row(), mark(), at('2026-11-05T10:00:59Z')), false);
  assert.equal(retryDue(row(), mark(), at('2026-11-05T10:01:00Z')), true);
  assert.equal(retryDue(row(942), mark(), at('2026-11-05T11:00:00Z')), false);
  assert.equal(retryDue(row(941, 5, 'OWNER_HOLD'), mark(), at('2026-11-05T11:00:00Z')), false);
  assert.equal(retryDue(row(), mark({code: 'NEEDS_HUMAN', retry_after: null}), at('2026-11-05T11:00:00Z')), false);
  assert.equal(retryDue(row(), null, at('2026-11-05T11:00:00Z')), false);
  // A critic rejection or another unlisted failure has no retry class and no retry time.
  assert.equal(retryDue(row(), mark({retry_class: null, retry_after: null}), at('2026-11-05T11:00:00Z')), false);
});

test('an exhausted mark returns to the queue only after an AC edit', () => {
  const exhausted = mark({retry_exhausted: true, retry_after: null});
  assert.equal(retryDue(row(941, 5), exhausted, at('2026-11-05T11:00:00Z')), false);
  assert.equal(retryDue(row(941, 6), exhausted, at('2026-11-05T11:00:00Z')), true);
  assert.equal(retryDue(row(941, 6), {...exhausted, retry_class: null}, at('2026-11-05T11:00:00Z')), false);
});
