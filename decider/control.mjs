// Validate decision data and build a bounded native batch. Models cannot supply operations.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dryOutput} from '../writer/control.mjs';
import {STRUCTURE, actionProblems, structure} from './split-move.mjs';
import {plan} from './archive.mjs';
import {settings, schemaFields, rejected} from './returns.mjs';
export {settings, rejected} from './returns.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const keys = ['G', 'A', 'U', 'M', 'V', 'R'];
const need = (ok, message) => { if (!ok) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const count = value => [...value].length;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// The agents read their files through read_context and read_file. On a retry the author prompt says so. read_context
// lists the previous draft and the findings, so the prompt names no path. The first prompt has the AC only.
const feedback = () => emit('decider_feedback', RETRY);
export const RETRY = 'Retry: read_context lists your previous draft and the findings. Close each finding.';
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = (file, value) => { fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.tmp', file); };
const emit = (key, value) => console.log(`<signal:var key=${key}>${String(value).replaceAll('<', '\\u003c').replaceAll('{{', '\\u007b\\u007b')}</signal:var>`);
const signal = value => console.log(`<signal:${value}>Decider ${value}</signal:${value}>`);
const noteId = (prefix, run) => (prefix + run).replace(/[^A-Za-z0-9_.-]/g, '_').slice(-100);
// Scheme crew_team, step Decider. A question (GAP or CONFLICT) keeps the stage and returns.
// A technical failure (SEARCH_UNAVAILABLE, UNPUBLISHED_EVIDENCE) changes nothing.
// DUPLICATE and OBSOLETE archive the AC: archive.mjs plans the own subtree, and ARCHIVE_HOOK sends the batches.
const outcomes = ['READY', 'GAP', 'CONFLICT', 'MANUAL_CHECK', 'DUPLICATE', 'OBSOLETE', 'SEARCH_UNAVAILABLE', 'UNPUBLISHED_EVIDENCE'];
const archives = ['DUPLICATE', 'OBSOLETE'];
const packeted = ['MANUAL_CHECK', 'DUPLICATE'];
const questions = ['GAP', 'CONFLICT'];

export function policy(env, config) {
  need(['AUTHOR_MODEL', 'CRITIC_CODEX_MODEL', 'CRITIC_SECOND_MODEL'].every(key => text(env[key])), 'Configure all three models');
  need(env.CRITIC_SECOND_HARNESS === 'claude-code', 'Use a Claude critic beside the independent Codex critic');
  need(env.CRITIC_SECOND_MODEL !== env.AUTHOR_MODEL && env.CRITIC_SECOND_MODEL !== env.CRITIC_CODEX_MODEL, 'Use distinct configured critic seats');
  need(['true', 'false'].includes(env.DRY_RUN) && /^\d+$/.test(env.REWORK_LIMIT), 'Invalid dry run or rework limit');
  need(JSON.stringify(config.publication) === JSON.stringify(JSON.parse(env.FLOW_PUBLICATION)), 'Publication policy differs');
  const p = config.publication;
  // archive_object and the task kind serve only the DUPLICATE and OBSOLETE archive of the own subtree (archive.mjs).
  need(p.file === 'operations.json' && p.allowed_operations.join() === 'save_object,note,archive_object' &&
    p.create_kinds.join() === 'source,ac,requirement,test' && p.update_kinds.join() === 'ac,test,task' &&
    JSON.stringify(p.structure) === JSON.stringify(STRUCTURE), 'Only Sources, SPLIT and MOVE creates, AC updates and the own archive are permitted');
  need(config.related?.parent?.kind, 'SPLIT under the current parent needs related.parent, so the publisher captures its revision');
  need(config.context.roles.decider?.process === 'decider' && config.context.roles.audit?.process === 'ac-auditor', 'Both live contracts are required');
  need(['BRAIN_ROOT', 'MANUALS_ROOT', 'BRAIN_EXCLUDE'].every(key => text(env[key])), 'Research roots and exclusion are required');
  const value = settings(env);
  need(config.failure_escalation === undefined, 'The Decider counts returns itself. Remove failure_escalation');
  need([value.stuckTag, value.tags.cto, value.tags.ceo].every(tag => (config.exclude_tags || []).includes(tag)),
    'exclude_tags must hold the stuck tag and both question tags');
}

// The kind with the test role in the schema holds the Tests of a new SPLIT part.
const testKind = input => Object.entries(input.schema?.types || {}).find(([, type]) => type.role === 'test')?.[0];

export function problems(draft, input, packet) {
  const result = [];
  const check = (ok, message) => { if (!ok) result.push(message); };
  check(draft && typeof draft === 'object' && !Array.isArray(draft), 'Return one decision object');
  if (result.length) return result;
  check(Object.keys(draft).every(key => ['outcome', 'body', 'sources', 'new_sources', 'scores', 'summary', 'note', 'gap', 'research', 'duplicate_of', 'conflict', 'action', 'obsolete_by'].includes(key)), 'Unknown decision field');
  check(outcomes.includes(draft.outcome), 'Unknown outcome');
  check(text(draft.summary), 'Give a summary');
  if (['SEARCH_UNAVAILABLE', 'UNPUBLISHED_EVIDENCE'].includes(draft.outcome)) return result;
  check(text(draft.body) && count(draft.body) <= (input.schema.types.ac.field_max_length ?? 1024), 'AC body is empty or exceeds its schema limit');
  check(Array.isArray(draft.sources) && draft.sources.every(text), 'Sources must be addresses or local new Source IDs');
  check(text(draft.note), 'Give a change note, including reasons for removed qualifiers');
  check(draft.scores && Object.keys(draft.scores).sort().join() === [...keys].sort().join(), 'Give exactly six scores');
  for (const key of keys) check([0, 1].includes(draft.scores?.[key]?.score) && text(draft.scores?.[key]?.evidence) &&
    count(draft.scores[key].evidence) <= 1000, `${key} needs a score and evidence`);
  if (draft.outcome === 'READY') check(keys.every(key => draft.scores?.[key]?.score === 1), 'READY requires six scores of one');
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
    result.push(...actionProblems(draft, input, packet, known, testKind(input)));
    // CONFLICT: two different captured Sources, each with an exact quote. The host checks the quotes in proposal.
    if (draft.outcome === 'CONFLICT') check(Array.isArray(draft.conflict) && draft.conflict.length === 2 &&
      draft.conflict.every(item => item && Object.keys(item).sort().join() === 'quote,source' && known.has(item.source) &&
        /^source:/.test(item.source) && text(item.quote)) && draft.conflict[0]?.source !== draft.conflict[1]?.source,
      'CONFLICT needs two different captured Sources with exact quotes');
    // OBSOLETE: one captured Source cancels the rule. archive.mjs checks the exact quote against the current Source.
    if (draft.outcome === 'OBSOLETE') check(draft.obsolete_by && Object.keys(draft.obsolete_by).sort().join() === 'source,source_quote' &&
      known.has(draft.obsolete_by.source) && /^source:/.test(draft.obsolete_by.source) && text(draft.obsolete_by.source_quote),
      'OBSOLETE needs a captured Source and its exact quote that cancels the rule');
  }
  check(draft.outcome === 'OBSOLETE' || draft.obsolete_by === undefined, 'Obsolete proof is only for OBSOLETE');
  if (archives.includes(draft.outcome)) {
    check(draft.body === (input.selected.document.data.body || '') &&
      JSON.stringify(draft.sources) === JSON.stringify(input.selected.document.data.sources || []), draft.outcome + ' preserves the selected body and Sources');
    check(proposed.length === 0 && draft.gap === undefined, draft.outcome + ' cannot create Sources or ask a question');
  }
  check(draft.outcome === 'CONFLICT' || draft.conflict === undefined, 'Conflict proof is only for CONFLICT');
  if (questions.includes(draft.outcome)) {
    check(['cto', 'ceo'].includes(draft.gap?.owner) && ['question', 'a', 'b'].every(key => text(draft.gap?.[key])) &&
      ['A', 'B'].includes(draft.gap?.recommended), draft.outcome + ' needs the owner, question, A/B options and simplest recommendation');
    check(keys.some(key => draft.scores?.[key]?.score === 0), draft.outcome + ' needs a demonstrated failed score');
  } else check(draft.gap === undefined, 'A question is only for GAP or CONFLICT');
  const duplicate = packeted.includes(draft.outcome);
  check(duplicate || draft.duplicate_of === undefined, 'Duplicate proof is only for MANUAL_CHECK or DUPLICATE');
  if (duplicate) {
    check(draft.scores?.R?.score === 0, draft.outcome + ' requires R=0');
    check(draft.body === original && JSON.stringify(draft.sources) === JSON.stringify(input.selected.document.data.sources || []), draft.outcome + ' preserves the selected body and Sources');
    check(proposed.length === 0 && draft.gap === undefined, draft.outcome + ' cannot create Sources or request a Source gap');
    const proof = draft.duplicate_of;
    check(proof && Object.keys(proof).sort().join() === ['address', 'source', 'source_quote', 'sibling_quote'].sort().join() &&
      /^ac:[A-Za-z0-9_-]+$/.test(proof.address) && /^source:[A-Za-z0-9_-]+$/.test(proof.source) &&
      text(proof.source_quote) && text(proof.sibling_quote), 'Give the duplicate sibling, Source and exact quotes');
    const sibling = Array.isArray(packet?.sibling_acs) && packet.sibling_acs.find(node => node.address === proof?.address);
    check(sibling && sibling.address !== input.selected.address && sibling.kind === 'ac' && sibling.historical === false &&
      sibling.document?.present === true && sibling.document.parent === input.selected.document.parent &&
      Number.isSafeInteger(sibling.current_revision) && sibling.current_revision > 0 && text(proof?.sibling_quote) &&
      sibling.document.data.body?.includes(proof.sibling_quote), draft.outcome + ' needs exact evidence from a captured active sibling');
  }
  return result;
}

export function proposal(input, draft, packet, run, config) {
  need(problems(draft, input, packet).length === 0, 'Invalid decision cannot be published');
  need(['READY', 'GAP', 'CONFLICT', 'MANUAL_CHECK'].includes(draft.outcome), 'Technical failure cannot change product state');
  schemaFields(input, config);
  need(!draft.research.unavailable.length && ['joppa', 'brain', 'manuals'].every(key => text(draft.research.searches[key])), 'SEARCH_UNAVAILABLE');
  const files = packet.research_evidence.files, operations = [], refs = new Map();
  const existing = [...input.references.sources || [], ...packet.research_evidence.sources];
  if (draft.outcome === 'MANUAL_CHECK') {
    const proof = draft.duplicate_of, source = existing.find(node => node.address === proof.source);
    need(source?.kind === 'source' && source.historical === false && source.document?.present === true &&
      source.document.data.body?.includes(proof.source_quote), 'The duplicate needs an exact rule from a captured current Source');
  }
  for (const item of draft.outcome === 'CONFLICT' ? draft.conflict : []) {
    const source = existing.find(node => node.address === item.source);
    need(source?.document?.data?.body?.includes(item.quote), 'The conflict needs an exact quote of each captured Source');
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
  need(sources.length > 0 || draft.outcome !== 'READY', 'READY needs linked Sources');
  const manual = draft.outcome === 'MANUAL_CHECK', question = questions.includes(draft.outcome);
  const tag = question ? config.tags[draft.gap.owner] : null;
  const tags = [...new Set([...(input.selected.document.data.tags || []), ...(manual ? ['manual-check'] : tag ? [tag] : [])])];
  // READY moves the AC on and sets returns to 0. A question keeps the stage and returns.
  const data = manual ? {tags, stage: 'to_decide'} : question ? {body: draft.body, sources, tags}
    : {body: draft.body, sources, tags, stage: config.readyStage, returns: 0};
  const documents = [...new Set([...draft.research.sources.map(item => item.address + '@' + item.revision), ...draft.research.files.map(item => item.path), ...(draft.new_sources || []).map(item => item.path)])];
  let note = `Decider ${draft.outcome}\n${draft.note}\n${keys.map(key => key + '=' + draft.scores[key].score).join(' ')}\nChecked: ${documents.join(', ')}`;
  if (draft.outcome === 'CONFLICT') note += draft.conflict.map(item => `\nConflict ${item.source}: ${item.quote}`).join('');
  if (question) note += `\nOPEN QUESTION (${draft.gap.owner}, tag ${tag}): ${draft.gap.question}` +
    `\nA${draft.gap.recommended === 'A' ? ' ★' : ''}: ${draft.gap.a}\nB${draft.gap.recommended === 'B' ? ' ★' : ''}: ${draft.gap.b}`;
  if (manual) note += `\nActive duplicate: ${draft.duplicate_of.address}\nSibling text: ${draft.duplicate_of.sibling_quote}\nSource rule ${draft.duplicate_of.source}: ${draft.duplicate_of.source_quote}`;
  const node = input.selected, shape = structure(input, draft, packet, run, {...config, testKind: testKind(input)}, address => refs.get(address) || address);
  if (shape.note) note += '\n' + shape.note;
  // Creates come first: the save of the selected AC can name a created Requirement as its parent.
  operations.push(...shape.before, {command: {op: 'save_object', kind: 'ac', id: node.address.split(':')[1], revision: input.claim_revision,
    ...(shape.parent ? {parent: shape.parent} : {}), data, reason: 'Publish the decision that both independent critics approved.'}},
  {command: {op: 'note', target: node.address, id: noteId('decider-', run), text: note}}, ...shape.after);
  return {operations, outcome: {status: draft.outcome === 'READY' ? 'published' : 'blocked', reason_code: draft.outcome, reason: draft.summary.slice(0, 1000)}};
}

// A review counts only when it is well formed for this exact draft and context. Anything else is a technical failure.
export function wellFormed(review, digest, contextDigest) {
  return Boolean(review) && typeof review === 'object' && review.draft_digest === digest && review.context_digest === contextDigest &&
    ['APPROVE', 'REWORK'].includes(review.verdict) && Object.keys(review.scores || {}).sort().join() === [...keys].sort().join() &&
    keys.every(key => typeof review.scores[key]?.agree === 'boolean' && text(review.scores[key]?.evidence)) &&
    Array.isArray(review.findings) && review.findings.every(row => row && text(row.problem) && text(row.advice)) && text(review.summary) &&
    // The critic contract: REWORK gives at least one concrete problem, APPROVE agrees with every score.
    (review.verdict === 'REWORK' ? review.findings.length > 0 : keys.every(key => review.scores[key].agree === true));
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
  const file = name => path.join(directory, name + '.json'), input = read(file('input'));
  const run = path.basename(path.dirname(directory));
  if (command === 'rejected') {
    const value = rejected(input, fs.readFileSync(path.join(directory, 'failure.txt'), 'utf8'), run, settings(env));
    save(file('would-publish'), value); save(file('operations'), dryOutput(value, env.DRY_RUN === 'true')); signal('RETURN'); return;
  }
  const draft = read(file('draft'));
  if (command === 'check') {
    if (Array.isArray(draft.research?.unavailable) && draft.research.unavailable.length) {
      fs.writeFileSync(path.join(directory, 'failure.txt'), 'SEARCH_UNAVAILABLE: ' + JSON.stringify(draft.research.unavailable));
      signal('FAILED'); return;
    }
    const issues = problems(draft, input, packeted.includes(draft.outcome) ? read(path.join(directory, 'decider-assignment.json')) : undefined);
    if (issues.length) {
      if (Number(env.shape_retries || 0) < 1) {
        save(path.join(directory, 'shape-feedback.json'), issues); emit('shape_feedback', JSON.stringify(issues)); emit('shape_retries', '1'); feedback(); signal('REVISE');
      } else {
        // A broken output contract is a technical failure: stage and returns stay.
        fs.writeFileSync(path.join(directory, 'failure.txt'), 'INVALID: the decision stayed invalid after one correction.\n' + issues.join('\n'));
        signal('FAILED');
      }
    } else if (['SEARCH_UNAVAILABLE', 'UNPUBLISHED_EVIDENCE'].includes(draft.outcome)) {
      fs.writeFileSync(path.join(directory, 'failure.txt'), draft.outcome + ': ' + draft.summary); signal('FAILED');
    } else signal('CHECKED');
    return;
  }
  if (command === 'digest') {
    // freeze found a wrong quote or revision: one correction by the author, then a technical failure.
    const evidence = path.join(directory, 'freeze-issues.json');
    if (fs.existsSync(evidence)) {
      const issues = read(evidence);
      if (Number(env.shape_retries || 0) < 1) {
        save(path.join(directory, 'shape-feedback.json'), issues); emit('shape_feedback', JSON.stringify(issues)); emit('shape_retries', '1'); feedback(); signal('REVISE');
      }
      else { fs.writeFileSync(path.join(directory, 'failure.txt'), 'INVALID: the evidence quotes stayed wrong after one correction.\n' + issues.join('\n')); signal('FAILED'); }
      return;
    }
    emit('draft_digest', hash(file('draft'))); emit('context_digest', hash(path.join(directory, 'decider-assignment.json')));
    fs.rmSync(path.join(directory, 'shape-feedback.json'), {force: true});
    emit('shape_feedback', ''); emit('shape_retries', '0'); signal('FROZEN'); return;
  }
  need(command === 'review', 'Use policy, check, digest, review or rejected');
  // The host stamps the digests that freeze gave to this critic step. wellFormed still compares them with the
  // current draft and assignment. A model does not copy a 64-character hash.
  const stamp = review => review && typeof review === 'object' && !Array.isArray(review)
    ? {...review, draft_digest: env.draft_digest, context_digest: env.context_digest} : review;
  const first = stamp(read(file('critic-codex'))), second = stamp(read(file('critic-second')));
  const digests = [hash(file('draft')), hash(path.join(directory, 'decider-assignment.json'))];
  if (![first, second].every(review => wellFormed(review, ...digests))) {
    fs.writeFileSync(path.join(directory, 'failure.txt'), 'INVALID_REVIEW: a critic output is malformed or names another digest.\n' +
      JSON.stringify({codex: first, second}, null, 2) + '\n');
    signal('FAILED'); return;
  }
  // Only a well-formed rejection by the critics counts as a failed step.
  if (reviews(draft, first, second, hash(file('draft')), hash(path.join(directory, 'decider-assignment.json'))) && archives.includes(draft.outcome)) {
    // A preview from the claim snapshot checks the proof. The hook freezes the real plan after a fresh read.
    // A dry run publishes nothing and keeps the preview as the proposal.
    const packet = read(path.join(directory, 'decider-assignment.json'));
    need(problems(draft, input, packet).length === 0, 'Invalid decision cannot be archived');
    const value = plan(input, draft, packet, input.children || []);
    save(file('would-publish'), {archive: value});
    if (env.DRY_RUN === 'true') {
      save(file('operations'), dryOutput({operations: [], outcome: {status: 'blocked', reason_code: draft.outcome, reason: value.reason.slice(0, 1000)}}, true));
      signal('APPROVED');
    } else signal('ARCHIVE');
  } else if (reviews(draft, first, second, hash(file('draft')), hash(path.join(directory, 'decider-assignment.json')))) {
    const value = proposal(input, draft, read(path.join(directory, 'decider-assignment.json')), run, settings(env));
    save(file('would-publish'), value); save(file('operations'), dryOutput(value, env.DRY_RUN === 'true')); signal('APPROVED');
  } else if (Number(env.round || 1) <= Number(env.REWORK_LIMIT)) {
    save(path.join(directory, 'critique.json'), {codex: first, second});
    emit('critique', JSON.stringify({codex: first, second})); emit('round', String(Number(env.round || 1) + 1)); feedback(); signal('REVISE');
  } else {
    fs.writeFileSync(path.join(directory, 'failure.txt'), 'Independent critics did not approve the frozen decision.\n' +
      JSON.stringify({codex: first, second}, null, 2) + '\n');
    signal('REJECTED');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); } catch (error) { console.error('decider: ' + error.message); process.exitCode = 1; }
}
