import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {command, require, text} from './common.mjs';
import {prepareContext} from '../lane-launcher/context-config.mjs';

const adapter = fileURLToPath(new URL('../lane/hooks/joppa-data.sh', import.meta.url));

export function contract(settings) {
  const config = settings.context, name = config?.roles?.auditor;
  require(text(name) && text(config.phase_kind), 'Audit context needs roles.auditor and phase_kind');
  const fields = config.phase_fields;
  require(text(fields?.audit) && text(fields?.review), 'Audit context needs both configured phase fields');
  require(Array.isArray(config.session?.fields) && Object.values(fields).every(field => config.session.fields.includes(field)),
    'Audit context session.fields must include both phase fields');
  const context = prepareContext(config, {project: settings.project}, {container: false});
  const env = {...process.env, LANE_MEMORY_CONFIG: context.configFile,
    LANE_MEMORY_ROLE: name, LANE_MEMORY_PROCESS: name, LANE_MEMORY_PROJECT: settings.project};
  try {
    const reply = JSON.parse(command('bash', [adapter, 'session'], {env}));
    require(Array.isArray(reply.items) && reply.items.length > 0 && reply.items.every(item =>
      text(item.address) && Number.isSafeInteger(item.revision) && item.revision > 0), 'Audit context is incomplete');
    require(reply.items.filter(item => item.kind === config.phase_kind).length === 1,
      'Audit context needs exactly one selected process');
    const renderFields = config.session.fields.filter(field => !Object.values(fields).includes(field));
    const phase = field => {
      const items = reply.items.map(item => {
        if (item.kind !== config.phase_kind) return item;
        require(text(item[field]), `Audit context is missing the configured ${field} text`);
        return {...item, body: item[field]};
      });
      return command('bash', [adapter, 'render', JSON.stringify(renderFields)],
        {env, input: JSON.stringify({...reply, items})});
    };
    const audit = phase(fields.audit), review = phase(fields.review), content = `${audit}\n\n${review}`;
    return {content, audit, review, record_ids: reply.items.map(item => `${item.address}@${item.revision}`),
      digest: createHash('sha256').update(content).digest('hex')};
  } finally { fs.rmSync(context.dir, {recursive: true, force: true}); }
}
