export const kind = 'test';
export const node = id => ({address: 'test:' + id, kind, current_revision: 7,
  relations: {related: {title: 'Evidence', edges: [{to: 'source:s'}]}},
  document: {present: true, parent: 'ac:a', data: {title: `spec/${id}.test.ts > ${id}`,
    body: 'Current ' + id, case: id, owner: 'test-owner', command: 'retained command',
    results: [{revision: 2, status: 'pass'}], metadata: {retain: true}}}});
export const input = () => ({selected: {address: 'ac:a', kind: 'ac', current_revision: 10,
  document: {present: true, data: {title: 'Current AC', body: 'Keep k, correct u, remove r, add a missing behavior.', owner: 'ac-owner', tags: ['keep']}}},
  claim_revision: 11, children: ['k', 'u', 'r'].map(node), references: {sources: []},
  schema: {types: {ac: {role: 'ac', fields: {stage: {type: 'enum', values: ['to_decide', 'to_prepare', 'to_task']},
    returns: {type: 'number'}, tags: {type: 'list'}}}, test: {role: 'test', title_max_length: 150, field_max_length: 1000,
    required_fields: ['body'], fields: {body: {from: 'own'}, case: {from: 'own'}}}},
    test_results: {max_tests: 200, name: {separator: ' > ', min_parts: 2, max_length: 150}}}});
export const draft = () => ({tests: [
  {id: 'k', action: 'keep', title: node('k').document.data.title, data: {}},
  {id: 'u', action: 'update', title: node('u').document.data.title, data: {body: 'Correct current acceptance text.'},
    finding: {test_quote: 'Current u', reason_code: 'SCOPE_MISMATCH'}},
  {id: 'new_1', action: 'create', title: 'spec/new.test.ts > missing behavior', data: {body: 'Required missing acceptance text.'}}],
  retire: [{id: 'r', reason: 'This behavior is no longer required.', evidence: 'Current AC explicitly removes r.'}], coverage: 'The final set covers k, corrected u and the missing behavior.'});
export const review = (plan, digest = 'exact') => ({draft_digest: digest,
  tests: plan.tests.map(row => ({id: row.id, score: '11111', reasons: []})),
  retirements: plan.retire.map(row => ({id: row.id, agree: true, evidence: row.evidence})),
  updates: plan.tests.filter(row => row.action === 'update').map(row => ({id: row.id, agree: true, evidence: 'The captured Test does not cover the current AC.'})),
  coverage: 'complete', missing: [], summary: 'Every final Test and retirement matches the current AC and Sources.'});
