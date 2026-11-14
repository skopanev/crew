const require = (ok, message) => { if (!ok) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim();
const SCOPE = ['repository', 'module'];
// Render the stored Task without changing its document or claim digest.
export const taskBody = data => data && Object.hasOwn(data, 'body') ? data.body : data?.contract;

// taskFields maps repository and module to "body:<line label>" or "data:<field.path>". Crew has no default label.
export function validateTaskFields(config) {
  const fields = config.taskFields;
  if (fields === undefined) return;
  require(fields !== null && typeof fields === 'object' && !Array.isArray(fields) &&
    Object.keys(fields).every(key => SCOPE.includes(key)) && Object.values(fields).every(spec => typeof spec === 'string' &&
      /^(?:body:[^\s:][^\r\n:]*|data:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/.test(spec) && spec === spec.trimEnd()),
  'taskFields maps repository and module to "body:<line label>" or "data:<field.path>"');
}

// The values that a Task declares for one scope field. taskFields is the only source, also for structured Tasks.
function declared(config, data, name) {
  const spec = config?.taskFields?.[name], body = taskBody(data);
  if (spec?.startsWith('body:')) {
    if (typeof body !== 'string') return [];
    const label = spec.slice(5).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...body.matchAll(new RegExp(`^${label}:[ \\t]*([^\\r\\n]*)$`, 'gm'))].map(match => match[1].trim());
  }
  if (!spec) return [];
  const path = spec.slice(5);
  const value = path.split('.').reduce((item, key) => item && Object.hasOwn(item, key) ? item[key] : undefined, data);
  if (value === undefined || value === null) return [];
  require(typeof value === 'string' && !/[\r\n]/.test(value), `Task field ${path} must be one line of text`);
  return [value.trim()];
}

// One of this config's repositories, or null for a Task of another repository or with several possible repositories.
export function taskRepositoryChoice(config, data) {
  const repositories = config?.repositories || [], values = declared(config, data, 'repository');
  const known = values.filter(id => repositories.some(repo => repo.id === id));
  if (!known.length) return values.length || repositories.length !== 1 ? null : repositories[0];
  require(values.length === 1, 'Task repository declaration is ambiguous');
  return repositories.find(repo => repo.id === known[0]);
}

// The configured module of the chosen repository. Only a repository with one module needs no declaration.
export function taskModuleChoice(config, repo, data) {
  const values = declared(config, data, 'module');
  require(values.length <= 1, 'Task declares more than one module');
  if (!values.length) {
    require(repo.modules.length === 1, 'Task module is ambiguous: declare one configured module');
    return repo.modules[0];
  }
  const module = repo.modules.find(item => item.name === values[0]);
  require(module, 'Task module is not configured');
  return module;
}

export function taskContract(data) {
  const body = taskBody(data);
  require(text(body), 'Task needs an implementation contract');
  if (!Object.hasOwn(data, 'steps')) return body;
  require(Array.isArray(data.steps) && data.steps.length && data.steps.every(text), 'Structured Task needs steps');
  // Checks are optional: a Task without them is verified by the tests of its criterion.
  const checks = data.checks ?? [];
  require(Array.isArray(checks) && checks.every(text), 'Structured Task checks must be text lines');
  // The rendered contract shows the authored body, steps and checks. Scope comes from taskFields, not from here.
  const steps = [...data.steps], lines = [body, '', 'How:'];
  if (steps[0].startsWith('0. ')) lines.push(steps.shift());
  lines.push(...steps.map((step, index) => `${index + 1}. ${step.replace(/^\s*\d+\.\s+/, '')}`));
  if (checks.length) lines.push('', 'Checks:', ...checks);
  return lines.join('\n');
}
