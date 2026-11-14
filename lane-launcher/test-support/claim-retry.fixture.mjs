// A fault proxy around the existing Joppa fixture. Its receipts model Joppa's atomic replay contract.
import http from 'node:http';
import {setTimeout as sleep} from 'node:timers/promises';
import {packageFixture} from './launcher-joppa.fixture.mjs';

export async function retryFixture(t, delays = [1]) {
  const f = await packageFixture(t), upstream = f.run.config.joppa.url;
  f.run.tasks = [f.run.tasks[0]];
  f.run.config.joppa.claimRetryDelaysSeconds = delays;
  const control = {before: 0, after: 0, requests: [], receipts: new Map(), mutations: 0};
  const server = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    let body = '';
    for await (const part of req) body += part;
    const message = JSON.parse(body), batch = message.params?.name === 'joppa_batch';
    const args = message.params?.arguments;
    const reply = result => res.end(JSON.stringify({jsonrpc: '2.0', id: message.id, result}));
    const forward = async () => {
      const response = await fetch(upstream, {method: 'POST', headers: {'Content-Type': 'application/json'}, body});
      if (response.status === 204) return null;
      const received = await response.json();
      if (batch && !received.result.isError) {
        control.mutations++;
        control.receipts.set(args.request_id, {input: JSON.stringify(args), result: structuredClone(received.result)});
        control.afterCommit?.();
      }
      return received;
    };
    res.setHeader('Content-Type', 'application/json');
    if (batch) {
      control.requests.push(structuredClone(args));
      if (control.rpcCode !== undefined) {
        res.end(JSON.stringify({jsonrpc: '2.0', id: message.id, error: {code: control.rpcCode, message: 'Maintenance'}})); return;
      }
      if (control.overlap && !control.pending) {
        control.pending = (async () => { await sleep(1500); return forward(); })();
        req.socket.destroy(); return;
      }
      if (control.pending) { control.overlapped = true; await control.pending; }
      if (control.hang) { control.entered?.(); return; }
      if (control.reject || control.refuseReplay && control.receipts.has(args.request_id)) {
        reply({isError: true, structuredContent: {error: 'Application refused: Joppa MCP transport failed'}}); return;
      }
      if (control.before > 0) {
        control.before--;
        control.onDrop?.();
        req.socket.destroy(); return;
      }
      const cached = control.receipts.get(args.request_id);
      if (cached) {
        if (cached.input !== JSON.stringify(args)) {
          reply({isError: true, structuredContent: {error: 'request_id reused with different content'}}); return;
        }
        reply(cached.result); return;
      }
    }
    const received = await forward();
    if (!received) { res.writeHead(204).end(); return; }
    if (batch && !received.result.isError) {
      if (control.after > 0) { control.after--; req.socket.destroy(); return; }
      if (control.invalid) received.result.structuredContent.results.pop();
    }
    reply(received.result);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  f.run.config.joppa.url = `http://127.0.0.1:${server.address().port}`;
  return {...f, control};
}
