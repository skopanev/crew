// Render the stored Task without changing its document or claim digest.
export const taskBody = data => data && Object.hasOwn(data, 'body') ? data.body : data?.contract;

// Read repository scope before checking whether a Task has executable steps.
export function repositoryDeclarations(data) {
  const body = taskBody(data), repository = data?.repository;
  const contract = [typeof body === 'string' ? body : '',
    ...(Object.hasOwn(data || {}, 'steps') && typeof repository === 'string' && repository.trim()
      ? [`Repository: ${repository}`] : [])].join('\n');
  return [...contract.matchAll(/^Repository:[ \t]*(\S[^\r\n]*)$/gm)].map(match => match[1].trim());
}

export function taskContract(data) {
  const require = (ok, message) => { if (!ok) throw new Error(message); };
  const text = value => typeof value === 'string' && value.trim();
  const body = taskBody(data);
  require(text(body), 'Task needs an implementation contract');
  if (!Object.hasOwn(data, 'steps')) return body;
  for (const key of data.module === undefined ? ['repository'] : ['repository', 'module']) {
    require(text(data[key]) && !/[\r\n]/.test(data[key]), `Structured Task needs ${key}`);
  }
  require(Array.isArray(data.steps) && data.steps.length && data.steps.every(text), 'Structured Task needs steps');
  // Checks are optional: a Task without them is verified by the tests of its criterion.
  const checks = data.checks ?? [];
  require(Array.isArray(checks) && checks.every(text), 'Structured Task checks must be text lines');
  const steps = [...data.steps], lines = [body, '', `Repository: ${data.repository}`,
    ...(data.module === undefined ? [] : [`Module: ${data.module}`]), '', 'How:'];
  if (steps[0].startsWith('0. ')) lines.push(steps.shift());
  lines.push(...steps.map((step, index) => `${index + 1}. ${step.replace(/^\s*\d+\.\s+/, '')}`));
  if (checks.length) lines.push('', 'Checks:', ...checks);
  return lines.join('\n');
}
