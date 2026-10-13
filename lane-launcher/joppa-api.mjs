import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const maxBytes = 8 * 1024 * 1024;

export async function callJoppa(url, tokenFile, tool, arguments_, {signal} = {}) {
  const endpoint = new URL(url);
  const local = endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  if (!(endpoint.protocol === 'https:' || local) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Joppa needs HTTPS or loopback HTTP without URL credentials');
  }
  const filename = tokenFile.startsWith('~/') ? path.join(os.homedir(), tokenFile.slice(2)) : tokenFile;
  const token = (await fs.readFile(filename, 'utf8')).trim();
  if (!token) throw new Error('Joppa token file is empty');
  const total = AbortSignal.timeout(120_000);
  let sequence = 0, session, protocol;

  async function rpc(method, params, notification = false) {
    const id = ++sequence;
    const headers = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'};
    if (session) headers['Mcp-Session-Id'] = session;
    if (protocol) headers['MCP-Protocol-Version'] = protocol;
    const payload = {jsonrpc: '2.0', method, params, ...(!notification ? {id} : {})};
    let message;
    try {
      const response = await fetch(endpoint, {method: 'POST', headers, body: JSON.stringify(payload),
        redirect: 'manual', signal: AbortSignal.any([total, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])});
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Joppa MCP HTTP ${response.status}`);
      }
      session = response.headers.get('Mcp-Session-Id') || session;
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body || []) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new Error('Joppa response exceeds 8 MiB');
        chunks.push(chunk);
      }
      if (notification) return;
      const raw = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));
      if (response.headers.get('Content-Type')?.includes('text/event-stream')) {
        const events = raw.replaceAll('\r\n', '\n').split('\n\n');
        for (const event of events) {
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
          if (!data.length) continue;
          const item = JSON.parse(data.join('\n'));
          if (object(item) && item.id === id) { message = item; break; }
        }
      } else message = JSON.parse(raw);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (/^Joppa (MCP HTTP \d+|response exceeds 8 MiB)$/.test(error.message)) throw error;
      throw new Error('Joppa MCP transport failed');
    }
    if (!object(message) || message.id !== id) throw new Error('Joppa returned a different MCP response');
    if ('error' in message || !('result' in message)) throw new Error('Joppa rejected the MCP operation');
    return message.result;
  }

  const initialized = await rpc('initialize', {protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: {name: 'crew-joppa', version: '1'}});
  if (!object(initialized)) throw new Error('Joppa returned an invalid initialization');
  protocol = initialized.protocolVersion || '2025-03-26';
  await rpc('notifications/initialized', {}, true);
  const result = await rpc('tools/call', {name: tool, arguments: arguments_});
  if (!object(result)) throw new Error('Joppa returned an invalid tool result');
  let structured = result.structuredContent;
  const texts = (result.content || []).filter(item => item.type === 'text').map(item => item.text);
  if (!object(structured)) {
    try { structured = texts.length === 1 ? JSON.parse(texts[0]) : null; }
    catch { structured = null; }
  }
  if (result.isError) {
    let detail = object(structured) ? structured.error : null;
    if (object(detail)) detail = detail.message || detail.code;
    if (typeof detail !== 'string') detail = texts.join(' ') || 'TOOL_ERROR';
    const error = new Error(`Joppa ${tool}: ${detail.replaceAll(token, '[credential]').replaceAll('\n', ' ').slice(0, 2000)}`);
    error.rejected = true;
    throw error;
  }
  if (!object(structured)) throw new Error(`Joppa ${tool} returned no object`);
  return structured;
}
