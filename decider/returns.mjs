const need = (ok, message) => { if (!ok) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const noteId = (prefix, run) => (prefix + run).replace(/[^A-Za-z0-9_.-]/g, '_').slice(-100);

// The config names the stage, the question tags, the stuck tag and the returns limit. The code names none of them.
export function settings(env) {
  const value = {readyStage: env.READY_STAGE, newStage: env.NEW_STAGE, limit: Number(env.RETURNS_LIMIT), stuckTag: env.STUCK_TAG,
    tags: {cto: env.CTO_TAG, ceo: env.CEO_TAG}};
  need([value.readyStage, value.newStage, value.stuckTag, value.tags.cto, value.tags.ceo].every(text) && Number.isSafeInteger(value.limit) && value.limit > 0,
    'Configure READY_STAGE, NEW_STAGE, RETURNS_LIMIT, STUCK_TAG, CTO_TAG and CEO_TAG');
  return value;
}

// The schema of the selected kind must hold the ready stage and the returns and tags fields.
export function schemaFields(input, value) {
  const fields = input.schema?.types?.[input.selected.kind || 'ac']?.fields || {};
  for (const stage of [value.readyStage, value.newStage]) need((fields.stage?.values || []).includes(stage), 'The AC schema has no stage ' + stage);
  need(fields.returns && fields.tags, 'The AC schema needs the returns and tags fields');
}

// A failed step (a well-formed critic rejection) keeps the stage, adds 1 to returns and writes the full reason.
// At the limit the AC gets the stuck tag and a question to the Owner.
export function rejected(input, reason, run, config) {
  schemaFields(input, config);
  const node = input.selected, data = node.document.data || {};
  const returns = (Number.isInteger(data.returns) ? data.returns : 0) + 1, stuck = returns >= config.limit;
  const tags = stuck ? [...new Set([...(data.tags || []), config.stuckTag])] : undefined;
  const line = 'Decider did not get an approved decision. The AC keeps its stage. Returns: ' + returns + '.' +
    (stuck ? ' The returns limit adds the tag ' + config.stuckTag + '.' : '');
  const operations = [{command: {op: 'save_object', kind: node.kind || 'ac', id: node.address.split(':')[1], revision: input.claim_revision,
    data: {returns, ...(tags ? {tags} : {})}, reason: line}},
  {command: {op: 'note', target: node.address, id: noteId('decider-rejected-', run), text: line + '\n' + reason}}];
  if (stuck) operations.push({command: {op: 'note', target: node.address, id: noteId('decider-stuck-', run),
    text: 'OPEN QUESTION (Owner, tag ' + config.stuckTag + '): the Decider failed on this AC ' + returns + ' times, and the limit is ' + config.limit +
      '. The reasons are in the Decider notes.\nA ★: change the AC or its Sources by the reasons, then remove the tag ' + config.stuckTag +
      ' and set returns to 0.\nB: archive the AC. Run: ' + run}});
  return {operations, outcome: {status: 'blocked', reason_code: 'REJECTED', reason: line}};
}
