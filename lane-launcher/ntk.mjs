// Internal HTTP client. The only public command is ntk-status.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function credentials(env = process.env) {
  const file = env.NTK_CONFIG || path.join(os.homedir(), '.config/ntk/config.json');
  let config = {};
  if (fs.existsSync(file)) {
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error(`Cannot read NTK credentials JSON: ${file}`); }
  }
  const key = env.NTK_KEY || config.key;
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error(`NTK key missing: set NTK_KEY or the key field in ${file}`);
  }
  const url = new URL(env.NTK_URL || config.url || 'https://ntk.otion.us');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
    throw new Error('NTK needs HTTPS (HTTP is allowed only on loopback)');
  }
  if (url.username || url.password) throw new Error('Use NTK_KEY for credentials, not the URL');
  return {url: url.href, key};
}

export async function request(method, route, query, body, auth = credentials()) {
  const url = new URL(route, auth.url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  try {
    const response = await fetch(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: {'Authorization': `Bearer ${auth.key}`, 'Accept': 'application/json',
        ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    if (response.status === 204) return null;
    const text = await response.text();
    if (!response.ok) {
      let reason = '';
      try { reason = JSON.parse(text).error || ''; } catch { /* Do not echo proxy HTML. */ }
      throw new Error(`NTK HTTP ${response.status}${reason ? `: ${reason}` : ''}; no automatic retry`);
    }
    return JSON.parse(text);
  } catch (error) {
    // Do not echo credentials even if a misconfigured server echoes the request.
    throw new Error(String(error.message).split(auth.key).join('[redacted]'));
  }
}

const ticketRoute = id => `/v1/tickets/${encodeURIComponent(id)}`;
export async function getTicket(id, workspace) {
  const response = await request('GET', ticketRoute(id), {workspace});
  if (!response?.ticket?.id) throw new Error('NTK returned no ticket');
  return response.ticket;
}
export const nextTicket = query => request('POST', '/v1/tickets/next', {...query, dry_run: true});
export const claimTicket = (id, workspace) => request('POST', `${ticketRoute(id)}/start`, {workspace});
export function updateStatus({id, workspace, status, force, tagEdits}) {
  if (status === 'in_progress') throw new Error('Use claimTicket to enter in_progress atomically');
  return request('PATCH', ticketRoute(id), {}, {workspace, status, ...(force ? {force: true} : {}),
    ...(tagEdits ? {tag_edits: tagEdits} : {})});
}

async function settleStartupClaim(claim, status, tagEdits) {
  if (claim?.claimed !== true || claim.status !== 'in_progress' || !claim.id || !claim.workspace) {
    throw new Error('No confirmed startup claim; ticket unchanged');
  }
  const ticket = await getTicket(claim.id, claim.workspace);
  if (ticket.status !== 'in_progress' || ticket.id.toLowerCase() !== claim.id.toLowerCase()) {
    throw new Error('Ticket changed after claim; ticket unchanged');
  }
  return updateStatus({id: claim.id, workspace: claim.workspace, status, force: true, tagEdits});
}
export const reopenStartupClaim = claim => settleStartupClaim(claim, 'open');
export const blockStartupClaim = claim => settleStartupClaim(claim, 'blocked', ['+worktree_preexistited']);

export async function attachReport(id, workspace, filename, content) {
  const bytes = Buffer.from(content, 'utf8');
  const content_type = 'text/plain; charset=utf-8';
  const upload = await request('POST', `${ticketRoute(id)}/attachments`, {},
    {workspace, filename, size_bytes: bytes.length, content_type});
  const url = new URL(upload.url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('NTK attachment upload requires HTTPS');
  }
  // Signed upload URL is its own credential. Never send the NTK key to storage.
  try {
    const response = await fetch(url, {method: 'PUT', body: bytes,
      headers: {'Content-Type': content_type}, redirect: 'error', signal: AbortSignal.timeout(30_000)});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    throw new Error('NTK report upload failed; report retained locally');
  }
  return request('POST', `${ticketRoute(id)}/attachments/commit`, {},
    {workspace, object_key: upload.object_key, filename, content_type});
}
