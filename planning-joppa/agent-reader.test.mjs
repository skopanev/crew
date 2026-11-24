import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepare, agentArgs, criticSeats, prepareAgy} from './agent-reader.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-reader-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const config = path.join(root, 'config.json'), run = path.join(root, 'run');
  fs.writeFileSync(config, JSON.stringify({url: 'https://service.invalid/mcp', workspace: 'sample',
    mcp_command: ['/host/mcp-remote', 'https://service.invalid/mcp']}));
  const env = {...process.env, PLANNING_JOPPA_CONFIG: config, MEDULLA_RUN_DIR: run,
    PLANNING_PYTHON: 'python3', AGY_PROFILE_HOME: path.join(root, 'agy')};
  return {root, config, run, env};
}

test('a profile grants artifacts and source roots without enabling legacy snapshot capture', t => {
  const f = fixture(t), files = [path.join(f.root, 'missing-draft.json')], roots = [f.root];
  const profile = prepare('author', {files, roots}, undefined, f.env);
  const config = JSON.parse(fs.readFileSync(profile.file));
  const server = config.mcpServers.joppa;
  assert.deepEqual(JSON.parse(server.env.CREW_READER_FILES), files);
  assert.deepEqual(JSON.parse(server.env.CREW_READER_ROOTS), roots);
  assert.equal(server.args.includes('--artifacts'), false);
  assert.equal(fs.statSync(profile.file).mode & 0o077, 0);
  const args = agentArgs('codex', profile.file);
  assert.equal(args.length, 13);
  const parsed = Bun.TOML.parse(args.at(-1));
  assert.deepEqual(parsed.mcp_servers.joppa, {...server, required: true});
  assert.deepEqual(agentArgs('claude-code', profile.file),
    ['--strict-mcp-config', '--setting-sources=', '--mcp-config', profile.file, '--tools=']);
  const seats = criticSeats(profile.file, profile.home,
    {...f.env, CRITIC_CODEX_MODEL: 'first', CRITIC_SECOND_HARNESS: 'claude-code', CRITIC_SECOND_MODEL: 'second'});
  assert.equal(seats[0].a13, args.at(-1));
  assert.equal(seats[1].a4, profile.file);
});

test('the CLI accepts a manifest and preserves a custom reader with its environment', t => {
  const f = fixture(t), existing = path.join(f.root, 'reader.json'), manifest = path.join(f.root, 'manifest.json');
  const cbm = {command: '/host/cbm', args: ['read-only']};
  fs.writeFileSync(existing, JSON.stringify({mcpServers: {'codebase-memory': cbm,
    sources: {command: 'python3', args: ['/role/reader.py'], env: {ROLE: 'value'}}}}));
  fs.writeFileSync(manifest, JSON.stringify({files: [path.join(f.root, 'draft.json')], roots: []}));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./agent-reader.mjs', import.meta.url)),
    'prepare', 'critic', '@' + manifest, existing], {env: f.env, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<signal:var key=critic_reader_config>/);
  assert.match(result.stdout, /<signal:var key=critic_reader_home>/);
  const config = JSON.parse(fs.readFileSync(path.join(f.run, 'artifacts/critic-reader.json')));
  assert.equal(config.mcpServers.joppa.env.ROLE, 'value');
  assert.deepEqual(config.mcpServers.joppa.args, ['/role/reader.py']);
  assert.deepEqual(config.mcpServers['codebase-memory'], cbm);
  assert.equal(config.mcpServers.sources, undefined);
  assert.deepEqual(Bun.TOML.parse(agentArgs('codex', path.join(f.run, 'artifacts/critic-reader.json')).at(-1))
    .mcp_servers['codebase-memory'], cbm);
  fs.writeFileSync(existing, JSON.stringify({mcpServers: {'codebase-memory': cbm}}));
  const defaultProfile = prepare('default', [], existing, f.env);
  const defaultServers = JSON.parse(fs.readFileSync(defaultProfile.file)).mcpServers;
  assert.deepEqual(defaultServers['codebase-memory'], cbm);
  assert.ok(defaultServers.joppa.args.includes('--mcp-command'));
  assert.throws(() => prepare('bad', ['relative'], undefined, f.env), /absolute file/);
});

test('AGY uses the broker private profile and refuses an unrelated MCP inventory', t => {
  const f = fixture(t), binary = path.join(f.root, 'agy-bin');
  fs.writeFileSync(binary, '#!/usr/bin/env node\n' +
    'const fs=require("node:fs"),path=require("node:path");const p=process.env.BROKER_AGY_HOME+"/.gemini/config/mcp_config.json";\n' +
    'fs.mkdirSync(path.dirname(p),{recursive:true});console.log(fs.existsSync(p)?"joppa":"No MCP servers configured.");\n', {mode: 0o755});
  const profile = prepare('critic', [], undefined, f.env), env = {...f.env, AGY_BIN: binary};
  prepareAgy(profile.file, profile.home, env);
  const target = path.join(profile.home, '.gemini/config/mcp_config.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(target)), JSON.parse(fs.readFileSync(profile.file)));
  fs.writeFileSync(target, JSON.stringify({mcpServers: {other: {}}}));
  assert.throws(() => prepareAgy(profile.file, profile.home, env), /profile changed/);
});
