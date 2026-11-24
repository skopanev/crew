// Read each prerequisite again on the next selection pass. Create no run for waiting work.
import {dependencyCheck} from '../lane-launcher/dependencies.mjs';
import {nodeAssignee} from '../lane-launcher/joppa-nodes.mjs';

export function dependencySelection(read) {
  const reads = new Map();
  const current = (tool, args) => {
    const key = JSON.stringify([tool, args]);
    if (!reads.has(key)) reads.set(key, read(tool, args));
    return reads.get(key);
  };
  return async address => {
    const schema = (await current('joppa_tree', {}))?.schema;
    const selected = await current('joppa_objects', {address});
    if (selected?.address !== address || selected.historical !== false ||
        !Number.isSafeInteger(selected.current_revision) || !selected.document) {
      throw new Error('Dependency selection needs a current full object');
    }
    if (selected.document.present !== true || nodeAssignee(selected)) return false;
    const check = dependencyCheck(async (tool, args) => {
      const target = await current(tool, args);
      if (tool === 'joppa_objects' && args.address !== address && target?.address === args.address &&
          target.historical === false && Number.isSafeInteger(target.current_revision) &&
          schema?.types?.[target.kind]?.role === 'task' && target.document?.present === false &&
          !target.document.data?.commit) {
        throw Object.assign(new Error('Archived prerequisite needs plan repair'), {code: 'DEPENDENCY_REPLAN'});
      }
      return target;
    });
    try { return (await check(address)).ready; }
    catch (error) {
      if (error.code === 'DEPENDENCY_REPLAN') return !selected.document.data?.commit;
      throw error;
    }
  };
}
