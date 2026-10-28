// Render the stored Task without changing its document or claim digest.
export function taskContract(data) {
  const require = (ok, message) => { if (!ok) throw new Error(message); };
  const text = value => typeof value === 'string' && value.trim();
  require(text(data?.contract), 'Task needs an implementation contract');
  if (!Object.hasOwn(data, 'steps')) return data.contract;
  for (const key of ['repository', 'module']) {
    require(text(data[key]) && !/[\r\n]/.test(data[key]), `Structured Task needs ${key}`);
  }
  for (const key of ['steps', 'checks']) {
    require(Array.isArray(data[key]) && data[key].length && data[key].every(text), `Structured Task needs ${key}`);
  }
  const steps = [...data.steps], lines = [data.contract, '', `Repository: ${data.repository}`,
    `Module: ${data.module}`, '', 'How:'];
  if (steps[0].startsWith('0. ')) lines.push(steps.shift());
  lines.push(...steps.map((step, index) => `${index + 1}. ${step.replace(/^\s*\d+\.\s+/, '')}`),
    '', 'Checks:', ...data.checks);
  return lines.join('\n');
}
