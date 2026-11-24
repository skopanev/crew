import {validateNodeFilter} from '../lane-launcher/task-filter.mjs';
import {nodePendingDelivery} from '../lane-launcher/joppa-nodes.mjs';
import {batchField} from './flow-batch.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

export function nativeChildFilter(value) {
  const valid = value !== null && typeof value === 'object' && !Array.isArray(value);
  const {kind, except_pending_tag: exceptTag, ...filters} = valid ? value : {};
  if (!valid || kind !== undefined && ![kind].flat().every(item => typeof item === 'string' && item.trim()) ||
      'parent' in filters || 'depth' in filters) {
    throw new Error('exclude_children needs native child filters without parent or depth');
  }
  validateNodeFilter(filters, 'exclude_children');
  if (exceptTag !== undefined && (typeof exceptTag !== 'string' || !exceptTag || exceptTag.trim() !== exceptTag)) {
    throw new Error('exclude_children.except_pending_tag needs a nonempty tag without surrounding spaces');
  }
  if (exceptTag && Object.keys(filters).some(key => key !== 'data')) throw new Error('A child exception supports kind and data filters');
  return {nativeFilter: {...(kind === undefined ? {} : {kind}), ...filters}, exceptTag,
    fields: ['parent', ...(exceptTag ? ['data.tags', 'data.delivery', 'data.assignee'] : [])]};
}

export function excludesChild(item, parent, exceptTag) {
  const tags = batchField(item, 'data.tags');
  return item.parent === parent && !(exceptTag && !batchField(item, 'data.assignee') && nodePendingDelivery(item) && Array.isArray(tags) && tags.includes(exceptTag));
}

const contains = (actual, expected) => Array.isArray(expected) ? Array.isArray(actual) && expected.every(value => actual.some(item => contains(item, value))) :
  expected && typeof expected === 'object' ? actual && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => contains(actual[key], value)) :
  isDeepStrictEqual(actual, expected);

export function ignoredChild(item, filters) {
  return [filters ?? []].flat().some(filter => {
    const {nativeFilter, exceptTag} = nativeChildFilter(filter);
    return exceptTag && (!nativeFilter.kind || [nativeFilter.kind].flat().includes(item.kind)) &&
      contains(batchField(item, 'data'), nativeFilter.data ?? {}) &&
      !excludesChild({...item, parent: 'selected'}, 'selected', exceptTag);
  });
}

export function activeChildren(input, config) {
  const active = [config.vars?.TASK_STAGE, config.vars?.TASKER_TASK_REVIEW_STAGE, config.vars?.TASKER_WORKING_STAGE].filter(Boolean);
  return (input.children ?? []).filter(item => input.schema.types[item.kind]?.role === 'task' &&
    (item.document?.present ?? item.present) !== false && (batchField(item, 'data.assignee') ||
      !ignoredChild(item, config.exclude_children) && active.includes(batchField(item, 'data.stage'))))
    .map(item => item.address);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== 'active') throw new Error('Use active INPUT CONFIG');
    const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(activeChildren(read(process.argv[3]), read(process.argv[4])).join(', '));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
