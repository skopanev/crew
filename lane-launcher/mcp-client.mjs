import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const maxBytes = 8 * 1024 * 1024;
const children = new Set();
const signalChild = (child, signal) => {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
};
const groupAlive = child => {
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};
const stopClients = () => {
  for (const child of children) signalChild(child, 'SIGKILL');
};
const onInterrupt = () => stopOnSignal('SIGINT', onInterrupt);
const onTerminate = () => stopOnSignal('SIGTERM', onTerminate);
function stopOnSignal(signal, handler) {
  stopClients();
  if (process.listenerCount(signal) === 1) {
    process.off(signal, handler);
    process.kill(process.pid, signal);
  }
}
function track(child) {
  if (!children.size) {
    process.once('exit', stopClients);
    process.prependListener('SIGINT', onInterrupt);
    process.prependListener('SIGTERM', onTerminate);
  }
  children.add(child);
}
function untrack(child) {
  children.delete(child);
  if (!children.size) {
    process.off('exit', stopClients);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}

export function McpClient(argv, options = {}) {
  if (!(this instanceof McpClient)) return new McpClient(argv, options);
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || !arg.trim() || arg.includes('\0'))) {
    throw new Error('MCP client needs a command argv array of plain strings');
  }
  this.argv = [...argv];
  this.limit = options.maxBytes ?? maxBytes;
  this.defaultTimeoutMs = options.timeoutMs ?? 120_000;
  this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 30_000;
  this.sequence = 0;
  this.child = null;
  this.initPromise = null;
  this.protocolVersion = null;
  this.closed = false;
  this.pending = new Map();
  this.buffer = '';
  this.bufferBytes = 0;
  this.decoder = new StringDecoder('utf8');
}

McpClient.prototype._syncRef = function () {
  if (!this.child) return;
  if (this.pending.size > 0) {
    this.child.ref();
    this.child.stdout?.ref?.();
    this.child.stderr?.ref?.();
  } else {
    this.child.unref();
    this.child.stdin?.unref?.();
    this.child.stdout?.unref?.();
    this.child.stderr?.unref?.();
  }
};

McpClient.prototype._failAll = function (error) {
  const entries = [...this.pending.values()];
  this.pending.clear();
  this.initPromise = null;
  const child = this.child;
  this.child = null;
  this.buffer = '';
  this.bufferBytes = 0;
  this.decoder = new StringDecoder('utf8');
  if (child) {
    try { child.stdin?.end(); } catch {}
    signalChild(child, 'SIGTERM');
    const forget = () => untrack(child);
    const killer = setTimeout(() => { signalChild(child, 'SIGKILL'); forget(); }, 1000);
    child.once('close', () => {
      if (!groupAlive(child)) { clearTimeout(killer); forget(); }
    });
  }
  for (const entry of entries) {
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    entry.reject(error);
  }
};

McpClient.prototype._spawn = function () {
  if (this.child) return;
  const child = spawn(this.argv[0], this.argv.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: process.platform !== 'win32',
  });
  this.child = child;
  if (child.pid) track(child);
  this.buffer = '';
  this.bufferBytes = 0;
  this.decoder = new StringDecoder('utf8');

  child.stderr.on('data', () => {
    // Drain stderr so the child never blocks on a full pipe.
  });
  child.stdin.on('error', () => {
    if (this.child === child) this._failAll(new Error('Joppa MCP transport failed'));
  });

  child.stdout.on('data', chunk => {
    if (this.child !== child) return;
    this.bufferBytes += chunk.byteLength;
    if (this.bufferBytes > this.limit) {
      this._failAll(new Error('Joppa response exceeds 8 MiB'));
      return;
    }
    this.buffer += this.decoder.write(chunk);
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const raw = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.bufferBytes = Buffer.byteLength(this.buffer, 'utf8');
      if (!raw.trim()) continue;
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        this._failAll(new Error('Joppa MCP transport failed'));
        return;
      }
      if (!object(message)) {
        this._failAll(new Error('Joppa returned a different MCP response'));
        return;
      }
      if ('method' in message && !('id' in message)) continue;
      if ('method' in message && 'id' in message) {
        const reply = message.method === 'ping'
          ? {jsonrpc: '2.0', id: message.id, result: {}}
          : {jsonrpc: '2.0', id: message.id, error: {code: -32601, message: 'Method not found'}};
        try { child.stdin.write(JSON.stringify(reply) + '\n'); } catch {}
        continue;
      }
      const entry = this.pending.get(message.id);
      if (!entry) {
        this._failAll(new Error('Joppa returned a different MCP response'));
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      this._syncRef();
      if ('error' in message || !('result' in message)) {
        const error = new Error('Joppa rejected the MCP operation');
        error.rpcError = message.error;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
    }
  });

  const onExit = () => {
    if (this.child !== child) return;
    this._failAll(new Error('Joppa MCP transport failed'));
  };
  child.once('error', onExit);
  child.once('exit', onExit);
  child.once('close', onExit);
  this._syncRef();
};

McpClient.prototype._send = function (method, params = {}, {timeoutMs, signal} = {}) {
  if (this.closed) return Promise.reject(new Error('Joppa MCP client is closed'));
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Joppa MCP transport failed'));
  this._spawn();
  const id = ++this.sequence;
  const payload = JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n';
  const duration = timeoutMs ?? (method === 'tools/call' ? this.defaultTimeoutMs : this.handshakeTimeoutMs);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      this._failAll(new Error('Joppa MCP transport failed'));
    }, duration);
    const onAbort = () => {
      this._failAll(signal.reason ?? new Error('Joppa MCP transport failed'));
    };
    if (signal) signal.addEventListener('abort', onAbort, {once: true});
    this.pending.set(id, {resolve, reject, timer, signal, onAbort});
    this._syncRef();
    try {
      this.child.stdin.write(payload);
    } catch {
      this._failAll(new Error('Joppa MCP transport failed'));
    }
  });
};

McpClient.prototype._ensureInitialized = function (options = {}) {
  if (this.closed) return Promise.reject(new Error('Joppa MCP client is closed'));
  if (this.child && this.initPromise) return this.initPromise;
  this._spawn();
  const child = this.child;
  const promise = (async () => {
    const initialized = await this._send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {name: 'crew-joppa', version: '1'},
    }, {timeoutMs: options.timeoutMs ?? this.handshakeTimeoutMs, signal: options.signal});
    if (!object(initialized)) {
      throw new Error('Joppa returned an invalid initialization');
    }
    this.protocolVersion = initialized.protocolVersion || '2025-03-26';
    if (this.child !== child) throw new Error('Joppa MCP transport failed');
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized', params: {}}) + '\n');
    return initialized;
  })().catch(error => {
    if (this.initPromise === promise) this._failAll(error);
    throw error;
  });
  this.initPromise = promise;
  return promise;
};

McpClient.prototype.request = async function (method, params = {}, options = {}) {
  if (this.closed) throw new Error('Joppa MCP client is closed');
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('Joppa MCP transport failed');
  if (typeof method !== 'string' || !method.trim()) throw new Error('MCP request needs a method name');
  const initialized = await this._ensureInitialized(options);
  if (method === 'initialize') return initialized;
  return this._send(method, params, options);
};

McpClient.prototype.close = function () {
  this.closed = true;
  this._failAll(new Error('Joppa MCP client is closed'));
};
