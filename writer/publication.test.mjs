import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ac = 'ac:sample0000';
const input = {selected: {address: ac, kind: 'ac', document: {data: {owner: 'u1', tags: ['wallet']}}}, claim_revision: 31, children: []};
const draft = {tests: [{id: 't1', title: 'A Test', data: {body: 'Given x.'}}], coverage: 'c'};
const review = extra => ({draft_digest: 'd1', tests: [{id: 't1', score: '11111', reasons: []}], coverage: 'complete', missing: [], summary: 's', ...extra});

// Run a jq filter of this flow with the arguments of workflow.yaml.
function jq(filter, args, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-'));
  try {
    const flags = [];
    for (const [name, value] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value));
      flags.push('--slurpfile', name, `${name}.json`);
    }
    for (const [name, value] of Object.entries(args)) flags.push('--arg', name, value);
    return JSON.parse(execFileSync('jq', ['-nc', ...flags, '-f', path.join(here, filter)], {cwd: dir, encoding: 'utf8'}));
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
const publication = (reviews, mode = 'create') => jq('publication.jq',
  {digest: 'd1', test: 'test', gap_tag: 'source-gap-cto', run: 'run-1', mode},
  {draft: [draft][0], input, codex: reviews[0], second: reviews[1]});

test('approved Tests in create mode also move the AC to to_task', () => {
  const result = publication([review(), review()]);
  assert.equal(result.approved, true);
  const commands = result.operations.map(row => row.command);
  assert.equal(commands[0].kind, 'test');
  assert.deepEqual(commands.at(-1), {op: 'save_object', kind: 'ac', id: 'sample0000', revision: 31, data: {stage: 'to_task'},
    reason: 'Writer published the Tests that both critics approved. The AC goes to to_task.'});
});

test('a coverage gap moves the AC to to_decide in the same save as the gap tag', () => {
  const gap = review({coverage: 'incomplete', missing: ['m'], coverage_gap_kind: 'ac'});
  const result = publication([review(), gap]);
  assert.equal(result.decision_required, true);
  assert.deepEqual(result.operations[0].command.data, {stage: 'to_decide', tags: ['source-gap-cto', 'wallet']});
  assert.equal(result.operations[1].command.op, 'note');
});

test('a source gap moves the AC to to_decide and adds the tag only when it is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-gap-'));
  try {
    fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify({tests: [], coverage: 'GAP. No amount in the Source.'}));
    const run = tags => {
      fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify({...input, selected: {...input.selected, document: {data: {tags}}}}));
      return JSON.parse(execFileSync('jq', ['-c', '--arg', 'gap_tag', 'source-gap-cto', '--arg', 'run', 'run-1',
        '--slurpfile', 'input', 'input.json', '-f', path.join(here, 'source-gap.jq'), 'draft.json'], {cwd: dir, encoding: 'utf8'}));
    };
    assert.deepEqual(run(['wallet']).operations[0].command.data, {stage: 'to_decide', tags: ['source-gap-cto', 'wallet']});
    assert.deepEqual(run(['source-gap-cto']).operations[0].command.data, {stage: 'to_decide'});
    assert.equal(run([]).outcome.reason_code, 'SOURCE_GAP');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
