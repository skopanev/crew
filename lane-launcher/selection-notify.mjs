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
      ['name', 'to'].some(key => typeof route[key] !== 'string' || !route[key].trim())) {
    throw new Error('selectionNotify needs mcpCommand, name and to');
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
      [config.workspace, config.id, issue, route?.to])).digest('hex');
    if (!terminal && !printed.has(id) && !sent[id]) console.error(formatSelectionIssue(issue));
    printed.add(id);
    if (!route || sent[id]) continue;
    const key = JSON.stringify(route.mcpCommand);
    if (!clients.has(key)) clients.set(key, new McpClient(route.mcpCommand, {timeoutMs: 15000, handshakeTimeoutMs: 15000}));
    const client = clients.get(key), session = {harness: 'crew', id: config.id + ':' + config.stateDir};
    try {
      value(await client.request('tools/call', {name: 'agntbus_register', arguments: {_session: session,
        name: route.name, description: 'Deterministic Dolber selection diagnostics', temporary: false}}));
      const result = value(await client.request('tools/call', {name: 'agntbus_send', arguments: {_session: session,
        to: route.to, type: 'fyi', id, message: formatSelectionIssue(issue).slice(0, 1800)}}));
      if (!result.message_id || !result.op) throw new Error('Agntbus did not confirm message storage');
      sent[id] = result.message_id;
      fs.mkdirSync(config.stateDir, {recursive: true});
      save(file, sent);
    } catch (error) {
      client.close(); clients.delete(key);
      throw new Error('SELECTION_NOTIFY_FAILED: ' + error.message);
    }
  }
}
process.once('beforeExit', () => { for (const client of clients.values()) client.close(); });
