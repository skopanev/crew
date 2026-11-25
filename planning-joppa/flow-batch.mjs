// Optional batch waiting uses the configured timestamp or producer locks.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {alive, readRun} from '../lane-launcher/runtime.mjs';

const fieldName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(value);
const lockGlob = value => typeof value === 'string' && path.isAbsolute(value) && !value.endsWith(path.sep) &&
  value.split(path.sep).every(part => !['.', '..'].includes(part) && (part === '*' || !/[*?\[\]{}\0]/.test(part)));

// A missing producer root or an unreadable lock cannot prove that the producer is idle.
export function producerIdle(pattern) {
  if (!lockGlob(pattern)) return false;
  try {
    const parts = pattern.split(path.sep).filter(Boolean);
    const first = parts.indexOf('*'), start = first < 0 ? parts.length - 1 : first;
    const root = path.join(path.parse(pattern).root, ...parts.slice(0, start));
    if (!fs.statSync(root).isDirectory()) return false;
    let folders = [root];
    for (const part of parts.slice(start)) {
      const next = [];
      for (const folder of folders) {
        const names = part === '*' ? fs.readdirSync(folder) : [part];
        for (const name of names) {
          const candidate = path.join(folder, name), stat = fs.lstatSync(candidate, {throwIfNoEntry: false});
          if (!stat) continue;
          if (stat.isSymbolicLink()) return false;
          if (stat.isDirectory()) next.push(candidate);
          else if (part !== '*') return false;
        }
      }
      folders = next;
    }
    return folders.every(lock => {
      const run = readRun(path.join(path.dirname(lock), 'launch.json'));
      const pid = run.worker?.pid;
      return Number.isSafeInteger(pid) && pid > 0 && !alive(pid);
    });
  } catch { return false; }
}

export function batchSettings(batch) {
  if (batch === undefined) return null;
  if (!batch || typeof batch !== 'object' || Array.isArray(batch) ||
      Object.keys(batch).some(key => !['size', 'by', 'unit_field', 'min_size', 'max_wait_seconds', 'age_field', 'flush_when_idle'].includes(key)) ||
      !Number.isSafeInteger(batch.size) || batch.size < 1 || batch.size > 50 ||
      batch.by !== undefined && !fieldName(batch.by) ||
      batch.unit_field !== undefined && !fieldName(batch.unit_field) ||
      batch.min_size !== undefined && (!Number.isSafeInteger(batch.min_size) || batch.min_size < 1 || batch.min_size > batch.size) ||
      batch.max_wait_seconds !== undefined && (!Number.isSafeInteger(batch.max_wait_seconds) || batch.max_wait_seconds < 1) ||
      (batch.max_wait_seconds !== undefined) !== (batch.age_field !== undefined) ||
      batch.age_field !== undefined && !fieldName(batch.age_field) ||
      batch.flush_when_idle !== undefined && !lockGlob(batch.flush_when_idle)) {
    throw new Error('batch needs size 1..50, min_size <= size, paired age fields, and an absolute flush_when_idle glob with whole * segments');
  }
  return batch;
}

export function batchField(item, name) {
  if (Object.hasOwn(item, name)) return item[name];
  const parts = name.split('.');
  const prefix = parts.slice(0, 2).join('.');
  if (Object.hasOwn(item, prefix)) return parts.slice(2).reduce((value, key) => value?.[key], item[prefix]);
  return name.split('.').reduce((value, key) => value?.[key], item.document ?? item);
}

export const batchProjection = name => name.startsWith('data.') ? name.split('.').slice(0, 2).join('.') : name;

export function batchQueue(batch, rows, excludeTags = []) {
  if (!batch?.by) return [];
  return rows.filter(row => !excludeTags.some(tag => (batchField(row, 'data.tags') || []).includes(tag)))
    .map(row => [String(batchField(row, batch.by) ?? '(unknown)'),
    String(batch.unit_field ? batchField(row, batch.unit_field) : row.address)]);
}

export function queueLabel(queue) {
  const groups = new Map();
  for (const [group, unit] of queue) {
    if (!groups.has(group)) groups.set(group, new Set());
    groups.get(group).add(unit);
  }
  const count = [...groups.values()].reduce((sum, units) => sum + units.size, 0);
  return `queue: ${count}` + (count ? ` (${[...groups].map(([group, units]) => `${group} ${units.size}`).join(' · ')})` : '');
}

export function batchItems(batch, rows) {
  if (!batch.unit_field) return rows.slice(0, batch.size);
  const units = new Map();
  for (const row of rows) {
    const unit = batchField(row, batch.unit_field);
    if (typeof unit !== 'string' || !unit) throw new Error('batch item lacks its unit field');
    if (!units.has(unit)) units.set(unit, []);
    units.get(unit).push(row);
  }
  const selected = [];
  let count = 0;
  for (const members of units.values()) {
    if (!count && members.length > 50) throw new Error('batch anchor unit exceeds the native 50-item claim limit');
    if (count === batch.size) break;
    if (selected.length + members.length > 50) continue;
    selected.push(...members); count++;
  }
  return selected;
}

export function batchReady(batch, rows, now = Date.now()) {
  const size = batch?.unit_field ? new Set(rows.map(row => batchField(row, batch.unit_field))).size : rows.length;
  if (!batch || size >= (batch.min_size ?? 1)) return true;
  if (!rows.length) return false;
  if (batch.flush_when_idle !== undefined) return producerIdle(batch.flush_when_idle);
  if (batch.max_wait_seconds === undefined) return false;
  return rows.some(row => {
    const value = batchField(row, batch.age_field), at = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(at) && now - at >= batch.max_wait_seconds * 1000;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = process.argv.length === 3 && producerIdle(process.argv[2]) ? 0 : 1;
}

export const batchCompare = order => (a, b) => {
  for (const {field, direction, values} of order) {
    let left = batchField(a, field) ?? null, right = batchField(b, field) ?? null;
    if (left === right) continue;
    if (left === null || right === null) return left === null ? 1 : -1;
    if (values) {
      const rank = value => { const index = values.indexOf(value); return index < 0 ? values.length : index; };
      left = rank(left); right = rank(right);
    }
    const result = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
    if (result) return direction === 'desc' ? -result : result;
  }
  return a.address.localeCompare(b.address);
};
