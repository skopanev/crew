// An optional host command controls selection and each claim mutation attempt.
import fs from 'node:fs';
import {runHostHook} from './pre-launch.mjs';

export function validateDispatchGate(config) {
  const args = config.dispatchGate;
  if (args != null && (!Array.isArray(args) || !args.length ||
      args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !args[0].trim())) {
    throw new Error('dispatchGate must be a command argument array');
  }
  const seconds = config.dispatchGateTimeoutSeconds ?? 60;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 2147483) {
    throw new Error('dispatchGateTimeoutSeconds must be 1 to 2147483');
  }
}

export async function runDispatchGate(config, {dir = config.stateDir, ...options} = {}) {
  if (config.dispatchGate == null) return;
  try {
    validateDispatchGate(config);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    await runHostHook(config, dir, {...options, args: config.dispatchGate,
      seconds: config.dispatchGateTimeoutSeconds ?? 60, name: 'dispatch-gate', prefix: 'DISPATCH_GATE',
      validate: () => validateDispatchGate(config)});
  } catch (error) {
    if (String(error.code || '').startsWith('DISPATCH_GATE_')) throw error;
    throw Object.assign(new Error('DISPATCH_GATE_FAILED: ' + error.message), {code: 'DISPATCH_GATE_FAILED'});
  }
}
