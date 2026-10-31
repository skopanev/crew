import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {McpClient} from './mcp-client.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const maxBytes = 8 * 1024 * 1024;
const clients = new Map();
process.once('beforeExit', () => { for (const client of clients.values()) client.close(); });

function toolValue(result, tool, token = '') {
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
    if (token) detail = detail.replaceAll(token, '[credential]');
    const error = new Error(`Joppa ${tool}: ${detail.replaceAll('\n', ' ').slice(0, 2000)}`);
    error.rejected = true;
    throw error;
  }
  if (!object(structured)) throw new Error(`Joppa ${tool} returned no object`);
  return structured;
}

async function responseMessage(response, id) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const stream = response.headers.get('Content-Type')?.includes('text/event-stream');
  let buffer = '', size = 0;
  try {
    while (reader) {
      const {value, done} = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Joppa response exceeds 8 MiB');
      buffer += decoder.decode(value, {stream: true});
      if (!stream) continue;
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
        if (!data.length) continue;
        const item = JSON.parse(data.join('\n'));
        if (object(item) && item.id === id) return item;
      }
    }
    return stream ? undefined : JSON.parse(buffer);
  } finally {
    await reader?.cancel().catch(() => {});
  }
}

export async function callJoppa(url, tokenFile, tool, arguments_, options = {}) {
  const result = await rawCall(url, tokenFile, tool, arguments_, options);
  if (tool === 'joppa_objects' && arguments_.address && !arguments_.history) {
    return completeDetail(arguments_, result, args => rawCall(url, tokenFile, tool, args, options));
  }
  if (tool === 'joppa_tasks') normalizeTasks(result);
  if (tool === 'joppa_tests') normalizeTests(arguments_, result);
  return result;
}

