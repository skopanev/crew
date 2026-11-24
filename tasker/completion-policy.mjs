import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function blockingTask(input, node, stages) {
  const data = node.document?.data ?? node.data ?? {};
  return input.schema.types[node.kind]?.role === 'task' && (node.document?.present ?? node.present) &&
    (data.assignee || stages.active.includes(data.stage) && !stages.ignore?.(node));
}

export async function completionPolicy(config, runtime) {
  const stages = {ready: config.vars.TASKER_READY_STAGE, implement: config.vars.TASKER_IMPLEMENT_STAGE,
    done: config.vars.TASKER_DONE_STAGE, active: [config.vars.TASK_STAGE, config.vars.TASKER_TASK_REVIEW_STAGE,
      ...(config.vars.TASKER_WORKING_STAGE ? [config.vars.TASKER_WORKING_STAGE] : [])]};
  if (!Object.values(stages).flat().every(value => typeof value === 'string' && value)) throw new Error('Configure Tasker stages');
  if (![config.exclude_children ?? []].flat().some(filter => filter.except_pending_tag)) return stages;
  const {ignoredChild} = await import(pathToFileURL(path.join(runtime, 'planning-joppa/child-filter.mjs')).href);
  stages.ignore = node => ignoredChild(node, config.exclude_children);
  return stages;
}
