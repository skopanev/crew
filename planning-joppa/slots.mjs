// Configured slots reuse the existing input profiles and run records.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {batchSettings} from './flow-batch.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const need = (ok, message) => { if (!ok) throw new Error('slots: ' + message); };
const clone = value => JSON.parse(JSON.stringify(value));
const merge = (base, extra) => Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(extra)])]
  .map(key => [key, Object.hasOwn(extra, key) ? object(base[key]) && object(extra[key]) ?
    merge(base[key], extra[key]) : clone(extra[key]) : clone(base[key])]));

export function normalizeSlots(config) {
  if (config.slots === undefined) return config;
  need(!config.inputs, 'use slots or inputs, not both');
  need(config.workflow && object(config.selection), 'configure a workflow and a common selection');
  need(Array.isArray(config.slots) && config.slots.length > 0, 'configure at least one slot');
  batchSettings(config.batch);
  const labels = new Set();
  const inputs = config.slots.map(slot => {
    need(object(slot) && Object.keys(slot).every(key => ['label', 'data', 'batch'].includes(key)), 'a slot needs label, data and optional batch');
    need(typeof slot.label === 'string' && slot.label.trim() === slot.label && slot.label &&
      !/[\x00-\x1f\x7f]/.test(slot.label) && !labels.has(slot.label), 'labels must be unique nonempty single-line strings');
    need(object(slot.data), 'slot data must be a native filter object');
    need(slot.batch === undefined || object(slot.batch), 'slot batch must be an object');
    const batch = slot.batch === undefined ? undefined : batchSettings({...clone(config.batch || {}), ...clone(slot.batch)});
    labels.add(slot.label);
    return {slot: slot.label, ...(batch ? {batch} : {}), selection: {...clone(config.selection),
      data: merge(config.selection.data || {}, slot.data)}};
  });
  const {slots, ...base} = config;
  return {...base, concurrency: config.concurrency ?? inputs.length, inputs};
}

export const hasSlots = config => Boolean(config?.inputs?.some(profile => profile.slot !== undefined));

export function occupiedSlots(config, rows, active) {
  if (!hasSlots(config)) return null;
  const labels = new Set(config.inputs.map(profile => profile.slot));
  const runs = new Map();
  for (const row of rows) {
    if (row.slotUncertain) throw new Error('Slot admission: prior run state is unknown');
    if (row.active) runs.set(row.runFolder, row.slot);
  }
  for (const run of active) runs.set(run.folder || run.current?.folder || run.address, run.slot);
  const occupied = new Map([...labels].map(label => [label, 0]));
  for (const label of runs.values()) {
    need(labels.has(label), 'an active run has no current slot label; wait for it to finish');
    occupied.set(label, (occupied.get(label) || 0) + 1);
  }
  return occupied;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { process.stdout.write(JSON.stringify(normalizeSlots(JSON.parse(fs.readFileSync(0, 'utf8'))))); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
