import fs from 'node:fs';
import path from 'node:path';

const role = process.argv[2];
if (!['scout', 'coder', 'reviewer', 'gitfix'].includes(role)) throw new Error('Unknown lane role');
const env = process.env, artifacts = path.join(env.MEDULLA_RUN_DIR, 'artifacts');
const perspective = role === 'reviewer' ? JSON.parse(env.MEDULLA_INPUT).slug : '';
if (perspective && !/^[a-zA-Z0-9_-]+$/.test(perspective)) throw new Error('Invalid reviewer perspective');
const values = Object.fromEntries(['ticket_id', 'project_name', 'TICKET_SOURCE', 'SCOUT_SOURCE',
  'LANE_WORKTREE', 'CBM_PROJECT', 'review_commands', 'ticket_test_command', 'test_report',
  'VERIFY_ONLY', 'project_dir'].map(key => [key, env[key] ?? '']));
fs.mkdirSync(artifacts, {recursive: true});
const file = path.join(artifacts, `${role}${perspective ? '-' + perspective : ''}-context.json`);
const instructionsFile = file.replace(/-context\.json$/, '-instructions.md');
const substitutions = {...env, RUN_ARTIFACTS: artifacts};
const instructions = fs.readFileSync(new URL(`../prompts/${role}.md`, import.meta.url), 'utf8')
  .replace(/\{\{var:([^}]+)\}\}/g, (_, key) => {
    if (substitutions[key] === undefined) throw new Error(`Missing role variable: ${key}`);
    return substitutions[key];
  }).replaceAll('{{input.slug}}', perspective);
fs.writeFileSync(instructionsFile, instructions, {mode: 0o600});
const temp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temp, JSON.stringify({...values, artifacts, perspective, instructions_file: instructionsFile,
  handoff: env.MEDULLA_LAST_MESSAGE ?? ''}, null, 2) + '\n', {mode: 0o600});
fs.renameSync(temp, file);
