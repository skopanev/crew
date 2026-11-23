// Local workflow checks and output files. Only the shared flow stage sends tracker writes.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {review} from './reconcile.mjs';

const need = (value, message) => { if (!value) throw new Error(message); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => {
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
};

export function policy(env) {
  for (const name of ['CREW_FLOW_STAGES', 'FLOW_PUBLICATION', 'TEST_KIND']) need(env[name], name + ' is required');
  need(/^\d+$/.test(env.REWORK_LIMIT), 'REWORK_LIMIT must be a nonnegative integer');
  need(['create', 'update', 'reconcile'].includes(env.TEST_OPERATION), 'TEST_OPERATION must be create, update or reconcile');
  need(['true', 'false'].includes(env.DRY_RUN ?? 'false'), 'DRY_RUN must be true or false');
  const publication = JSON.parse(env.FLOW_PUBLICATION), kind = env.TEST_KIND;
  if (env.TEST_OPERATION === 'update') {
    const config = read(env.PLANNING_JOPPA_CONFIG);
    need(same(publication.create_kinds, []) && same([...publication.update_kinds].sort(), [kind, config.selection.kind].sort()) &&
      publication.allowed_operations.includes('note'), 'Update needs scoped AC/Test saves and refusal notes');
  }
  if (env.TEST_OPERATION === 'reconcile') {
    const config = read(env.PLANNING_JOPPA_CONFIG);
    need(same(publication.create_kinds, [kind]) && same([...publication.update_kinds].sort(), [kind, config.selection.kind].sort()) &&
      same([...publication.allowed_operations].sort(), ['archive_object', 'note', 'save_object']), 'Reconcile needs scoped AC/Test saves, Test archives and notes');
    need(['claude-code', 'codex'].includes(env.CRITIC_SECOND_HARNESS), 'Reconcile uses the tool-free Claude or Codex critic');
  }
  if (env.DRY_RUN === 'true') need(read(env.PLANNING_JOPPA_CONFIG).failure_notes === false, 'DRY_RUN requires frozen failure_notes:false');
  if (env.TEST_OPERATION !== 'update' && env.SOURCE_GAP_TAG) need(publication.allowed_operations.includes('note'), 'Source gaps require note permission');
  need(!env.CRITIC_CLAUDE_MODEL, 'Rename CRITIC_CLAUDE_MODEL to CRITIC_SECOND_MODEL');
  need(['claude-code', 'codex', 'agy'].includes(env.CRITIC_SECOND_HARNESS), 'Unsupported second critic harness');
  if (env.CRITIC_SECOND_HARNESS === 'agy') need(fs.statSync(env.AGY_PROFILE_HOME).isDirectory(), 'AGY_PROFILE_HOME is unavailable');
  need(env.CRITIC_SECOND_MODEL && env.CRITIC_SECOND_MODEL !== env.AUTHOR_MODEL, 'Author and second critic need different models');
  need(env.CRITIC_CODEX_MODEL && env.CRITIC_CODEX_MODEL !== env.CRITIC_SECOND_MODEL, 'Critic models must be distinct');
}

export function dryOutput(value, dry) {
  return dry ? {operations: [], outcome: {status: 'blocked', reason_code: 'DRY_RUN',
    reason: ('Would publish: ' + (value.outcome?.reason || value.outcome?.reason_code || 'approved Writer operations')).slice(0, 1000)}} : value;
}

function main() {
  const [mode, dir] = process.argv.slice(2), env = process.env;
  if (mode === 'policy') { policy(env); return; }
  if (mode === 'seats') {
    const codex = ['--ignore-user-config', ...['shell_tool', 'view_image', 'apps', 'browser_use', 'multi_agent']
      .flatMap(name => ['-c', 'features.' + name + '=false'])];
    const claude = ['--strict-mcp-config', '--setting-sources=', '--mcp-config', '{"mcpServers":{}}', '--tools='];
    const args = values => Object.fromEntries(values.map((value, index) => ['a' + (index + 1), value]));
    console.log(JSON.stringify([{slug: 'codex', harness: 'codex', model: env.CRITIC_CODEX_MODEL, ...args(codex)},
      {slug: 'second', harness: env.CRITIC_SECOND_HARNESS, model: env.CRITIC_SECOND_MODEL,
        ...(env.CRITIC_SECOND_HARNESS === 'agy' ? {env: {BROKER_AGY_HOME: env.AGY_PROFILE_HOME, BROKER_ISOLATE_MCP: '1'}}
          : args(env.CRITIC_SECOND_HARNESS === 'codex' ? codex : claude))}]));
    return;
  }
  const input = () => read(path.join(dir, 'input.json'));
  if (mode === 'review') {
    if (env.TEST_OPERATION === 'reconcile') {
      const draft = read(path.join(dir, 'draft.json'));
      const digest = createHash('sha256').update(fs.readFileSync(path.join(dir, 'draft.json'))).digest('hex');
      console.log(JSON.stringify(review(input(), draft, ['critic-codex.json', 'critic-second.json'].map(name => read(path.join(dir, name))),
        digest, env.TEST_KIND, path.basename(path.dirname(dir)), env.SOURCE_GAP_TAG || '')));
    } else {
      const digest = createHash('sha256').update(fs.readFileSync(path.join(dir, 'draft.json'))).digest('hex');
      console.log(execFileSync('jq', ['-nc', '--arg', 'digest', digest, '--arg', 'test', env.TEST_KIND,
        '--arg', 'gap_tag', env.SOURCE_GAP_TAG || '', '--arg', 'run', path.basename(path.dirname(dir)), '--arg', 'mode', env.TEST_OPERATION,
        ...Object.entries({draft: 'draft.json', input: 'input.json', codex: 'critic-codex.json', second: 'critic-second.json'})
          .flatMap(([name, file]) => ['--slurpfile', name, path.join(dir, file)]),
        '-f', path.join(env.MEDULLA_WORKFLOW_DIR, 'publication.jq')], {encoding: 'utf8'}).trim());
    }
    return;
  }
  const file = JSON.parse(env.FLOW_PUBLICATION).file;
  need(path.basename(file) === file && file.endsWith('.json'), 'Publication must name a JSON basename');
  const target = path.join(dir, file);
  if (mode === 'rejected') {
    const assignment = input(), node = assignment.selected, reason = fs.readFileSync(path.join(dir, 'failure.txt'), 'utf8').slice(0, 1000);
    write(target, {operations: [
      {command: {op: 'save_object', kind: node.kind, id: node.address.split(':')[1], revision: assignment.claim_revision,
        data: {stage: 'to_decide'}, reason: 'Writer did not get approved Tests for this AC. The AC goes to to_decide.'}},
      {command: {op: 'note', target: node.address, id: ('writer-rejected-' + path.basename(path.dirname(dir))).replace(/[^A-Za-z0-9_.-]/g, '_').slice(-100), text: reason}}],
      outcome: {status: 'blocked', reason_code: 'REJECTED', reason}});
    return;
  }
  need(mode === 'preview', 'Use policy, review, rejected or preview');
  const proposal = read(target);
  if (env.DRY_RUN === 'true' && proposal.outcome?.reason_code === 'DRY_RUN' && fs.existsSync(path.join(dir, 'would-publish.json'))) return;
  write(path.join(dir, 'would-publish.json'), proposal);
  write(target, dryOutput(proposal, env.DRY_RUN === 'true'));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); } catch (error) { console.error('writer: ' + error.message); process.exitCode = 1; }
}
