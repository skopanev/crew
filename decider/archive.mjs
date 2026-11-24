// Archive one AC for DUPLICATE or OBSOLETE. The helper plans and checks. The host hook sends each batch.
// The plan covers only the selected AC and its own subtree: the deepest nodes first, Tests before Tasks at one depth,
// then the AC last. DUPLICATE moves each Test to the live sibling AC and archives the rest.
// OBSOLETE archives all with the Source as reason. The schema can nest Tests and Tasks, so the host does not assume depth 1.
// The schema roles name the kinds. The plan is frozen on the first call, and each batch has its own publication receipt.
// packet is the Decider assignment (decider-assignment.json): the Requirement, its sibling ACs and the research Sources.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const BATCH_LIMIT = 100;
export const PLAN_FILE = 'archive-plan.json';
const need = (ok, message) => { if (!ok) throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const flat = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const quoted = (node, quote) => text(quote) &&
  flat([node?.document?.data?.title, node?.document?.data?.body].filter(text).join('\n')).includes(flat(quote));
const local = address => address.slice(address.indexOf(':') + 1);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.tmp', file); };
const receiptName = index => 'archive-batch-' + String(index + 1).padStart(3, '0') + '.json';

const current = node => object(node) && node.historical === false && node.document?.present === true;

// The proof of one decision. Only current captured nodes of the assignment count.
function proof(input, decision, packet) {
  const selected = input.selected, roles = input.schema?.types || {};
  const sources = new Map([...Object.values(input.references || {}).flat(), ...(packet?.research_evidence?.sources || [])]
    .filter(node => current(node) && roles[node.kind]?.source === true).map(node => [node.address, node]));
  if (decision?.outcome === 'OBSOLETE') {
    const row = decision.obsolete_by;
    need(object(row) && sources.has(row.source) && quoted(sources.get(row.source), row.source_quote),
      'OBSOLETE needs a referenced Source and its exact quote that cancels the rule');
    return {reason: row.source + ' cancels the rule: "' + row.source_quote.trim() + '"', proof: row};
  }
  need(decision?.outcome === 'DUPLICATE', 'Use DUPLICATE or OBSOLETE');
  const row = decision.duplicate_of, parent = selected.document.parent;
  need(object(row) && text(row.address) && row.address !== selected.address, 'DUPLICATE needs the address of another AC');
  const sibling = (packet?.sibling_acs || []).find(node => object(node) && node.address === row.address);
  need(sibling && sibling.kind === selected.kind && sibling.document?.parent === parent && packet?.requirement?.address === parent,
    'The live AC must be a captured sibling of the same kind and Requirement');
  need(current(sibling) && !sibling.document.data?.assignee, 'The live AC must be current, present and unheld');
  need(quoted(sibling, row.sibling_quote), 'DUPLICATE needs an exact quote of the live AC');
  need(sources.has(row.source) && quoted(sources.get(row.source), row.source_quote), 'DUPLICATE needs a referenced Source and its exact rule quote');
  return {reason: 'Duplicate of ' + row.address + '.', proof: row, target: sibling.address};
}

// fresh is a current read of the own children. The claim snapshot is too old: a stopped lane changes its Task.
// Returns {stop, batches, reason}. stop lists own held children: the hook stops their lanes, waits, reads again and plans again.
export function plan(input, decision, packet, fresh) {
  const selected = input.selected, roles = input.schema?.types || {};
  need(roles[selected.kind]?.role === 'ac' && Number.isInteger(input.claim_revision), 'The selected item must be a claimed AC');
  const decided = proof(input, decision, packet);
  need(Array.isArray(fresh), 'The archive needs a fresh read of the own children');
  // fresh holds the whole own subtree, with earlier archived nodes. Each parent chain must reach the selected AC inside it.
  const map = new Map(fresh.filter(object).map(node => [node.address, node]));
  need((input.children || []).every(node => map.has(node.address)), 'The fresh read misses a captured child of the AC');
  const depth = node => {
    const chain = new Set([node.address]);
    for (let at = node; ; at = map.get(at.document.parent)) {
      if (at.document?.parent === selected.address) return chain.size;
      need(map.has(at.document?.parent) && !chain.has(at.document.parent),
        'The parent chain of ' + node.address + ' is outside the selected AC or incomplete');
      chain.add(at.document.parent);
    }
  };
  const children = [...map.values()].filter(node => node.document?.present !== false);
  const depths = new Map(children.map(node => [node.address, depth(node)]));
  for (const node of children) {
    need(['test', 'task'].includes(roles[node.kind]?.role), 'Only Test and Task nodes can be archived: ' + node.address);
    need(Number.isInteger(node.current_revision), 'A node needs its captured revision: ' + node.address);
  }
  const stop = children.filter(node => node.document.data?.assignee)
    .map(node => ({address: node.address, assignee: node.document.data.assignee}));
  if (stop.length) return {stop, batches: [], reason: decided.reason};
  // Bottom up: a deeper node goes first, so the Tasks under a Test go before that Test moves.
  const order = node => roles[node.kind].role === 'test' ? 0 : 1;
  const operations = children.sort((a, b) => depths.get(b.address) - depths.get(a.address) || order(a) - order(b) ||
    a.address.localeCompare(b.address)).map(node => decided.target && order(node) === 0
    ? {command: {op: 'save_object', kind: node.kind, id: local(node.address), revision: node.current_revision,
      parent: decided.target, reason: decided.reason + ' The Test moves to the live AC with its results.'}}
    : {command: {op: 'archive_object', target: node.address, revision: node.current_revision, reason: decided.reason}});
  const batches = [];
  for (let index = 0; index < operations.length; index += BATCH_LIMIT) batches.push(operations.slice(index, index + BATCH_LIMIT));
  // The last batch releases the claim of the selected AC and archives it at the saved revision.
  batches.push([
    {ref: 'flow_release', command: {op: 'save_object', kind: selected.kind, id: local(selected.address), revision: input.claim_revision,
      data: {assignee: null}, reason: decided.reason}},
    {command: {op: 'note', target: selected.address, id: ('decider-archive-' + local(selected.address)).slice(0, 100),
      text: decided.reason + '\n' + JSON.stringify(decided.proof)}},
    {command: {op: 'archive_object', target: selected.address, revision: {$ref: 'flow_release/saved_revision'}, reason: decided.reason}}]);
  return {stop: [], batches, reason: decided.reason};
}

// Freeze the plan in the run folder. A later call reads the frozen plan: earlier batches changed the live revisions.
export function frozen(dir, input, decision, packet, fresh) {
  const file = path.join(dir, PLAN_FILE);
  if (fs.existsSync(file)) return read(file);
  const value = plan(input, decision, packet, fresh);
  if (!value.stop.length) write(file, value);
  return value;
}

// The next batch to send, or done. Each sent batch keeps its receipt. A receipt that is not confirmed stops the archive.
export function next(dir) {
  const value = read(path.join(dir, PLAN_FILE));
  for (let index = 0; index < value.batches.length; index += 1) {
    const file = path.join(dir, receiptName(index));
    if (!fs.existsSync(file)) return {done: false, index, receipt: receiptName(index), operations: value.batches[index]};
    const receipt = read(file);
    need(receipt.status === 'confirmed', 'Archive batch ' + (index + 1) + ' needs receipt recovery: ' + receipt.status);
    need(JSON.stringify(receipt.arguments?.operations) === JSON.stringify(value.batches[index]),
      'Archive batch ' + (index + 1) + ' receipt differs from the frozen plan');
  }
  return {done: true, batches: value.batches.length};
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const [mode, dir] = process.argv.slice(2), file = name => read(path.join(dir, name));
    need(dir && fs.statSync(dir).isDirectory(), 'Usage: archive.mjs plan DIR | next DIR');
    // plan reads the frozen decision draft.json, the Decider assignment of the same run and archive-children.json.
    // The hook writes archive-children.json from a fresh read after it stopped the own lanes and saw them finish.
    if (mode === 'plan') need(fs.existsSync(path.join(dir, 'archive-children.json')),
      'The hook must stop the own lanes and write archive-children.json from a fresh read');
    if (mode === 'plan') console.log(JSON.stringify(frozen(dir, file('input.json'), file('draft.json'), file('decider-assignment.json'), file('archive-children.json'))));
    else { need(mode === 'next', 'Use plan or next'); console.log(JSON.stringify(next(dir))); }
  } catch (error) { console.error('decider-archive: ' + error.message); process.exitCode = 1; }
}
