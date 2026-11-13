import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const defaultWorkflow = fileURLToPath(new URL('../lane/workflow.yaml', import.meta.url));

// Medulla mounts the directory of an outside definition read-only and reads its workflow.yaml.
export function validateWorkflow(file = defaultWorkflow) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== 'workflow.yaml') {
    throw new Error('Config needs workflow: an absolute path to a workflow.yaml file');
  }
  let stat;
  try { stat = fs.lstatSync(file); } catch { stat = null; }
  if (!stat?.isFile() || !stat.size) throw new Error(`Workflow file must be a nonempty regular file: ${file}`);
  return file;
}

// The worker passes an empty value for the bundled lane workflow.
export function workflowFile(file = defaultWorkflow) {
  const resolved = fs.realpathSync(validateWorkflow(file));
  return resolved === fs.realpathSync(defaultWorkflow) ? '' : resolved;
}

// Record the selected file bytes, including custom models, prompts and timeouts.
export function workflowDigest(file = defaultWorkflow) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// A custom author explicitly declares support for the retained checkout handoff.
export function supportsRetainedCheckout(file = defaultWorkflow) {
  const declarations = fs.readFileSync(file, 'utf8').match(/^  RETAINED_CHECKOUT_PROTOCOL:[^\n]*/gm) || [];
  return declarations.length === 1 && /^  RETAINED_CHECKOUT_PROTOCOL:[ \t]+(?:1|'1'|"1")[ \t]*\r?$/.test(declarations[0]);
}
