// Report each refused Task revision once. Reuse the existing MCP transport.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {McpClient} from './mcp-client.mjs';
import {save} from './runtime.mjs';

const printed = new Set(), clients = new Map();
export const formatSelectionIssue = issue => `${issue.code} · ${issue.task}@${issue.revision} · ${issue.message}`;
export function validateSelectionNotify(route) {
  if (route === undefined || route === null) return;
  if (!route || !Array.isArray(route.mcpCommand) || !route.mcpCommand.length ||
      route.mcpCommand.some(arg => typeof arg !== 'string' || !arg.trim() || arg.includes('\0')) ||
      typeof route.to !== 'string' || !route.to.trim() ||
      typeof route.tokenFile !== 'string' || !path.isAbsolute(route.tokenFile)) {
    throw new Error('selectionNotify needs mcpCommand, to and an absolute tokenFile');
  }
}
function value(reply) {
  if (reply.isError) throw new Error('Agntbus refused the selection notification');
  const result = reply.structuredContent ?? JSON.parse(reply.content.find(item => item.type === 'text').text);
  if (!result || result.error) throw new Error('Agntbus did not confirm the selection notification');
  return result;
}
export async function reportSelectionIssues(config, issues, {terminal = false} = {}) {
  if (!issues.length) return;
  const route = config.selectionNotify, file = path.join(config.stateDir, 'selection-alerts.json');
  let sent = {};
  if (route) {
    try { sent = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const issue of issues) {
    const id = 'selection-' + createHash('sha256').update(JSON.stringify(
      [config.workspace, config.id, issue.task, issue.revision, issue.code, route?.to])).digest('hex');
    if (!terminal && !printed.has(id) && !sent[id]) console.error(formatSelectionIssue(issue));
    printed.add(id);
    if (!route || sent[id]) continue;
    const key = JSON.stringify([route.mcpCommand, route.tokenFile]);
    try {
      if (!clients.has(key)) {
        const token = fs.readFileSync(route.tokenFile, 'utf8').trim();
        if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Agntbus token file must contain a role key');
        clients.set(key, new McpClient(route.mcpCommand, {timeoutMs: 15000, handshakeTimeoutMs: 15000,
          env: {...process.env, CREW_AGNTBUS_TOKEN: token}}));
      }
      const client = clients.get(key);
      const result = value(await client.request('tools/call', {name: 'agntbus_send', arguments: {
        to: route.to, type: 'fyi', id, message: formatSelectionIssue(issue).slice(0, 1800)}}));
      if (!result.message_id || !result.op) throw new Error('Agntbus did not confirm message storage');
      sent[id] = result.message_id;
      fs.mkdirSync(config.stateDir, {recursive: true});
      save(file, sent);
    } catch (error) {
      clients.get(key)?.close(); clients.delete(key);
      throw new Error('SELECTION_NOTIFY_FAILED: ' + (error.rpcError?.message || error.message));
    }
  }
}
process.once('beforeExit', () => { for (const client of clients.values()) client.close(); });