async function rawCall(url, tokenFile, tool, arguments_, {signal, mcpCommand} = {}) {
  const endpoint = new URL(url);
  const local = endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  if (!(endpoint.protocol === 'https:' || local) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Joppa needs HTTPS or loopback HTTP without URL credentials');
  }
  if (mcpCommand !== undefined) {
    if (!Array.isArray(mcpCommand) || !mcpCommand.length ||
        mcpCommand.some(arg => typeof arg !== 'string' || !arg.trim() || arg.includes('\0'))) {
      throw new Error('Joppa mcpCommand must contain an executable and its arguments');
    }
    const key = JSON.stringify(mcpCommand);
    if (!clients.has(key)) clients.set(key, new McpClient(mcpCommand));
    const client = clients.get(key);
    try {
      return toolValue(await client.request('tools/call', {name: tool, arguments: arguments_}, {signal}), tool);
    } catch (error) {
      if (!error.rejected) { client.close(); clients.delete(key); }
      throw error;
    }
  }
  if (typeof tokenFile !== 'string') throw new Error('Joppa needs mcpCommand or a token file');
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
        redirect: 'manual', signal: AbortSignal.any([total,
          ...(method === 'tools/call' ? [] : [AbortSignal.timeout(30_000)]), ...(signal ? [signal] : [])])});
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Joppa MCP HTTP ${response.status}`);
      }
      session = response.headers.get('Mcp-Session-Id') || session;
      if (notification) { await response.body?.cancel(); return; }
      message = await responseMessage(response, id);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (/^Joppa (MCP HTTP \d+|response exceeds 8 MiB)$/.test(error.message)) throw error;
      throw new Error('Joppa MCP transport failed');
    }
    if (!object(message) || message.id !== id) throw new Error('Joppa returned a different MCP response');
    if ('error' in message || !('result' in message)) throw new Error('Joppa rejected the MCP operation');
    return message.result;
  }

  try {
    const initialized = await rpc('initialize', {protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: {name: 'crew-joppa', version: '1'}});
    if (!object(initialized)) throw new Error('Joppa returned an invalid initialization');
    protocol = initialized.protocolVersion || '2025-03-26';
    await rpc('notifications/initialized', {}, true);
    const result = await rpc('tools/call', {name: tool, arguments: arguments_});
    return toolValue(result, tool, token);
  } finally {
    if (session) {
      try {
        const response = await fetch(endpoint, {method: 'DELETE', redirect: 'manual',
          headers: {Authorization: `Bearer ${token}`, 'Mcp-Session-Id': session,
            'MCP-Protocol-Version': protocol || '2025-03-26'}, signal: AbortSignal.timeout(2000)});
        await response.body?.cancel();
      } catch {}
    }
  }
}

const authoredLink = link => ({blocking: link.blocking ?? false, relation: link.relation ?? 'related',
  revision: link.revision ?? null, target: link.target});

function normalizeDetail(args, value) {
  const result = {...value};
  if (!object(result.document)) {
    if (!object(result.data) || !Number.isSafeInteger(result.revision) || result.revision < 1) {
      throw new Error('Joppa object detail is incomplete');
    }
    result.document = {revision: result.revision, parent: result.parent ?? null, present: result.present ?? true,
      data: result.data, links: (result.links || []).map(authoredLink)};
    result.current_revision ??= result.revision;
    if (!args.revision) {
      result.review_required ??= false;
      result.work_ready ??= true;
    }
  }
  result.address ??= args.address;
  result.kind ??= result.address.split(':', 1)[0];
  result.historical ??= result.document.revision !== undefined && result.document.revision !== result.current_revision;
  if (!args.revision) result.contract_revision ??= result.current_revision;
  result.process = {...result.process};
  result.process.assignee ??= null;
  result.annotations = {...result.annotations};
  result.files ??= [];
  result.references ??= [];
  result.remote_links_revision ??= 0;
  return result;
}

async function completeDetail(args, value, readPage) {
  const result = normalizeDetail(args, value);
  if (!object(result.comments)) return result;
  const comments = {}, seen = new Set(), total = result.comments.total;
  const {comments_cursor, ...firstArgs} = args;
  const first = comments_cursor ? normalizeDetail(firstArgs, await readPage(firstArgs)) : result;
  let page = first, paged = false;
  const sameObject = other => other.address === result.address && other.current_revision === result.current_revision &&
    JSON.stringify(other.document) === JSON.stringify(result.document);
  for (;;) {
    if (!sameObject(page)) throw new Error('Joppa object changed during comment read');
    if (!Array.isArray(page.comments?.items)) throw new Error('Joppa comment page is incomplete');
    for (const comment of page.comments.items) {
      if (typeof comment.id !== 'string' || Object.hasOwn(comments, comment.id)) throw new Error('Joppa comment page overlaps');
      comments[comment.id] = comment;
    }
    const cursor = page.comments.next_cursor;
    if (!cursor) break;
    if (seen.has(cursor)) throw new Error('Joppa comment pagination did not advance');
    seen.add(cursor);
    page = normalizeDetail(args, await readPage({...args, comments_cursor: cursor}));
    paged = true;
  }
  if (Number.isInteger(total) && Object.keys(comments).length !== total) throw new Error('Joppa comment list is incomplete');
  if (paged) {
    const check = normalizeDetail(firstArgs, await readPage(firstArgs));
    if (!sameObject(check) || JSON.stringify(check.comments) !== JSON.stringify(first.comments)) {
      throw new Error('Joppa comments changed during read');
    }
  }
  result.annotations.comments = comments;
  delete result.comments;
  return result;
}

function normalizeTests(args, result) {
  const targets = (args.ac || '').split(',').filter(Boolean);
  if (targets.length === 1 && !result.items) result.address ??= targets[0];
  for (const row of result.items || [result]) {
    row.tests_draft ??= false;
    if (!args.summary) row.tests ??= [];
  }
}

function normalizeTasks(result) {
  const lean = !result.tasks && Array.isArray(result.items);
  result.tasks ??= result.items || [];
  if (lean) for (const row of result.tasks) {
    row.ac ??= row.parent;
    row.claimable ??= false;
    row.review_required ??= false;
  }
}
