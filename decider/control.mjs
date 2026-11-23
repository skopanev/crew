// Validate decision data and build a bounded native batch. Models cannot supply operations.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dryOutput} from '../writer/control.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const keys = ['G', 'A', 'U', 'M', 'V', 'R'];
const need = (ok, message) => { if (!ok) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const count = value => [...value].length;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = (file, value) => { fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.tmp', file); };
const emit = (key, value) => console.log(`<signal:var key=${key}>${String(value).replaceAll('<', '\\u003c').replaceAll('{{', '\\u007b\\u007b')}</signal:var>`);
const signal = value => console.log(`<signal:${value}>Decider ${value}</signal:${value}>`);

export function policy(env, config) {
  need(['AUTHOR_MODEL', 'CRITIC_CODEX_MODEL', 'CRITIC_SECOND_MODEL'].every(key => text(env[key])), 'Configure all three models');
  need(env.CRITIC_SECOND_HARNESS === 'claude-code', 'Use a Claude critic beside the independent Codex critic');
  need(env.CRITIC_SECOND_MODEL !== env.AUTHOR_MODEL && env.CRITIC_SECOND_MODEL !== env.CRITIC_CODEX_MODEL, 'Use distinct configured critic seats');
  need(['true', 'false'].includes(env.DRY_RUN) && /^\d+$/.test(env.REWORK_LIMIT), 'Invalid dry run or rework limit');
  need(JSON.stringify(config.publication) === JSON.stringify(JSON.parse(env.FLOW_PUBLICATION)), 'Publication policy differs');
  const p = config.publication;
  need(p.file === 'operations.json' && p.allowed_operations.join() === 'save_object,note' &&
    p.create_kinds.join() === 'source' && p.update_kinds.join() === 'ac', 'Only Source creation and selected AC updates are permitted');
  need(config.context.roles.decider?.process === 'decider' && config.context.roles.audit?.process === 'ac-auditor', 'Both live contracts are required');
  need(['BRAIN_ROOT', 'MANUALS_ROOT', 'BRAIN_EXCLUDE'].every(key => text(env[key])), 'Research roots and exclusion are required');
}

export function problems(draft, input, packet) {
  const result = [];
  const check = (ok, message) => { if (!ok) result.push(message); };
  check(draft && typeof draft === 'object' && !Array.isArray(draft), 'Return one decision object');
  if (result.length) return result;
  check(Object.keys(draft).every(key => ['outcome', 'body', 'sources', 'new_sources', 'scores', 'summary', 'note', 'gap', 'research', 'duplicate_of'].includes(key)), 'Unknown decision field');
  check(['READY_FOR_AUDIT', 'GAP', 'MANUAL_CHECK', 'SEARCH_UNAVAILABLE', 'UNPUBLISHED_EVIDENCE'].includes(draft.outcome), 'Unknown outcome');
  check(text(draft.summary), 'Give a summary');
  if (['SEARCH_UNAVAILABLE', 'UNPUBLISHED_EVIDENCE'].includes(draft.outcome)) return result;
  check(text(draft.body) && count(draft.body) <= (input.schema.types.ac.field_max_length ?? 1024), 'AC body is empty or exceeds its schema limit');
  check(Array.isArray(draft.sources) && draft.sources.every(text), 'Sources must be addresses or local new Source IDs');
  check(text(draft.note), 'Give a change note, including reasons for removed qualifiers');
  check(draft.scores && Object.keys(draft.scores).sort().join() === [...keys].sort().join(), 'Give exactly six scores');
  for (const key of keys) check([0, 1].includes(draft.scores?.[key]?.score) && text(draft.scores?.[key]?.evidence) &&
    count(draft.scores[key].evidence) <= 1000, `${key} needs a score and evidence`);
  if (draft.outcome === 'READY_FOR_AUDIT') check(keys.every(key => draft.scores?.[key]?.score === 1), 'READY requires six scores of one');
  const original = input.selected.document.data.body || '';
  for (const line of original.split('\n').filter(line => /^\s*(?:\*\*)?Baseline\b/.test(line))) check(draft.body?.split('\n').includes(line), 'Keep the existing Baseline');
  for (const line of draft.body?.split('\n').filter(line => /^\s*(?:\*\*)?Baseline\b/.test(line)) || []) check(original.split('\n').includes(line), 'Do not invent a Baseline');
  const proposed = Array.isArray(draft.new_sources) ? draft.new_sources : [];
  check(draft.new_sources === undefined || Array.isArray(draft.new_sources), 'New Sources must be an array');
  for (const item of proposed) check(item && Object.keys(item).sort().join() ===
    ['id', 'title', 'document_title', 'section', 'path', 'quote'].sort().join() && /^new_[A-Za-z0-9_-]+$/.test(item.id) &&
    ['title', 'document_title', 'section', 'path', 'quote'].every(key => text(item[key])), 'A new Source needs its local ID, document, section, path and exact quote');
  check(new Set(proposed.map(item => item?.id)).size === proposed.length, 'New Source IDs must be unique');
  check(proposed.every(item => draft.sources?.includes(item?.id)), 'Every new Source must link to the selected AC');
  check(proposed.every(item => ![draft.body, draft.note, draft.summary].some(value => typeof value === 'string' && value.includes(item?.id))), 'Keep local Source IDs out of prose');
  const research = draft.research;
  check(research && typeof research.searches === 'object' && Array.isArray(research.sources) && Array.isArray(research.files) &&
    Array.isArray(research.unavailable), 'Give research searches, checked Sources/files and unavailable routes');
  if (research && Array.isArray(research.sources) && Array.isArray(research.files)) {
    check(research.sources.every(item => item && /^source:[A-Za-z0-9_-]+$/.test(item.address) && Number.isSafeInteger(item.revision) && item.revision > 0 && text(item.quote)), 'Checked Sources need an address, revision and exact quote');
    check(research.files.every(item => item && text(item.path) && text(item.quote)), 'Checked files need a path and exact quote');
    const known = new Set([...(input.references.sources || []).map(item => item.address), ...research.sources.map(item => item?.address), ...proposed.map(item => item?.id)]);
    check(draft.sources?.every(address => known.has(address)), 'Every linked Source needs captured evidence');
  }
  if (draft.outcome === 'GAP') {
    check(['cto', 'ceo'].includes(draft.gap?.owner) && ['question', 'a', 'b'].every(key => text(draft.gap?.[key])) &&
      ['A', 'B'].includes(draft.gap?.recommended), 'GAP needs the owner, question, A/B options and simplest recommendation');
    check(keys.some(key => draft.scores?.[key]?.score === 0), 'GAP needs a demonstrated failed score');
  }
  check(draft.outcome === 'MANUAL_CHECK' || draft.duplicate_of === undefined, 'Duplicate proof is only for MANUAL_CHECK');
  if (draft.outcome === 'MANUAL_CHECK') {
    check(draft.scores?.R?.score === 0, 'MANUAL_CHECK requires R=0');
    check(draft.body === original && JSON.stringify(draft.sources) === JSON.stringify(input.selected.document.data.sources || []), 'MANUAL_CHECK preserves the selected body and Sources');
    check(proposed.length === 0 && draft.gap === undefined, 'MANUAL_CHECK cannot create Sources or request a Source gap');
    const proof = draft.duplicate_of;
    check(proof && Object.keys(proof).sort().join() === ['address', 'source', 'source_quote', 'sibling_quote'].sort().join() &&
      /^ac:[A-Za-z0-9_-]+$/.test(proof.address) && /^source:[A-Za-z0-9_-]+$/.test(proof.source) &&
      text(proof.source_quote) && text(proof.sibling_quote), 'Give the duplicate sibling, Source and exact quotes');
    const sibling = Array.isArray(packet?.sibling_acs) && packet.sibling_acs.find(node => node.address === proof?.address);
    check(sibling && sibling.address !== input.selected.address && sibling.kind === 'ac' && sibling.historical === false &&
      sibling.document?.present === true && sibling.document.parent === input.selected.document.parent &&
      Number.isSafeInteger(sibling.current_revision) && sibling.current_revision > 0 && text(proof?.sibling_quote) &&
      sibling.document.data.body?.includes(proof.sibling_quote), 'MANUAL_CHECK needs exact evidence from a captured active sibling');
  }
  return result;
}

export function proposal(input, draft, packet, run) {
  need(problems(draft, input, packet).length === 0, 'Invalid decision cannot be published');
  need(['READY_FOR_AUDIT', 'GAP', 'MANUAL_CHECK'].includes(draft.outcome), 'Technical failure cannot change product state');
  need(!draft.research.unavailable.length && ['joppa', 'brain', 'manuals'].every(key => text(draft.research.searches[key])), 'SEARCH_UNAVAILABLE');
  const files = packet.research_evidence.files, operations = [], refs = new Map();
  const existing = [...input.references.sources || [], ...packet.research_evidence.sources];
  if (draft.outcome === 'MANUAL_CHECK') {
    const proof = draft.duplicate_of, source = existing.find(node => node.address === proof.source);
    need(source?.kind === 'source' && source.historical === false && source.document?.present === true &&
      source.document.data.body?.includes(proof.source_quote), 'The duplicate needs an exact rule from a captured current Source');
  }
  for (const item of draft.new_sources || []) {
    const file = files.find(file => file.path === fs.realpathSync(item.path));
    need(file && file.text.includes(item.quote), 'A new Source needs an exact frozen file quote');
    const reused = existing.find(source => source.document.data.body?.includes(item.quote));
    if (reused) { refs.set(item.id, reused.address); continue; }
    const body = `Document: ${item.document_title}\nSection: ${item.section}\nFile: ${file.path}\nSHA256: ${file.sha256}\n\n## Verbatim\n\n${item.quote}`;
    const spec = input.schema.types.source;
    need(spec?.root === true && count(body) <= (spec.field_max_length ?? 1024) && count(item.title) <= (spec.title_max_length ?? 128), 'New Source exceeds the native schema');
    operations.push({ref: item.id, command: {op: 'save_object', kind: 'source', revision: 0, parent: null,
      data: {title: item.title, body, ...(input.selected.document.data.owner ? {owner: input.selected.document.data.owner} : {})},
      reason: `Create a Source from the verified file ${file.path}, SHA256 ${file.sha256}.`}});
    refs.set(item.id, {$ref: item.id + '/address'});
  }
  const sources = draft.sources.map(address => refs.get(address) || address);
  need(sources.length > 0 || draft.outcome !== 'READY_FOR_AUDIT', 'READY needs linked Sources');
  const manual = draft.outcome === 'MANUAL_CHECK';
  const tags = [...new Set([...(input.selected.document.data.tags || []), ...(manual ? ['manual-check'] : draft.outcome === 'GAP' ? ['source-gap-' + draft.gap.owner] : [])])];
  const data = manual ? {tags, stage: 'to_decide'} : {body: draft.body, sources, tags, stage: draft.outcome === 'GAP' ? 'to_decide' : 'to_audit'};
  const documents = [...new Set([...draft.research.sources.map(item => item.address + '@' + item.revision), ...draft.research.files.map(item => item.path), ...(draft.new_sources || []).map(item => item.path)])];
  let note = `Decider ${draft.outcome}\n${draft.note}\n${keys.map(key => key + '=' + draft.scores[key].score).join(' ')}\nChecked: ${documents.join(', ')}`;
  if (draft.outcome === 'GAP') note += `\nQuestion: ${draft.gap.question}\n${draft.gap.recommended === 'A' ? '* ' : ''}A: ${draft.gap.a}\n${draft.gap.recommended === 'B' ? '* ' : ''}B: ${draft.gap.b}`;
  if (manual) note += `\nActive duplicate: ${draft.duplicate_of.address}\nSibling text: ${draft.duplicate_of.sibling_quote}\nSource rule ${draft.duplicate_of.source}: ${draft.duplicate_of.source_quote}`;
  const node = input.selected;
  operations.push({command: {op: 'save_object', kind: 'ac', id: node.address.split(':')[1], revision: input.claim_revision,
    data, reason: 'Publish the decision that both independent critics approved.'}},
  {command: {op: 'note', target: node.address, id: ('decider-' + run).replace(/[^A-Za-z0-9_.-]/g, '_').slice(-100), text: note}});
  return {operations, outcome: {status: draft.outcome === 'READY_FOR_AUDIT' ? 'published' : 'blocked', reason_code: draft.outcome, reason: draft.summary.slice(0, 1000)}};
}

export function reviews(draft, first, second, digest, contextDigest) {
  return [first, second].every(review => review && review.draft_digest === digest && review.context_digest === contextDigest &&
    review.verdict === 'APPROVE' && Object.keys(review.scores || {}).sort().join() === [...keys].sort().join() &&
    keys.every(key => review.scores[key]?.agree === true && text(review.scores[key]?.evidence)) &&
    Array.isArray(review.findings) && review.findings.length === 0 && text(review.summary));
}

function main() {
  const [command, directory] = process.argv.slice(2), env = process.env;
  if (command === 'policy') { policy(env, read(env.PLANNING_JOPPA_CONFIG)); return; }
  const file = name => path.join(directory, name + '.json'), input = read(file('input')), draft = read(file('draft'));
  if (command === 'check') {
    if (Array.isArray(draft.research?.unavailable) && draft.research.unavailable.length) {
      fs.writeFileSync(path.join(directory, 'failure.txt'), 'SEARCH_UNAVAILABLE: ' + JSON.stringify(draft.research.unavailable));
      signal('FAILED'); return;
    }
    const issues = problems(draft, input, draft.outcome === 'MANUAL_CHECK' ? read(path.join(directory, 'decider-assignment.json')) : undefined);
    if (issues.length) {
      if (Number(env.shape_retries || 0) < 1) {
        emit('shape_feedback', JSON.stringify(issues)); emit('shape_retries', '1'); signal('REVISE');
      } else { fs.writeFileSync(path.join(directory, 'failure.txt'), issues.join('\n')); signal('FAILED'); }
    } else if (['SEARCH_UNAVAILABLE', 'UNPUBLISHED_EVIDENCE'].includes(draft.outcome)) {
      fs.writeFileSync(path.join(directory, 'failure.txt'), draft.outcome + ': ' + draft.summary); signal('FAILED');
    } else signal('CHECKED');
    return;
  }
  if (command === 'digest') {
    emit('draft_digest', hash(file('draft'))); emit('context_digest', hash(path.join(directory, 'decider-assignment.json')));
    emit('shape_feedback', ''); emit('shape_retries', '0'); signal('FROZEN'); return;
  }
  need(command === 'review', 'Use policy, check, digest or review');
  const first = read(file('critic-codex')), second = read(file('critic-second'));
  if (reviews(draft, first, second, hash(file('draft')), hash(path.join(directory, 'decider-assignment.json')))) {
    const value = proposal(input, draft, read(path.join(directory, 'decider-assignment.json')), path.basename(path.dirname(directory)));
    save(file('would-publish'), value); save(file('operations'), dryOutput(value, env.DRY_RUN === 'true')); signal('APPROVED');
  } else if (Number(env.round || 1) <= Number(env.REWORK_LIMIT)) {
    emit('critique', JSON.stringify({codex: first, second})); emit('round', String(Number(env.round || 1) + 1)); signal('REVISE');
  } else {
    fs.writeFileSync(path.join(directory, 'failure.txt'), 'Independent critics did not approve the frozen decision.\n' +
      JSON.stringify({codex: first, second}, null, 2) + '\n');
    signal('FAILED');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); } catch (error) { console.error('decider: ' + error.message); process.exitCode = 1; }
}
