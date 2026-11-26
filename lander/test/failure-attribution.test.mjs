import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {failurePaths} from '../failure-attribution.mjs';

test('the recorded reversal failure identifies only Task 77r2jk6p from its five-Task batch', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/reverse-write-tasks.json',import.meta.url)));
  const log = fs.readFileSync(new URL('./fixtures/reverse-write-failure.log',import.meta.url),'utf8');
  const known = new Set([...fixture.tasks.flatMap(item => item.files),
    'apps/api/src/flows/withdraw-on-us-settlement-posted-only.test.ts', 'packages/ledger/src/core/post-internal.ts']);
  const files = failurePaths(log,'',known);
  assert.deepEqual(files,[
    'apps/api/src/flows/withdraw-on-us-settlement-posted-only.test.ts',
    'packages/ledger/src/core/post-internal.ts',
    'packages/ledger/src/core/reverse-write.ts',
    'packages/ledger/src/core/reverse.ts',
  ]);
  const matches = fixture.tasks.filter(item => item.files.some(file => files.includes(file)));
  assert.deepEqual(matches.map(item => item.address),[fixture.culprit]);
  assert.equal(matches[0].head,'94d1b3f1f7cc3f9117e30b296b28c6e3b66f6e95');
});

test('only failed JUnit cases and native failure blocks contribute paths', () => {
  const known = new Set(['src/pass.test.ts','src/fail.test.ts','src/assertion.ts','src/other.test.ts']);
  const log = '✔ src/other.test.ts passed\n✖ failing tests:\ntest at src/fail.test.ts:1:1\n' +
    '  AssertionError: src/assertion.ts\n[test] file src/fail.test.ts: rc=1 in 1s\n✔ src/other.test.ts passed\n';
  const xml = '<testsuite><testcase file="src/pass.test.ts"/>' +
    '<testcase file="src/fail.test.ts"><failure>src/assertion.ts</failure></testcase>' +
    '<testcase file="src/other.test.ts"><skipped/></testcase></testsuite>';
  assert.deepEqual(failurePaths(log,xml,known),['src/assertion.ts','src/fail.test.ts']);
  assert.deepEqual(failurePaths('✔ src/other.test.ts passed','',known),[]);
});
