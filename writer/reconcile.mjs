// Reconcile captured Tests. The shared engine owns claims and native publication.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isDeepStrictEqual as equal} from 'node:util';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && Boolean(value.trim());
const need = (value, message) => { if (!value) throw new Error(message); };
const idOf = node => node.address.slice(node.address.indexOf(':') + 1);
const ids = rows => rows.map(row => row.id).sort();
const existing = (input, kind) => input.children.filter(node => node.kind === kind);
const gap = draft => /^GAP\.\s*\S/.test(draft.coverage || '');

export function validate(input, draft, kind) {
  need(object(draft) && Object.keys(draft).every(key => ['tests', 'retire', 'coverage'].includes(key)), 'Invalid reconcile envelope');
  need(Array.isArray(draft.tests) && Array.isArray(draft.retire) && text(draft.coverage), 'Need tests, retire and coverage');
  const nodes = existing(input, kind), byId = new Map(nodes.map(node => [idOf(node), node]));
  if (gap(draft)) {
    need(!draft.tests.length && !draft.retire.length, 'A source gap cannot change Tests');
    return;
  }
  need(draft.tests.length > 0, 'The final coverage needs at least one Test');
  const mutations = draft.tests.filter(row => row.action !== 'keep').length + draft.retire.length;
  need(mutations + 1 <= 100, 'Reconciliation exceeds one native batch');
  const limit = input.schema.test_results?.max_tests;
  need(limit == null || draft.tests.length <= limit, 'Final Tests exceed the schema limit');
  const used = new Set(), titles = new Set();
  for (const row of [...draft.tests, ...draft.retire]) {
    need(object(row) && /^[A-Za-z0-9_-]+$/.test(row.id || '') && !used.has(row.id), 'Use distinct local Test IDs');
    used.add(row.id);
  }
  for (const row of draft.tests) {
    need(Object.keys(row).every(key => ['id', 'action', 'title', 'data'].includes(key)), 'Unsupported Test field');
    need(['keep', 'update', 'create'].includes(row.action) && text(row.title) && !titles.has(row.title), 'Invalid action or duplicate final title');
    titles.add(row.title);
    const node = byId.get(row.id), data = row.data ?? {};
    need(object(data), 'Test data must be an object');
    if (row.action === 'create') {
      need(!node && !nodes.some(node => node.document.data.title === row.title), 'Reuse the existing Test ID for this title');
      need(data.owner === undefined || equal(data.owner, input.selected.document.data.owner), 'New Test owner must match the AC');
    } else {
      need(node && node.document.present !== false, 'Unknown or archived Test ID');
      if (row.action === 'keep') need(row.title === node.document.data.title && !Object.keys(data).length, 'Keep preserves all Test text');
      else need(!node.document.data.assignee, 'Cannot rewrite a held Test');
    }
  }
  for (const row of draft.retire) {
    need(Object.keys(row).every(key => ['id', 'reason', 'evidence'].includes(key)), 'Unsupported retirement field');
    need(byId.has(row.id) && !byId.get(row.id).document.data.assignee && text(row.reason) && row.reason.length <= 300 &&
      text(row.evidence) && row.evidence.length <= 600, 'Retirement needs an unheld Test, reason <=300 and evidence <=600');
  }
  need(nodes.every(node => used.has(idOf(node))), 'Every existing Test needs keep, update or retirement');
  const retired = new Set(draft.retire.map(row => row.id));
  const filter = fs.readFileSync(new URL('./draft.jq', import.meta.url), 'utf8');
  for (const mode of ['create', 'update']) {
    const rows = draft.tests.filter(row => (row.action === 'create') === (mode === 'create'))
      .map(row => ({id: row.id, title: row.title, data: row.data ?? {}}));
    const view = {...input, children: nodes.filter(node => mode !== 'create' || !retired.has(idOf(node)))};
    for (let offset = 0; offset < rows.length; offset += 98) {
      const result = execFileSync('jq', ['-c', '--arg', 'mode', mode, '--arg', 'test', kind,
        '(.input | [.]) as $input | .draft | ' + filter], {encoding: 'utf8', input: JSON.stringify({input: view,
          draft: {tests: rows.slice(offset, offset + 98), coverage: draft.coverage}})});
      need(JSON.parse(result) === true, 'Reconciled Tests violate the existing native schema or stable case rules');
    }
  }
}

