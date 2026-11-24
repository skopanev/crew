// SPLIT and MOVE of the Decider (scheme crew_team, Source 3hdwy6r0). The model gives only draft.action.
// The host builds every structural operation. config.publication.structure permits them with the scopes
// context_parent, fresh_parent and created. The publication stage reads each fresh parent before the batch.
//
// draft.action = {move?, split?}
//   move: {to: "requirement:x", reason} or {new: {parent: "capability:y", title, body}, reason}
//   split: 1 or 2 NEW parts [{title, body, sources, tests: [{title, body?, case}]}]
// The selected AC is the first part: it keeps draft.body and all its existing Tests. No existing Test moves.
// More than 3 behaviors in total: no split, the author returns GAP with owner cto.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const count = value => [...value].length;
const fits = (value, limit) => text(value) && count(value) <= limit;

export const STRUCTURE = {create: {ac: ['context_parent', 'fresh_parent', 'created'], requirement: ['fresh_parent'], test: ['created']},
  // move.test fresh_parent: DUPLICATE (archive helper) moves a claimed Test to the live sibling AC.
  move: {ac: ['fresh_parent', 'created'], test: ['created', 'fresh_parent']}, note_created: true};

export function actionProblems(draft, input, packet, known, testKind) {
  const result = [], check = (ok, message) => { if (!ok) result.push(message); };
  const action = draft.action;
  if (action === undefined) return result;
  if (!object(action) || !Object.keys(action).length || !Object.keys(action).every(key => ['move', 'split'].includes(key)))
    return ['action holds only move and split'];
  check(['READY', 'GAP', 'CONFLICT'].includes(draft.outcome), 'MOVE and SPLIT go with READY, GAP or CONFLICT');
  const types = input.schema.types, selected = input.selected, current = selected.document.parent;
  const kind = packet?.requirement?.kind || current?.split(':')[0];
  if (action.move !== undefined) {
    const move = action.move;
    check(object(move) && text(move.reason) && (move.to === undefined) !== (move.new === undefined) &&
      Object.keys(move).every(key => ['to', 'new', 'reason'].includes(key)), 'MOVE needs to or new, and a reason');
    if (move?.to !== undefined) check(typeof move.to === 'string' && move.to.startsWith(kind + ':') && move.to !== current,
      'MOVE needs another ' + kind + ' address');
    if (move?.new !== undefined) {
      const spec = types[kind] || {}, created = move.new;
      check(object(created) && Object.keys(created).sort().join() === 'body,parent,title' &&
        (spec.parents || []).some(parent => typeof created.parent === 'string' && created.parent.startsWith(parent + ':')),
        'A new ' + kind + ' needs a parent of a schema parent kind, a title and a body');
      check(fits(created?.title, spec.title_max_length ?? 128) && fits(created?.body, spec.field_max_length ?? 1024),
        'A new ' + kind + ' exceeds the native schema');
    }
  }
  if (action.split !== undefined) {
    const parts = action.split, ac = types[selected.kind || 'ac'] || {}, test = types[testKind] || {};
    check(Array.isArray(parts) && parts.length >= 1, 'SPLIT needs 1 or 2 new parts');
    check(!Array.isArray(parts) || parts.length <= 2, 'More than 3 behaviors: do not split. Return GAP with owner cto');
    const cases = test.fields?.case?.values;
    for (const part of Array.isArray(parts) ? parts : []) {
      check(object(part) && Object.keys(part).sort().join() === 'body,sources,tests,title', 'A part needs title, body, sources and tests');
      check(fits(part?.title, ac.title_max_length ?? 128) && fits(part?.body, ac.field_max_length ?? 1024), 'A part exceeds the AC schema');
      check(Array.isArray(part?.sources) && part.sources.length > 0 && part.sources.every(address => known.has(address)),
        'Every Source of a part needs captured evidence');
      check(Array.isArray(part?.tests) && part.tests.length > 0 && part.tests.every(row => object(row) &&
        Object.keys(row).every(key => ['title', 'body', 'case'].includes(key)) && fits(row.title, test.title_max_length ?? 128) &&
        (row.body === undefined || fits(row.body, test.field_max_length ?? 1024)) && (!cases || cases.includes(row.case))),
      'Each part needs new Tests with a title, an optional body and a schema case');
    }
    const bodies = [draft.body, ...(Array.isArray(parts) ? parts.map(part => part?.body) : [])];
    check(new Set(bodies).size === bodies.length, 'Each part needs its own behavior');
  }
  return result;
}

// The operations before and after the save of the selected AC, and the parent of that save.
export function structure(input, draft, packet, run, {newStage, testKind}, resolve) {
  const action = draft.action || {}, selected = input.selected, data = selected.document.data || {};
  const before = [], after = [], lines = [];
  const ref = name => ({$ref: name + '/address'});
  let parent = null;
  if (action.move?.new) {
    const kind = packet.requirement.kind, created = action.move.new;
    before.push({ref: 'decider_requirement', command: {op: 'save_object', kind, revision: 0, parent: created.parent,
      data: {title: created.title, body: created.body, ...(data.owner ? {owner: data.owner} : {})},
      reason: 'Create the ' + kind + ' that the Decider MOVE needs.'}});
    parent = ref('decider_requirement');
    lines.push(`MOVE: ${selected.document.parent} -> new ${kind} "${created.title}" under ${created.parent}. Reason: ${action.move.reason}`);
  } else if (action.move?.to) {
    parent = action.move.to;
    lines.push(`MOVE: ${selected.document.parent} -> ${action.move.to}. Reason: ${action.move.reason}`);
  }
  const target = parent || selected.document.parent;
  (action.split || []).forEach((part, index) => {
    const name = 'decider_part_' + (index + 2);
    before.push({ref: name, command: {op: 'save_object', kind: selected.kind || 'ac', revision: 0, parent: target,
      data: {title: part.title, body: part.body, sources: part.sources.map(resolve), stage: newStage, returns: 0,
        ...(data.consumer ? {consumer: data.consumer} : {}), ...(data.owner ? {owner: data.owner} : {})},
      reason: 'Create part ' + (index + 2) + ' of the Decider SPLIT of ' + selected.address + '.'}});
    part.tests.forEach((row, number) => before.push({ref: name + '_test_' + (number + 1), command: {op: 'save_object', kind: testKind,
      revision: 0, parent: ref(name), data: {...row, ...(data.owner ? {owner: data.owner} : {})},
      reason: 'Create a Test of part ' + (index + 2) + ' of the Decider SPLIT.'}}));
    after.push({command: {op: 'note', target: ref(name), id: ('decider-split-' + (index + 2) + '-' + run).replace(/[^A-Za-z0-9_.-]/g, '_').slice(-100),
      text: `Decider SPLIT part ${index + 2} of ${selected.address} (revision ${selected.current_revision}). Run: ${run}\n` +
        `Behavior: ${part.body}\nTests: ${part.tests.map(row => row.title).join('; ')}`}});
    lines.push(`SPLIT part ${index + 2}: "${part.title}"\n${part.body}\nTests: ${part.tests.map(row => row.title).join('; ')}`);
  });
  if (action.split) lines.unshift(`SPLIT: ${action.split.length + 1} parts. Part 1 stays in ${selected.address} with all its Tests.`);
  return {before, parent, after, note: lines.join('\n')};
}
