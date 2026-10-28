import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {quote} from '../runtime.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const active = pid => {
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {encoding: 'utf8'}).trim().startsWith('Z'); }
  catch { return false; }
};
const listening = port => new Promise(resolve => {
  const socket = net.connect({host: '127.0.0.1', port});
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
  socket.setTimeout(500, () => { socket.destroy(); resolve(true); });
});

for (const mode of ['natural', 'close-and-exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'handled-SIGINT']) {
  test(`MCP descendants and their listener stop after ${mode}`, {skip: process.platform === 'win32', timeout: 15_000}, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-mcp-lifecycle-'));
    const server = path.join(root, 'server.mjs'), runnerFile = path.join(root, 'runner.mjs');
    const state = path.join(root, 'state.json');
    let runner, group;
    t.after(() => {
      runner?.kill('SIGKILL');
      if (group) { try { process.kill(-group, 'SIGKILL'); } catch {} }
      fs.rmSync(root, {recursive: true, force: true});
    });
    fs.writeFileSync(server, `
import fs from 'node:fs';
import net from 'node:net';
import {createInterface} from 'node:readline';
import {execFileSync} from 'node:child_process';
process.on('SIGTERM', () => {});
const listener = net.createServer(socket => socket.end());
listener.listen(0, '127.0.0.1', () => {
 const value = {pid: process.pid, port: listener.address().port,
  pgid: Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {encoding: 'utf8'}).trim())};
 fs.writeFileSync(process.argv[2], JSON.stringify(value));
 const input = createInterface({input: process.stdin});
 input.on('line', line => {
  const r = JSON.parse(line);
  if (!('id' in r)) return;
  const result = r.method === 'initialize'
   ? {protocolVersion: '2025-03-26', capabilities: {tools: {}}}
   : {structuredContent: value};
  console.log(JSON.stringify({jsonrpc: '2.0', id: r.id, result}));
 });
});
`);
    fs.writeFileSync(runnerFile, `
import {McpClient} from ${JSON.stringify(new URL('../mcp-client.mjs', import.meta.url).href)};
import {callJoppa} from ${JSON.stringify(new URL('../joppa-api.mjs', import.meta.url).href)};
const argv = JSON.parse(process.argv[2]), mode = process.argv[3];
if (mode === 'close-and-exit') {
 const client = new McpClient(argv);
 await client.request('tools/call', {name: 'probe', arguments: {}});
 client.close();
 process.exit(0);
}
await callJoppa('https://service.invalid/mcp', undefined, 'probe', {}, {mcpCommand: argv});
if (mode !== 'natural') {
 const timer = setInterval(() => {}, 1000);
 if (mode === 'handled-SIGINT') process.once('SIGINT', () => {
  console.log('application cleanup');
  clearInterval(timer);
 });
 console.log('ready');
}
`);
    const command = ['npx', '--offline', '--call', `${quote(process.execPath)} ${quote(server)} ${quote(state)}`];
    runner = spawn(process.execPath, [runnerFile, JSON.stringify(command), mode], {stdio: ['ignore', 'pipe', 'pipe']});
    const completed = once(runner, 'exit');
    let stdout = '', stderr = '';
    runner.stdout.on('data', chunk => { stdout += chunk; });
    runner.stderr.on('data', chunk => { stderr += chunk; });
    for (let i = 0; i < 200 && !fs.existsSync(state) && runner.exitCode === null; i++) await pause(25);
    assert(fs.existsSync(state), `MCP fixture did not start: ${stderr}`);
    const {pid, port, pgid} = JSON.parse(fs.readFileSync(state, 'utf8'));
    // Only the fixture's isolated group is eligible for fallback cleanup.
    assert.notEqual(pgid, Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {encoding: 'utf8'}).trim()));
    group = pgid;
    if (mode.startsWith('SIG') || mode === 'handled-SIGINT') {
      for (let i = 0; i < 200 && !stdout.includes('ready') && runner.exitCode === null; i++) await pause(25);
      assert.match(stdout, /ready/, stderr);
      assert(await listening(port));
      runner.kill(mode === 'handled-SIGINT' ? 'SIGINT' : mode);
    }
    const [code, signal] = await completed;
    if (mode.startsWith('SIG')) assert.equal(signal, mode, stderr);
    else assert.equal(code, 0, stderr);
    if (mode === 'handled-SIGINT') assert.match(stdout, /application cleanup/);
    for (let i = 0; i < 80 && active(pid); i++) await pause(25);
    assert.equal(active(pid), false, `MCP descendant ${pid} survived ${mode}`);
    assert.equal(await listening(port), false, `MCP listener survived ${mode}`);
  });
}
