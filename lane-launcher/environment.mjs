// Install a configured panel environment. Existing environments retain their code until an operator removes them.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const need = (ok, message) => { if (!ok) throw new Error(message); };
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value && typeof value === 'object' ?
  Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) :
    Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
const fieldParts = field => {
  const parts = field.split('.');
  need(parts.length && parts.every(part => /^(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9][0-9]*)$/.test(part) &&
    !['__proto__', 'prototype', 'constructor'].includes(part)), 'Invalid environment field');
  return parts;
};
const write = (file, text) => {
  const temporary = file + '.' + randomUUID();
  try { fs.writeFileSync(temporary, text, {flag: 'wx', mode: 0o600}); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
};

export function installEnvironment(spec, base = process.cwd()) {
  need(spec && typeof spec === 'object' && !Array.isArray(spec), 'An environment specification is required');
  need(typeof spec.root === 'string' && spec.root, 'Configure the environment root');
  need(spec.sources && typeof spec.sources === 'object' && !Array.isArray(spec.sources), 'Configure code sources');
  const sources = Object.fromEntries(Object.entries(spec.sources).map(([name, source]) => {
    need(/^[a-z][a-z0-9_-]*$/.test(name) && !['config', 'environment'].includes(name), 'Invalid source name');
    need(typeof source.repository === 'string' && typeof source.ref === 'string', 'A source needs repository and ref');
    const repository = fs.realpathSync(path.resolve(base, source.repository));
    need(fs.realpathSync(git(repository, 'rev-parse', '--show-toplevel')) === repository, 'A source must name its Git root');
    const sha = git(repository, 'rev-parse', '--verify', '--end-of-options', source.ref + '^{commit}');
    need(/^[a-f0-9]{40,64}$/.test(sha), 'A source must resolve to a Git commit');
    return [name, {repository, sha}];
  }));
  need(Object.keys(sources).length > 0 && sources[spec.config?.source], 'Configure a tracked panel config source');
  const configPath = spec.config.path;
  need(typeof configPath === 'string' && configPath && !path.isAbsolute(configPath) &&
    !configPath.split(/[\\/]/).includes('..'), 'The panel config must be inside its source');
  const origin = sources[spec.config.source];
  const raw = git(origin.repository, 'show', origin.sha + ':' + configPath);
  const config = JSON.parse(raw);
  need(config && typeof config === 'object' && !Array.isArray(config), 'The panel config must be an object');
  const bindings = spec.bindings ?? {}, external = spec.external ?? [];
  need(bindings && typeof bindings === 'object' && !Array.isArray(bindings) &&
    Object.values(bindings).every(value => typeof value === 'string'), 'Bindings must map exact fields to paths');
  need(Array.isArray(external) && external.every(value => typeof value === 'string'), 'External fields must be an array');
  for (const key of [...Object.keys(bindings), ...external]) fieldParts(key);
  need(external.every(key => !Object.hasOwn(bindings, key)), 'A field cannot be both pinned and external');
  need(Array.isArray(spec.command) && spec.command.length && spec.command.every(value => typeof value === 'string' && value),
    'Configure the panel command as an argument array');
  const identity = {sources, config: spec.config, configDigest: digest(raw), bindings, external, command: spec.command};
  const id = digest(canonical(identity));
  const root = path.resolve(base, spec.root);
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  need(!Object.values(sources).some(source => inside(source.repository, fs.realpathSync(root))),
    'Store environments outside the code sources');
  const folder = path.join(fs.realpathSync(root), id), lock = folder + '.lock';
  try { fs.mkdirSync(lock, {mode: 0o700}); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('This environment is being installed; inspect its lock before retrying');
    throw error;
  }
  try {
    fs.writeFileSync(path.join(lock, 'owner'), String(process.pid), {flag: 'wx', mode: 0o600});
    fs.mkdirSync(folder, {recursive: true, mode: 0o700});
    need(!fs.lstatSync(folder).isSymbolicLink(), 'The environment directory cannot be a symlink');
    const roots = {};
    for (const [name, source] of Object.entries(sources)) {
      const target = path.join(folder, name);
      if (!fs.existsSync(target)) git(source.repository, 'worktree', 'add', '--detach', target, source.sha);
      need(!fs.lstatSync(target).isSymbolicLink() && fs.realpathSync(target) === target &&
        fs.realpathSync(git(target, 'rev-parse', '--show-toplevel')) === target &&
        git(target, 'rev-parse', 'HEAD') === source.sha, 'A code snapshot has the wrong identity');
      need(!git(target, 'status', '--porcelain', '--untracked-files=all'), 'A code snapshot has local changes');
      need(git(target, 'rev-parse', '--path-format=absolute', '--git-common-dir') ===
        git(source.repository, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'A code snapshot belongs to another Git repository');
      need(git(target, 'rev-parse', '--abbrev-ref', 'HEAD') === 'HEAD', 'A snapshot must be detached');
      roots[name] = target;
    }
    const values = {...roots, environment: folder, config: path.join(folder, 'config.json')};
    const expand = value => value.replace(/\{([a-z][a-z0-9_-]*)\}/g, (_, name) => {
      need(Object.hasOwn(values, name), 'Unknown environment placeholder'); return values[name];
    });
    const pinned = value => {
      need(path.isAbsolute(value) && fs.existsSync(value), 'A pinned code path must exist and be absolute');
      const real = fs.realpathSync(value);
      need(Object.values(roots).some(root => inside(root, real)), 'A pinned code path escapes its snapshot');
    };
    for (const [field, value] of Object.entries(bindings)) {
      const parts = fieldParts(field), key = parts.pop(); let parent = config;
      for (const part of parts) { need(Object.hasOwn(parent, part) && parent[part] && typeof parent[part] === 'object',
        'A bound field parent is absent'); parent = parent[part]; }
      need(Object.hasOwn(parent, key) && typeof parent[key] === 'string', 'A bound field must already contain a string');
      parent[key] = expand(value); pinned(parent[key]);
    }
    const originDirectory = path.dirname(path.join(roots[spec.config.source], configPath));
    const check = (value, field = '') => {
      if (typeof value === 'string' && !Object.hasOwn(bindings, field) && !external.includes(field)) {
        const resolved = path.resolve(originDirectory, value);
        const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
        const isPath = path.isAbsolute(value) || value.startsWith('./') || value.startsWith('../') || fs.existsSync(resolved);
        need(!Object.values(sources).some(source => (path.isAbsolute(value) && inside(source.repository, resolved)) ||
          value.includes(source.repository + path.sep)) &&
          !(!path.isAbsolute(value) && isPath && Object.values(roots).some(root => inside(root, resolved) || inside(root, real))),
          'Declare a binding or exact external field for live source path: ' + field);
      } else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) check(item, field ? field + '.' + key : key);
      }
    };
    check(config);
    const bytes = JSON.stringify(config, null, 2) + '\n', file = values.config;
    const command = spec.command.map(expand);
    check(command);
    for (const value of command) {
      const candidate = /^--?[A-Za-z0-9_-]+=(.*)$/.exec(value)?.[1] ?? value;
      const normalized = path.resolve(folder, candidate);
      const isPath = candidate && (path.isAbsolute(candidate) || candidate.includes('/') || fs.existsSync(normalized));
      if (isPath && inside(folder, normalized) && normalized !== file) pinned(normalized);
      else need(!Object.values(roots).some(root => value.includes(root)),
        'A snapshot command path must be an argument or an option value');
    }
    const manifest = {id, ...identity, folder, config: file, configDigest: digest(bytes), command};
    const ready = path.join(folder, 'environment.json');
    if (fs.existsSync(ready)) {
      need(fs.readFileSync(ready, 'utf8') === JSON.stringify(manifest, null, 2) + '\n' &&
        fs.readFileSync(file, 'utf8') === bytes, 'The installed environment changed');
    } else {
      write(file, bytes);
      write(ready, JSON.stringify(manifest, null, 2) + '\n');
    }
    return manifest;
  } finally { fs.rmSync(lock, {recursive: true}); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const [file, flag, ...extra] = process.argv.slice(2);
    need(file && (!flag || flag === '--run') && !extra.length, 'Usage: node environment.mjs SPEC.json [--run]');
    const manifest = installEnvironment(JSON.parse(fs.readFileSync(file, 'utf8')), path.dirname(path.resolve(file)));
    if (flag !== '--run') console.log(JSON.stringify(manifest, null, 2));
    else {
      const child = spawn(manifest.command[0], manifest.command.slice(1), {cwd: manifest.folder, env: process.env, stdio: 'inherit'});
      const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
      process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
      child.on('error', error => { console.error(error.message); process.exitCode = 2; });
      child.on('close', (code, signal) => {
        process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
        process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : signal ? 130 : 2);
      });
    }
  } catch (error) { console.error('environment: ' + error.message); process.exitCode = 2; }
}
