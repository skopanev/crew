// Approval selection only. Test coverage needs a separate review of the existing Test nodes.
import {nodePages, nodeAssignee, nodeWaiting} from '../lane-launcher/joppa-nodes.mjs';
import {validateNodeFilter} from '../lane-launcher/task-filter.mjs';

export async function approvedCriteria(config, read) {
  const settings = config.testAuthor;
  const field = settings?.approvalField;
  if (typeof field !== 'string' || !field.trim() || field !== field.trim() || field.includes('\0')) {
    throw new Error('Config needs testAuthor.approvalField: one native data field path');
  }
  validateNodeFilter(settings.filter, 'testAuthor.filter');
  const tree = await read('joppa_tree', {});
  if (!Array.isArray(tree.capabilities) || !tree.capabilities.includes('contract_hash:c1')) {
    throw new Error('CONTRACT_HASH_UNSUPPORTED: Joppa does not advertise contract_hash:c1');
  }
  const types = tree.schema?.types;
  if (!types || typeof types !== 'object') throw new Error('Joppa tree schema is missing');
  const kinds = Object.keys(types).filter(kind => types[kind].role === 'ac');
  if (!kinds.length) throw new Error('Joppa tree has no criterion type');
  const candidates = [], seen = new Set();
  let held = 0, unapproved = 0;
  for await (const page of nodePages(read, {kind: kinds, ...settings.filter,
    fields: ['title', 'parent', 'present', 'revision', 'contract_hash', `data.${field}`, 'data.assignee', 'data.hold']})) {
    for (const row of page.items) {
      if (typeof row.address !== 'string' || !kinds.includes(row.address.split(':')[0]) || seen.has(row.address) ||
          !Number.isSafeInteger(row.revision) || row.revision < 1) {
        throw new Error('TEST_AUTHOR_INPUT_INVALID: criterion identity or revision is invalid');
      }
      seen.add(row.address);
      if (row.present !== true) continue;
      if (nodeAssignee(row) || nodeWaiting(row)) { held++; continue; }
      const hash = row.contract_hash;
      if (typeof hash !== 'string' || !/^c1:[0-9a-f]{64}$/.test(hash)) {
        throw new Error(`CONTRACT_HASH_INVALID: ${row.address} has no native c1 proof`);
      }
      if (row[`data.${field}`] !== hash) { unapproved++; continue; }
      candidates.push({address: row.address, title: row.title || row.address,
        parent: row.parent, revision: row.revision, contractHash: hash});
    }
  }
  return {candidates, held, unapproved};
}
