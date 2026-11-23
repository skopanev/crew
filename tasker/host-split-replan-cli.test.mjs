import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './test-support/host-split.fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('actual check and review join CLIs require the same host receipt and fresh critic digests', () => {
  const x = fixture();
  try {
    const folder = path.join(x.root, 'tasker'), artifacts = path.join(folder, 'artifacts');
    fs.mkdirSync(artifacts, {recursive: true});
    const write = (name, data) => x.write(path.join(artifacts, name + '.json'), data);
    const options = x.options();
    for (const [name, value] of Object.entries({input: x.input, repair: x.repair, trees: x.trees, draft: x.draft,
      'critic-codex': options.reviews[0], 'critic-second': options.reviews[1]})) write(name, value);
    const env = {...x.env, DOLBER_CONFIG: x.configFile, CREW_WORKFLOW_DIR: path.resolve(here, '../workflow'),
      PLAN_MAX_FILES: '8', PLAN_MAX_LINES: '300', MEDULLA_RUN_DIR: folder, MEDULLA_WORKFLOW_DIR: here,
      FLOW_PUBLICATION: JSON.stringify({file: 'operations.json'}), DRY_RUN: 'false', TASK_STAGE: 'to_implement', round: '4', REWORK_LIMIT: '3'};
    const check = () => spawnSync(process.execPath, [path.join(here, 'check.mjs'), artifacts], {encoding: 'utf8', env});
    const first = check(); assert.equal(first.status, 0, first.stderr);
    const publication = () => spawnSync(process.execPath, [path.join(here, 'repair-context.mjs'), 'publication', artifacts],
      {encoding: 'utf8', env});
    const firstPublication = publication(); assert.equal(firstPublication.status, 0, firstPublication.stderr);
    assert.equal(JSON.parse(firstPublication.stdout).publication.operations[1].command.op, 'archive_object');
    const workflow = fs.readFileSync(path.join(here, 'workflow.yaml'), 'utf8');
    const shell = workflow.split('  review_join:\n')[1].split('    shell: |\n')[1].split('    on_signal:')[0];
    const join = () => spawnSync('sh', ['-c', shell], {encoding: 'utf8', env});
    const accepted = join(); assert.equal(accepted.status, 0, accepted.stderr); assert.match(accepted.stdout, /<signal:APPROVED>/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(artifacts, 'operations.json'))).outcome.reason_code, 'STALE');
    options.reviews[1].draft_digest = 'old'; write('critic-second', options.reviews[1]);
    fs.unlinkSync(path.join(artifacts, 'operations.json'));
    const old = join(); assert.equal(old.status, 0, old.stderr); assert.match(old.stdout, /<signal:REJECTED>/);
    assert.equal(fs.existsSync(path.join(artifacts, 'operations.json')), false);
    write('critic-second', options.reviews[0]);
    x.change('launch.json', run => { run.result.blockConfirmed = false; });
    const refused = check(); assert.equal(refused.status, 1, refused.stderr);
    const stale = publication(); assert.equal(stale.status, 0, stale.stderr);
    const output = JSON.parse(stale.stdout).publication;
    assert.equal(output.outcome.reason_code, 'DECISION_REQUIRED');
    assert.ok(output.operations.every(row => row.command.op !== 'archive_object' && !row.command.relations));
  } finally { x.cleanup(); }
});

test('the captured develop snapshot cannot move between check and publication', () => {
  const x = fixture();
  try {
    assert.ok(x.repair.split_replan);
    fs.writeFileSync(path.join(x.repo, 'file.ts'), 'export const existing = false;\n');
    x.git('add', '.'); x.git('commit', '-q', '-m', 'Different develop');
    assert.equal(x.capture(), null);
  } finally { x.cleanup(); }
});