export function review(input, draft, reviews, digest, kind, run, gapTag) {
  validate(input, draft, kind);
  const valid = value => object(value) && value.draft_digest === digest && Array.isArray(value.tests) &&
    value.tests.every(row => object(row) && text(row.id) && typeof row.score === 'string' && /^[01]{5}$/.test(row.score)) && equal(ids(value.tests), ids(draft.tests)) &&
    Array.isArray(value.retirements) && value.retirements.every(row => object(row) && text(row.id) &&
      typeof row.agree === 'boolean' && text(row.evidence)) && equal(ids(value.retirements), ids(draft.retire)) &&
    ['complete', 'incomplete'].includes(value.coverage) && Array.isArray(value.missing) && value.missing.every(text) &&
    (value.coverage === 'complete' ? !value.missing.length : value.missing.length > 0);
  const clean = value => valid(value) && value.tests.every(row => row.score === '11111') &&
    value.retirements.every(row => row.agree) && value.coverage === 'complete';
  need(reviews.length === 2, 'Exactly two critic seats are required');
  const selected = input.selected;
  const save = (node, revision, data, reason) => ({command: {op: 'save_object', kind: node.kind,
    id: idOf(node), revision, data, reason}});
  if (!gap(draft) && reviews.every(clean)) {
    const nodes = new Map(existing(input, kind).map(node => [idOf(node), node]));
    const operations = [save(selected, input.claim_revision, {stage: 'to_task'}, 'Both critics approved final Test coverage and retirement evidence.')];
    for (const row of draft.tests.filter(row => row.action === 'update')) {
      const node = nodes.get(row.id), data = Object.fromEntries(Object.entries({...row.data, title: row.title})
        .filter(([key, value]) => !equal(value, node.document.data[key])));
      if (Object.keys(data).length) operations.push(save(node, node.current_revision, data, 'Rewrite the same Test and preserve its recorded results.'));
    }
    for (const row of draft.retire) operations.push({command: {op: 'archive_object', target: nodes.get(row.id).address,
      revision: nodes.get(row.id).current_revision, reason: (row.reason + ' Evidence: ' + row.evidence).slice(0, 1000)}});
    for (const row of draft.tests.filter(row => row.action === 'create')) operations.push({ref: 'test-' + row.id,
      command: {op: 'save_object', kind, revision: 0, parent: selected.address,
        data: {...row.data, ...(selected.document.data.owner ? {owner: selected.document.data.owner} : {}), title: row.title},
        reason: 'Create the missing Test after both critics approved final coverage.'}});
    return {approved: true, operations, outcome: {status: 'published', reason_code: 'RECONCILED', reason: 'Final Tests cover the current AC and Sources.'}};
  }
  if (gapTag && reviews.every(valid) && reviews.some(value => value.coverage === 'incomplete' && value.coverage_gap_kind === 'ac')) {
    const missing = [...new Set(reviews.flatMap(value => value.missing))];
    const data = {stage: 'to_decide', tags: [...new Set([...(selected.document.data.tags || []), gapTag])]};
    return {approved: false, decision_required: true, operations: [save(selected, input.claim_revision, data, 'The current AC or Sources need an owner decision.'),
      {command: {op: 'note', target: selected.address, id: ('writer-missing-' + run).replace(/[^A-Za-z0-9_.-]/g, '_').slice(-100),
        text: ('Missing coverage:\n' + missing.join('\n')).slice(0, 1000)}}],
      outcome: {status: 'blocked', reason_code: gap(draft) ? 'SOURCE_GAP' : 'COVERAGE_INCOMPLETE', reason: missing.join('; ').slice(0, 1000)}};
  }
  return {approved: false, critique: Object.fromEntries(reviews.map((value, index) => [index ? 'second' : 'codex', valid(value)
    ? {failing: value.tests.filter(row => row.score !== '11111'), retirements: value.retirements.filter(row => !row.agree),
      coverage: value.coverage, missing: value.missing, summary: value.summary}
    : {invalid: 'The critic must review this exact final Test set and every retirement.'}]))};
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const [mode, dir] = process.argv.slice(2), read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const input = read('input.json'), draft = read('draft.json'), kind = process.env.TEST_KIND;
    if (mode === 'check') validate(input, draft, kind);
    else {
      need(mode === 'review', 'Use check or review');
      const digest = createHash('sha256').update(fs.readFileSync(path.join(dir, 'draft.json'))).digest('hex');
      console.log(JSON.stringify(review(input, draft, [read('critic-codex.json'), read('critic-second.json')], digest,
        kind, path.basename(path.dirname(dir)), process.env.SOURCE_GAP_TAG || '')));
    }
  } catch (error) { console.error('writer-reconcile: ' + error.message); process.exitCode = 1; }
}
