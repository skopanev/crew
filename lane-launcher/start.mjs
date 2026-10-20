import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {command, herdr, quote, read} from './runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const usage = 'sh lane-launcher/start.sh CONFIG.json [--dry-run]';
const scripts = {auditor: 'auditor-joppa.sh', dolber: 'dolber-joppa.sh', planner: 'planner-joppa.sh'};

try {
  const [file, ...options] = process.argv.slice(2);
  if (!file || file.startsWith('-') || options.some(option => option !== '--dry-run')) throw new Error(usage);
  const dryRun = options.includes('--dry-run');
  const manifest = path.resolve(file), config = read(manifest);
  if (typeof config?.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(config.name)) {
    throw new Error('Config needs a name with letters, digits, dots, underscores or hyphens');
  }
  const prepare = config.prepare;
  if (prepare !== undefined && (!Array.isArray(prepare) || !prepare.length ||
      prepare.some(arg => typeof arg !== 'string' || !arg.trim() || /[\x00-\x1f\x7f]/.test(arg)))) {
    throw new Error('prepare must contain an executable and plain argument strings');
  }
  const actions = Object.entries(scripts).map(([action, script]) => {
    const entry = config[action];
    if (!entry || typeof entry.config !== 'string' || !entry.config.trim()) throw new Error(`Config needs ${action}.config`);
    const args = entry.args ?? [];
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || /[\x00-\x1f\x7f]/.test(arg))) {
      throw new Error(`${action}.args must contain plain argument strings`);
    }
    const target = path.resolve(path.dirname(manifest), entry.config);
    const targetConfig = read(target);
    if (!targetConfig || typeof targetConfig !== 'object' || Array.isArray(targetConfig)) {
      throw new Error(`${action}.config must contain a JSON object`);
    }
    return {label: `${action}|${config.name}`,
      command: ['sh', path.join(here, script), target, ...args].map(quote).join(' ')};
  });
  if (dryRun) {
    if (prepare) console.log(`prepare\n  ${prepare.map(quote).join(' ')}`);
    for (const action of actions) console.log(`${action.label}\n  ${action.command}`);
  } else {
    if (process.env.HERDR_ENV !== '1' || !process.env.HERDR_WORKSPACE_ID) {
      throw new Error('Run this command from a Herdr pane');
    }
    const terminal = {herdr: process.env.HERDR_BIN_PATH || 'herdr'};
    const workspace = process.env.HERDR_WORKSPACE_ID;
    const tabs = herdr(terminal, ['tab', 'list', '--workspace', workspace])?.tabs;
    if (!Array.isArray(tabs)) throw new Error('Herdr returned no tab list');
    const existing = actions.filter(action => tabs.some(tab => tab.label === action.label));
    if (existing.length) throw new Error(`Tabs already exist: ${existing.map(action => action.label).join(', ')}`);
    if (prepare) command(prepare[0], prepare.slice(1));
    for (const action of actions) {
      const result = herdr(terminal, ['tab', 'create', '--workspace', workspace,
        '--cwd', path.dirname(here), '--label', action.label, '--no-focus']);
      const pane = result?.root_pane?.pane_id;
      if (!pane) throw new Error(`Herdr returned no pane for ${action.label}; inspect tabs before retrying`);
      herdr(terminal, ['pane', 'run', pane, action.command]);
      console.log(`${action.label} · ${pane}`);
    }
  }
} catch (error) {
  console.error(`start: ${error.message}`);
  process.exitCode = 2;
}
