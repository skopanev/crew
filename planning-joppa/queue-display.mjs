// Count captured active units from existing run inputs and their frozen config.
import fs from 'node:fs';
import path from 'node:path';
import {normalizeSlots} from './slots.mjs';
import {batchField, batchQueue} from './flow-batch.mjs';

const read = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const folder = run => run.folder || run.current?.folder;

export function landingQueue(rows, config, active = []) {
  const units = [], captured = new Set();
  for (const row of rows.filter(row => row.active)) {
    captured.add(row.runFolder);
    let label = row.slot || null;
    try {
      const launch = read(path.join(row.runFolder, 'launch.json'));
      const input = read(path.join(launch?.medullaRun || row.runFolder, 'artifacts/input.json'));
      const raw = read(path.join(row.runFolder, 'config.json')) ||
        (!launch && active.some(run => folder(run) === row.runFolder) ? config : null);
      if (!raw || !input) { units.push([label, null]); continue; }
      const normalized = normalizeSlots(raw);
      const index = input.input ?? launch?.input ?? normalized.inputs?.findIndex(profile => profile.slot === row.slot);
      const profile = normalized.inputs ? normalized.inputs[index] && {...normalized, ...normalized.inputs[index]} : normalized;
      if (!profile || row.slot && profile.slot !== row.slot) { units.push([label, null]); continue; }
      const batch = profile.batch;
      const items = batch ? input.items : [input.selected];
      label = profile.slot || (batch?.by ? batchField(input.selected, batch.by) ?? null : label);
      if (label !== null) label = String(label);
      if (!items?.length || items.some(item => !item?.address || batch?.unit_field &&
          (typeof batchField(item, batch.unit_field) !== 'string' || !batchField(item, batch.unit_field)))) {
        units.push([label, null]); continue;
      }
      units.push(...batchQueue(batch, items, [], profile.slot));
    } catch { units.push([label, null]); }
  }
  for (const run of active) if (!captured.has(folder(run))) units.push([run.slot || null, null]);
  return units;
}
