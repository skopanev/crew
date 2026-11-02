// Map a gate-bound JUnit report to joppa_record_results requests.
// The workspace tree schema test_results block supplies every rule.
// These results are test evidence. They do not accept a criterion.
const require = (condition, message) => { if (!condition) throw new Error(message); };
const PLACEHOLDER = /\{(?:suite\.)?[A-Za-z_][A-Za-z0-9_-]*\}/g;
const ONE_PLACEHOLDER = new RegExp(PLACEHOLDER.source);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

export function validateTestReport(value) {
  require(isObject(value) && Object.keys(value).sort().join() === 'format,identity,path',
    'testReport needs exactly path, format and identity');
  const {path, format, identity} = value;
  require(typeof path === 'string' && path && !path.startsWith('/') && !path.includes('\\') &&
    path.split('/').every(part => part && part !== '.' && part !== '..'),
  'testReport.path must be a relative path inside the report folder');
  require(format === 'junit', 'testReport.format must be junit');
  require(typeof identity === 'string' && ONE_PLACEHOLDER.test(identity) &&
    !/[{}]/.test(identity.replace(PLACEHOLDER, '')),
  'testReport.identity needs {attribute} or {suite.attribute} placeholders only');
  return value;
}

export function resultRules(tree) {
  const rules = tree?.schema?.test_results;
  require(isObject(rules), 'Workspace schema has no test_results block');
  require(isObject(rules.statuses), 'test_results.statuses is missing');
  require(isObject(rules.name) && typeof rules.name.separator === 'string' && rules.name.separator,
    'test_results.name.separator is missing');
  require(positive(rules.max_results), 'test_results.max_results is missing');
  require(Array.isArray(rules.fields ?? []), 'test_results.fields is invalid');
  return rules;
}

export function statusName(rules, outcome) {
  const names = Object.entries(rules.statuses).filter(([, value]) => value === outcome).map(([name]) => name);
  if (names.includes(outcome)) return outcome;
  require(names.length === 1, names.length
    ? `test_results.statuses has several names for ${outcome}: ${names.join(', ')}`
    : `test_results.statuses has no name for ${outcome}`);
  return names[0];
}

export function nameProblem(name, rule) {
  const parts = name.split(rule.separator);
  if (positive(rule.max_length) && Array.from(name).length > rule.max_length) return `longer than ${rule.max_length} characters`;
  if (Number.isSafeInteger(rule.min_parts) && parts.length < rule.min_parts) {
    return `fewer than ${rule.min_parts} parts separated by ${JSON.stringify(rule.separator)}`;
  }
  if (parts.some(part => !part || part !== part.trim())) return 'an empty or untrimmed part';
  if (rule.file_extension === true && !/\.[A-Za-z0-9]+$/.test(parts[0])) return 'a first part without a file extension';
  return null;
}

const truncate = (text, limit) => positive(limit) ? Array.from(text).slice(0, limit).join('') : text;

// Build every request before any write. A rule failure means no request at all.
export function buildRequests({workspace, commit, cases, rules}) {
  require(/^[0-9a-f]{40,64}$/.test(commit), 'Commit must be a lowercase Git SHA');
  require(Array.isArray(cases) && cases.length > 0, 'Report has no results');
  const fields = rules.fields || [];
  const failure = fields.find(field => field.name === rules.failure_field && field.type === 'text');
  const duration = fields.find(field => field.name === 'duration_ms' && field.type === 'number');
  const names = new Set();
  const results = cases.map(item => {
    require(isObject(item) && typeof item.test === 'string', 'Report result is invalid');
    require(!names.has(item.test), `Ambiguous report: two results name ${JSON.stringify(item.test)}`);
    names.add(item.test);
    const problem = nameProblem(item.test, rules.name);
    require(!problem, `Test name ${JSON.stringify(item.test)} fails the workspace name rule: ${problem}`);
    require(['pass', 'fail', 'skip'].includes(item.outcome), `Report result ${item.test} has no outcome`);
    const result = {test: item.test, status: statusName(rules, item.outcome)};
    if (item.outcome === 'fail' && failure) result[failure.name] = truncate(String(item.message || 'failure'), failure.max_length);
    if (duration && Number.isFinite(item.time) && item.time >= 0) result[duration.name] = Math.round(item.time * 1000);
    for (const field of fields) {
      require(!field.required || field.name in result,
        `Required result field ${field.name} has no source in the report`);
    }
    return result;
  });
  const requests = [];
  for (let index = 0; index < results.length; index += rules.max_results) {
    requests.push({workspace, commit, results: results.slice(index, index + rules.max_results)});
  }
  return requests;
}
