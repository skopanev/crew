// Criteria that a Task covers besides its parent, through the configured Task reference joppa.coversReference.
import {nodeAssignee, nodeWaiting} from './joppa-nodes.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };

// Return {field, target} for the Task type, or null when the feature is off.
export function coversSpec(config, types, taskKind) {
  const field = config.joppa?.coversReference;
  if (field === undefined || field === null) return null;
  const reference = types?.[taskKind]?.references?.[field];
  require(reference && reference.multiple === true && types[reference.target]?.role === 'ac',
    `Task reference ${field} must list several criteria of the criterion type`);
  return {field, target: reference.target};
}

// Full addresses of the covered criteria. A bare ID that Joppa stored as sent reads as the target type address.
export function taskCovers(spec, object) {
  const value = object?.document?.data?.[spec?.field];
  if (!spec || value === undefined || value === null) return [];
  require(Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim()),
    `Task reference ${spec.field} must be a list of criterion addresses`);
  const parent = object.document.parent;
  return [...new Set(value.map(item => item.includes(':') ? item : `${spec.target}:${item}`))]
    .filter(address => address !== parent);
}

// A covered criterion must be current, present, not waiting, unassigned and free of unmet dependencies.
export function coveredProblem(object, address, dependency, requirement) {
  if (object?.address !== address || object.historical !== false || object.document?.present !== true ||
      !Number.isSafeInteger(object.current_revision)) return `${address} is absent or historical`;
  if (requirement !== undefined && object.document.parent !== requirement) {
    return `${address} belongs to another Requirement`;
  }
  if (nodeWaiting(object)) return `${address} is waiting`;
  if (nodeAssignee(object)) return `${address} is held by ${nodeAssignee(object)}`;
  if (!dependency?.ready) return `${address} waits for ${dependency?.blocker}`;
  return null;
}
