// Operator requests are immutable until consumed. Repeated requests coalesce per profile.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {plannerConfig} from './planner-config.mjs';
import {normalizeSlots} from './slots.mjs';
import {save} from '../lane-launcher/runtime.mjs';

const profiles = config => {
  const native = normalizeSlots(config), inputs = native.inputs || [native];
  return inputs.map((profile, input) => ({input,
    slot: profile.slot || (inputs.length === 1 ? 'default' : `input ${input + 1}`),
    batch: profile.batch ?? native.batch}));
};
const filename = (root, slot) => path.join(root, `flush-${createHash('sha256').update(slot).digest('hex')}.request`);
const readRequest = (file, profile) => {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.id) || value.slot !== profile.slot ||
      !Number.isFinite(Date.parse(value.requested_at))) throw new Error('Invalid flush request: ' + path.basename(file));
  return {...value, input: profile.input, file};
};

export function requestFlush(configFile, target = 'all') {
  const {config, root} = plannerConfig(path.resolve(configFile));
  if (!config.workflow) throw new Error('Flush needs a configured workflow');
  const selected = profiles(config).filter(profile => target === 'all' || profile.slot === target);
  if (!selected.length) throw new Error('Unknown flush slot: ' + target);
  if (selected.some(profile => !profile.batch)) throw new Error('Flush needs configured batches');
  fs.mkdirSync(root, {recursive: true});
  return selected.map(profile => {
    const file = filename(root, profile.slot), temporary = path.join(root, `.flush-${randomUUID()}.tmp`);
    const request = {id: randomUUID(), slot: profile.slot, input: profile.input, requested_at: new Date().toISOString()};
    fs.writeFileSync(temporary, JSON.stringify(request) + '\n', {flag: 'wx', mode: 0o600});
    try {
      // Publish a complete request without replacing a request another process can consume.
      while (true) {
        try { fs.linkSync(temporary, file); return {...request, file}; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        try { return readRequest(file, profile); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } finally { fs.unlinkSync(temporary); }
  });
}

export function pendingFlush(config, root) {
  return profiles(config).flatMap(profile => {
    const file = filename(root, profile.slot);
    try { return [readRequest(file, profile)]; }
    catch (error) {
      if (error.code !== 'ENOENT') console.error('Flush request ignored: ' + path.basename(file));
      return [];
    }
  });
}

export function consumeFlush(request) {
  try {
    if (JSON.parse(fs.readFileSync(request.file, 'utf8')).id !== request.id) return false;
    fs.unlinkSync(request.file);
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function forcedConfig(config) {
  if (!config.batch) throw new Error('Flush needs a configured batch');
  return {...config, batch: {...config.batch, min_size: 1}};
}

export function freezeFlush(raw, input, request) {
  if (!request) return raw;
  const config = JSON.parse(raw);
  if (config.slots) {
    if (!config.slots[input]) throw new Error('Flush slot is missing');
    const slot = config.slots[input];
    config.slots[input] = {...slot, batch: {...config.batch, ...slot.batch, min_size: 1}};
  } else if (config.inputs) {
    if (!config.inputs[input]) throw new Error('Flush input is missing');
    config.inputs[input] = {...config.inputs[input], batch: {...(config.inputs[input].batch ?? config.batch), min_size: 1}};
  } else config.batch = forcedConfig(config).batch;
  config.flush_request = {id: request.id, slot: request.slot, input};
  return Buffer.from(JSON.stringify(config));
}

export function inlineFlushSnapshot(root, args, env, address, attemptKey, metadata) {
  if (!metadata.flush) return null;
  const index = args.indexOf('--config') + 1, raw = fs.readFileSync(args[index]);
  if (createHash('sha256').update(raw).digest('hex') !== env.PLANNING_JOPPA_HANDOFF_DIGEST) return {refused: true};
  const input = Number(env.PLANNING_JOPPA_INPUT ?? 0), frozen = freezeFlush(raw, input, metadata.flush);
  const stamp = new Date().toLocaleString('sv-SE').replace(' ', '_').replaceAll(':', '-');
  const folder = path.join(root, `${stamp}-${randomUUID()}`), file = path.join(folder, 'launch.json');
  fs.mkdirSync(folder, {recursive: true, mode: 0o700});
  const command = [...args]; command[index] = path.join(folder, 'config.json');
  fs.writeFileSync(command[index], frozen, {mode: 0o600});
  const record = {address, input, attemptKey, dispatcherId: metadata.owner, dispatcherPid: process.pid,
    slot: metadata.slot, flush_request: metadata.flush, args: command, createdAt: new Date().toISOString()};
  save(file, record);
  return {folder, file, record, args: command,
    env: {...env, PLANNING_JOPPA_HANDOFF_DIGEST: createHash('sha256').update(frozen).digest('hex')}};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [file, target = 'all', ...extra] = process.argv.slice(2);
    if (!file || extra.length) throw new Error('Usage: sh lane-launcher/lander.sh flush CONFIG [slot-label|all]');
    console.log('flush requested: ' + requestFlush(file, target).map(request => request.slot).join(' · '));
  } catch (error) { console.error('lander flush: ' + error.message); process.exitCode = 2; }
}
