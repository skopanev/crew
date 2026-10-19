import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {command, read, require, text, write} from '../audit/common.mjs';
import {readTools, server} from '../audit/cbm.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  const args = process.argv.slice(2), file = args.shift();
  require(file && !file.startsWith('-') && args.every(arg => ['--dry-run', '--no-publish'].includes(arg)),
    'Usage: auditor-joppa.sh CONFIG.json [--dry-run | --no-publish]');
  const configFile = path.resolve(file), config = read(configFile), root = path.dirname(configFile);
  for (const key of ['url', 'workspace', 'token_file', 'equill_store', 'equill_actor', 'project', 'runs_folder', 'cbm_root', 'cbm_store']) {
    require(text(config[key]), `Config needs ${key}`);
  }
  for (const key of ['token_file', 'equill_store', 'runs_folder', 'cbm_root', 'cbm_store']) config[key] = path.resolve(root, config[key]);
  if (config.cbm_command?.includes(path.sep)) config.cbm_command = path.resolve(root, config.cbm_command);
  require(config.inbox && text(config.inbox.kind) && text(config.inbox.owner), 'Config needs inbox kind and owner');
  require(!config.inbox.body_field || text(config.inbox.body_field)
    && !['title', 'owner', 'status', 'audit_key'].includes(config.inbox.body_field), 'Invalid inbox body field');
  require(Array.isArray(config.repositories) && config.repositories.length, 'Config needs repositories');
  const ids = new Set();
  for (const repo of config.repositories) {
    require(text(repo.id) && !ids.has(repo.id) && text(repo.path) && text(repo.cbm_project),
      'Repositories need unique IDs, paths and CBM project names');
    ids.add(repo.id); repo.path = path.resolve(root, repo.path);
    require(config.runs_folder !== repo.path && !config.runs_folder.startsWith(repo.path + path.sep),
      'Audit runs must stay outside source repositories');
  }
  require(!config.roots || Array.isArray(config.roots) && config.roots.every(text), 'Audit roots must be object addresses');
  const models = {AUDIT_MODEL: config.audit_model || 'gpt-6.1-sol', REVIEW_MODEL: config.review_model || 'claude-sonnet-5-5'};
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify({workflow: 'audit', workspace: config.workspace, roots: config.roots || 'workspace',
      models, publication: !args.includes('--no-publish'),
      repositories: config.repositories.map(({id, cbm_project}) => ({id, cbm_project})), cbm: 'existing shared index'}, null, 2));
    process.exit(0);
  }
  require(fs.existsSync(config.token_file), 'Configured user token file is unavailable');
  command(process.env.PLANNING_PYTHON || 'python3', [path.join(here, '../roles/export.py'), '--check', 'audit', 'shared'],
    {env: {...process.env, EQUILL_STORE: config.equill_store}});
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-audit-'));
  try {
    const reader = {command: process.env.PLANNING_PYTHON || 'python3', args: [path.join(here, '../planning-joppa/mcp.py'),
      '--url', config.url, '--workspace', config.workspace, '--token-file', config.token_file]};
    // TOML inline tables use equals; JSON string and array scalars remain valid.
    const cbm = server(config), json = JSON.stringify;
    config.reader_toml = `mcp_servers={joppa={command=${json(reader.command)},args=${json(reader.args)},required=true},`
      + `codebase-memory={command=${json(cbm.command)},args=[],env={CBM_CACHE_DIR=${json(cbm.env.CBM_CACHE_DIR)},`
      + `CBM_ALLOWED_ROOT=${json(cbm.env.CBM_ALLOWED_ROOT)}},enabled_tools=${json(readTools)},required=true}}`;
    config.reader_config = JSON.stringify({mcpServers: {joppa: reader, 'codebase-memory': cbm}});
    config.reader_tools = ['Read', 'Grep', 'Glob', 'mcp__joppa__*',
      ...readTools.map(name => `mcp__codebase-memory__${name}`)].join(',');
    const normalized = path.join(temp, 'config.json');
    write(normalized, config);
    const variables = {AUDIT_CONFIG: normalized, AUDIT_ADAPTER: path.join(here, 'adapter.mjs'),
      AUDIT_NO_PUBLISH: String(args.includes('--no-publish')), ...models};
    const commandArgs = ['-w', path.join(here, '../audit'), '--runs-folder', config.runs_folder, '--print-run-dir'];
    for (const [key, value] of Object.entries(variables)) commandArgs.push('--var', `${key}=${value}`);
    const result = spawnSync(process.env.MEDULLA_BIN || 'medulla', commandArgs, {stdio: 'inherit'});
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 2;
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
} catch (error) { console.error(`auditor: ${error.message}`); process.exitCode = 2; }
