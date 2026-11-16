// Optional batch waiting uses the timestamp field named by the configuration.
const fieldName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(value);
export function batchSettings(batch) {
  if (batch === undefined) return null;
  if (!batch || typeof batch !== 'object' || Array.isArray(batch) ||
      Object.keys(batch).some(key => !['size', 'by', 'unit_field', 'min_size', 'max_wait_seconds', 'age_field'].includes(key)) ||
      !Number.isSafeInteger(batch.size) || batch.size < 1 || batch.size > 50 ||
      batch.by !== undefined && !fieldName(batch.by) ||
      batch.unit_field !== undefined && !fieldName(batch.unit_field) ||
      batch.min_size !== undefined && (!Number.isSafeInteger(batch.min_size) || batch.min_size < 1 || batch.min_size > batch.size) ||
      batch.max_wait_seconds !== undefined && (!Number.isSafeInteger(batch.max_wait_seconds) || batch.max_wait_seconds < 1) ||
      (batch.max_wait_seconds !== undefined) !== (batch.age_field !== undefined) ||
      batch.age_field !== undefined && !fieldName(batch.age_field)) {
    throw new Error('batch needs size 1..50, optional by, min_size <= size, and max_wait_seconds with age_field');
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

export function batchReady(batch, rows, now = Date.now()) {
  const size = batch?.unit_field ? new Set(rows.map(row => batchField(row, batch.unit_field))).size : rows.length;
  if (!batch || size >= (batch.min_size ?? 1)) return true;
  if (!rows.length || batch.max_wait_seconds === undefined) return false;
  return rows.some(row => {
    const value = batchField(row, batch.age_field), at = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(at) && now - at >= batch.max_wait_seconds * 1000;
  });
}
