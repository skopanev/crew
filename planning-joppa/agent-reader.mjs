#!/usr/bin/env node
// Configure the existing read-only MCP adapter for one agent profile.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const need = (ok, message) => { if (!ok) throw new Error(message); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const toml = value => Array.isArray(value) ? '[' + value.map(toml).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.entries(value).map(([k, v]) => JSON.stringify(k) + '=' + toml(v)).join(',') + '}'
    : JSON.stringify(value);
function save(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(temp, file);
}
export function prepare(name, files, existing, env = process.env) {
  need(/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name), 'Use a reader profile name');
  const grant = Array.isArray(files) ? {files, roots: []} : files;
  need(grant && Array.isArray(grant.files) && grant.files.every(file => typeof file === 'string' && path.isAbsolute(file)),
    'Grant explicit absolute file paths');
  need(Array.isArray(grant.roots ?? []) && (grant.roots ?? []).every(root => typeof root === 'string' && path.isAbsolute(root)),
    'Grant explicit absolute directory paths');
  const config = read(env.PLANNING_JOPPA_CONFIG), artifacts = path.join(env.MEDULLA_RUN_DIR, 'artifacts');
  const servers = existing ? {...read(existing).mcpServers} : {};
  const source = servers.joppa ?? servers.sources ?? {
    command: env.PLANNING_PYTHON ?? 'python3', args: [path.join(here, 'mcp.py'),
      '--url', config.url, '--workspace', config.workspace,
      ...(config.mcp_command ? ['--mcp-command', JSON.stringify(config.mcp_command)]
        : ['--token-file', config.reader_token_file ?? config.token_file])]};
  need(typeof source.command === 'string' && Array.isArray(source.args), 'Use a configured read-only reader');
  const server = {...source, env: {...source.env, CREW_READER_FILES: JSON.stringify(grant.files),
    CREW_READER_ROOTS: JSON.stringify(grant.roots ?? [])}};
  const file = path.join(artifacts, `${name}-reader.json`);
  fs.mkdirSync(artifacts, {recursive: true});
  if (servers.sources === source) delete servers.sources;
  save(file, {mcpServers: {...servers, joppa: server}});
  const home = env.AGY_PROFILE_HOME ? path.join(env.AGY_PROFILE_HOME, name) : '';
  return {file, home};
}
export function agentArgs(harness, configFile) {
  const servers = read(configFile).mcpServers ?? {}, {joppa} = servers;
  need(joppa?.command && Array.isArray(joppa.args), 'Reader config needs the read-only joppa adapter');
  if (harness === 'codex') return ['--ignore-user-config',
    ...['shell_tool', 'view_image', 'apps', 'browser_use', 'multi_agent'].flatMap(key => ['-c', `features.${key}=false`]),
    '-c', 'mcp_servers=' + toml({...servers, joppa: {...joppa, required: true}})];
  if (harness === 'claude-code') return ['--strict-mcp-config', '--setting-sources=', '--mcp-config', configFile, '--tools='];
  need(harness === 'agy', 'Unsupported reader harness');
  return [];
}
export function prepareAgy(configFile, home, env = process.env) {
  need(home && path.isAbsolute(home), 'AGY needs a private reader profile');
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  const config = path.join(home, '.gemini/config/mcp_config.json');
  const next = read(configFile);
  const childEnv = {...env, BROKER_AGY_HOME: home, BROKER_ISOLATE_MCP: '1'};
  const query = () => {
    const result = spawnSync(env.AGY_BIN || 'agy', ['mcp', 'list'], {env: childEnv, encoding: 'utf8', timeout: 45_000});
    need(result.status === 0, `AGY reader inventory failed (${result.error?.code ?? result.status})`);
    return result.stdout;
  };
  if (!fs.existsSync(config)) {
    need(query().trim() === 'No MCP servers configured.', 'AGY inherited an unexpected MCP adapter');
    need(fs.statSync(path.dirname(config)).isDirectory(), 'AGY did not initialize its private profile');
  } else need(JSON.stringify(read(config)) === JSON.stringify(next), 'AGY reader profile changed');
  need(fs.realpathSync(path.dirname(config)).startsWith(fs.realpathSync(home) + path.sep), 'AGY config escaped its profile');
  save(config, next);
  const loaded = query();
  need(Object.keys(next.mcpServers).every(name => loaded.includes(name)), 'AGY did not load its configured readers');
}
export function criticSeats(configFile, home, env = process.env) {
  const pack = values => Object.fromEntries(values.map((value, i) => ['a' + (i + 1), value]));
  const make = (slug, harness, model) => ({slug, harness, model, ...pack(agentArgs(harness, configFile)),
    ...(harness === 'agy' ? {env: {BROKER_AGY_HOME: home, BROKER_ISOLATE_MCP: '1'}} : {})});
  if (env.CRITIC_SECOND_HARNESS === 'agy') prepareAgy(configFile, home, env);
  return [make('codex', 'codex', env.CRITIC_CODEX_MODEL),
    make('second', env.CRITIC_SECOND_HARNESS, env.CRITIC_SECOND_MODEL)];
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, name, files, existing, ...extra] = process.argv.slice(2);
    if (mode === 'prepare') {
      const result = prepare(name, files.startsWith('@') ? read(files.slice(1)) : JSON.parse(files),
        existing && existing !== '--agy' ? existing : undefined);
      if ([existing, ...extra].includes('--agy')) prepareAgy(result.file, result.home);
      for (const [key, value] of Object.entries({config: result.file, home: result.home})) {
        need(!/[<>&\r\n]/.test(value), 'The reader path cannot be represented as a workflow variable');
        console.log(`<signal:var key=${name}_reader_${key}>${value}</signal:var>`);
      }
    } else if (mode === 'seats') console.log(JSON.stringify(criticSeats(name, files)));
    else throw new Error('Use prepare NAME FILES_JSON [MCP_CONFIG] [--agy], or seats CONFIG HOME');
  } catch (error) { console.error('agent-reader: ' + error.message); process.exitCode = 1; }
}
