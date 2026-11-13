import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = (condition, message) => { if (!condition) throw new Error(message); };
const text = value => typeof value === 'string' && Boolean(value.trim());

export function validateContext(config) {
  require(config && typeof config === 'object' && !Array.isArray(config), 'Config needs context');
  require(text(config.workspace), 'context.workspace is required');
  const url = new URL(config.url);
  require(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    'context.url needs an HTTP endpoint without URL credentials');
  require(config.root === undefined || text(config.root), 'context.root must be nonempty when present');
  require(text(config.token_file) && path.isAbsolute(config.token_file), 'context.token_file must be absolute');
  const stat = fs.statSync(config.token_file);
  require(stat.isFile() && (stat.mode & 0o077) === 0, 'context.token_file must be a private file');
  require(config.session && config.stop && text(config.stop.field), 'context needs session and stop selections');
  for (const selection of [config.session, config.stop, config.query].filter(Boolean)) {
    require((typeof selection.kind === 'string' && text(selection.kind)) ||
      Array.isArray(selection.kind) && selection.kind.length > 0 && selection.kind.every(text),
      'Each context selection needs configured kind names');
  }
  for (const bindings of [config.filter_env, config.session.filter_env, config.stop.filter_env, config.query?.filter_env].filter(Boolean)) {
    require(typeof bindings === 'object' && !Array.isArray(bindings) && Object.entries(bindings).every(([field, env]) =>
      text(field) && typeof env === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(env)),
    'context.filter_env must map field names to environment variable names');
  }
  const token = fs.readFileSync(config.token_file, 'utf8').trim();
  require(/^jpr_[0-9a-f]{64}$/.test(token), 'context.token_file must contain a workspace Read key');
  return config;
}

// Only the workspace Read key and its request settings enter the lane container.
export function prepareContext(config, assignment, {container = true} = {}) {
  validateContext(config);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-context-')));
  try {
    fs.chmodSync(dir, 0o700);
    fs.copyFileSync(config.token_file, path.join(dir, 'token'));
    fs.chmodSync(path.join(dir, 'token'), 0o600);
    const root = container ? `/workspace/${path.basename(dir)}` : dir;
    const settings = {...config, token_file: `${root}/token`, assignment: {...config.assignment, ...assignment}};
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(settings) + '\n', {mode: 0o600});
    return {dir, configFile: `${root}/config.json`};
  } catch (error) {
    fs.rmSync(dir, {recursive: true, force: true});
    throw error;
  }
}
