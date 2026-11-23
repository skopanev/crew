// The AC side of each Writer outcome (scheme crew_team, step Writer). The config names the stages, the criterion letters,
// the returns limit and the stuck tag. The schema of the selected kind must define the stages and the returns and tags fields.
// READY resets returns. An AC defect goes to the return stage only with a three-part finding. A GAP adds the question tag
// and keeps the stage. A failed step keeps the stage. A defect or a failure adds 1 to returns. The limit adds the stuck tag
// and an explicit question to the Owner.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (value, message) => { if (!value) throw new Error(message); };
const flat = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const quoted = (node, quote) => Boolean(flat(quote)) &&
  flat([node?.document?.data?.title, node?.document?.data?.body].filter(text => typeof text === 'string').join('\n')).includes(flat(quote));
const local = address => address.slice(address.indexOf(':') + 1);
const noteId = (prefix, run) => (prefix + run).replace(/[^A-Za-z0-9_.-]/g, '_').slice(-100);

export const criteria = value => (value || '').split(/[\s,]+/).filter(Boolean);

// A finding names a configured criterion letter, quotes the AC line and quotes a referenced Source of the AC.
// The quote must occur in the text of that Source. Writer does not count a sibling or any other node: the auditor checks them.
export function acFindings(input, reviews, digest, letters) {
  const sources = new Map(Object.values(input.references || {}).flat().filter(object).map(node => [node.address, node]));
  const found = new Map();
  for (const review of reviews) {
    if (!object(review) || review.draft_digest !== digest || !Array.isArray(review.ac_findings)) continue;
    for (const row of review.ac_findings) {
      if (!object(row) || !letters.includes(row.criterion) || typeof row.source !== 'string') continue;
      if (!quoted(input.selected, row.ac_quote)) continue;
      if (!sources.has(row.source) || !quoted(sources.get(row.source), row.source_quote)) continue;
      const finding = {criterion: row.criterion, ac_quote: row.ac_quote.trim(), source_quote: row.source_quote.trim(), source: row.source};
      found.set(JSON.stringify(finding), finding);
    }
  }
  return [...found.values()];
}

// route: ready, defect, gap or failure. The operations follow the shared publication format of the host.
export function acOutcome(input, route, {readyStage, returnStage, limit, stuckTag, gapTag = '', run, reason = '', findings = []}) {
  const selected = input.selected, data = selected.document.data || {};
  const fields = input.schema?.types?.[selected.kind]?.fields || {};
  const stage = {ready: readyStage, defect: returnStage}[route];
  need(!stage || (fields.stage?.values || []).includes(stage), 'The schema of ' + selected.kind + ' has no stage ' + stage);
  need(fields.returns && fields.tags, 'The schema of ' + selected.kind + ' needs the returns and tags fields');
  const counted = route === 'defect' || route === 'failure';
  const returns = route === 'ready' ? 0 : counted ? (Number.isInteger(data.returns) ? data.returns : 0) + 1 : data.returns;
  const stuck = counted && returns >= Number(limit);
  const added = [...(route === 'gap' && gapTag ? [gapTag] : []), ...(stuck ? [stuckTag] : [])];
  const tags = added.some(tag => !(data.tags || []).includes(tag)) ? [...new Set([...(data.tags || []), ...added])] : undefined;
  const change = {...(stage ? {stage} : {}), ...(counted || route === 'ready' ? {returns} : {}), ...(tags ? {tags} : {})};
  const line = {ready: 'Writer approved the Tests. The AC goes to ' + readyStage + '.',
    defect: 'Writer found an AC defect. The AC goes to ' + returnStage + '.',
    gap: 'Writer needs an owner decision. The AC keeps its stage.',
    failure: 'Writer did not get approved Tests. The AC keeps its stage.'}[route] +
    (counted ? ' Returns: ' + returns + '.' : '') + (stuck ? ' The returns limit adds the tag ' + stuckTag + '.' : '');
  const operations = Object.keys(change).length ? [{command: {op: 'save_object', kind: selected.kind, id: local(selected.address),
    revision: input.claim_revision, data: change, reason: line}}] : [];
  if (route === 'defect') {
    operations.push({command: {op: 'note', target: selected.address, id: noteId('writer-ac-defect-', run),
      text: line + '\n' + findings.map(row => '- ' + row.criterion + ': "' + row.ac_quote + '" breaks "' + row.source_quote + '" (' + row.source + ')')
        .join('\n') + '\nAC revision: ' + selected.current_revision + '. Run: ' + run}});
  } else if (route !== 'ready' && reason) {
    operations.push({command: {op: 'note', target: selected.address, id: noteId(route === 'gap' ? 'writer-missing-' : 'writer-rejected-', run),
      text: line + '\n' + reason}});
  }
  if (stuck) {
    operations.push({command: {op: 'note', target: selected.address, id: noteId('writer-stuck-', run),
      text: 'Question to the Owner: Writer failed on this AC ' + returns + ' times, and the limit is ' + limit + '. ' +
        'What must change in the AC or its Sources before Writer tries again? ' +
        'After your answer, remove the tag ' + stuckTag + ' and set returns to 0. Run: ' + run}});
  }
  return operations;
}
