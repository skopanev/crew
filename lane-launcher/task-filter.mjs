// Joppa evaluates the filter. Crew keeps the workspace, Task kinds and pagination under its control.
import {taskPages} from './joppa-nodes.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = new Set(['data', 'parent', 'depth', 'status', 'owner', 'assignee']);

export function validateTaskFilter(config) {
  const filter = config.joppa?.filter;
  if (filter === undefined) return;
  if (!object(filter) || Object.keys(filter).some(key => !keys.has(key)) ||
      Object.hasOwn(filter, 'data') && !object(filter.data)) {
    throw new Error('joppa.filter must contain only native data, parent, depth, status, owner or assignee filters; data must be an object');
  }
}

// The revision from the filtered list must match the revision used by the claim save.
export async function filteredTasks(config, read, wanted) {
  validateTaskFilter(config);
  const filter = config.joppa?.filter;
  if (!filter || !Object.keys(filter).length) return null;
  const found = new Map();
  for await (const page of taskPages(read, {...filter, fields: ['revision']})) {
    for (const row of page.items) {
      if (!Number.isSafeInteger(row.revision) || row.revision < 1 || found.has(row.address)) {
        throw new Error('TASK_FILTER_INVALID: filtered Task list has an invalid or duplicate revision');
      }
      found.set(row.address, row.revision);
    }
    if (wanted?.every(address => found.has(address))) break;
  }
  return found;
}
