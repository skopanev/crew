import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';

test('lane role files preserve complete handoffs and checks across review seats', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-context-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const message = 'Handoff with quotes " and Unicode Ж\n'.repeat(900);
  const checks = JSON.stringify(['check\n'.repeat(5000)]);
  for (const role of ['scout', 'coder', 'reviewer', 'gitfix']) {
    for (const slug of role === 'reviewer' ? ['architecture', 'security'] : ['']) {
      execFileSync('node', [new URL('../bin/prompt-context.mjs', import.meta.url).pathname, role], {
        env: {...process.env, MEDULLA_RUN_DIR: root, MEDULLA_INPUT: JSON.stringify({slug}),
          MEDULLA_LAST_MESSAGE: message, review_commands: checks, ticket_id: 'task:example',
          project_name: 'example', project_dir: root}});
      const file = path.join(root, 'artifacts', `${role}${slug ? '-' + slug : ''}-context.json`);
      const context = JSON.parse(fs.readFileSync(file));
      assert.equal(context.handoff, message);
      assert.equal(context.review_commands, checks);
      assert.equal(context.ticket_id, 'task:example');
      assert.equal(context.perspective, slug);
      const instructions = fs.readFileSync(context.instructions_file, 'utf8');
      assert.doesNotMatch(instructions, /\{\{/);
      assert.ok(instructions.includes('task:example') || role === 'reviewer');
      assert.equal(fs.statSync(file).mode & 0o077, 0);
    }
  }
  const template = path.join(root, 'custom.md');
  fs.writeFileSync(template, '{{last.message}}\n{{input.slug}}\n{{var:ticket_id}}');
  execFileSync('node', [new URL('../bin/prompt-context.mjs', import.meta.url).pathname, 'custom_plan', template], {
    env: {...process.env, MEDULLA_RUN_DIR: root, MEDULLA_INPUT: '{"slug":"correctness"}',
      MEDULLA_LAST_MESSAGE: '$&\nComplete handoff', ticket_id: 'task:example'}});
  const custom = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/custom_plan-correctness-context.json')));
  assert.equal(fs.readFileSync(custom.instructions_file, 'utf8'), '$&\nComplete handoff\ncorrectness\ntask:example');
});
