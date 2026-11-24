import {runHostHook} from './pre-launch.mjs';

export function validateHostMaintenance(config) {
  const value = config.hostMaintenance;
  if (value == null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Array.isArray(value.command) || !value.command.length ||
      value.command.some(arg => typeof arg !== 'string' || !arg.trim() || arg.includes('\0'))) {
    throw new Error('hostMaintenance.command must be a nonempty command argument array');
  }
  for (const key of ['intervalSeconds', 'timeoutSeconds']) {
    const seconds = value[key] ?? (key === 'intervalSeconds' ? 30 : 120);
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 2147483) {
      throw new Error(`hostMaintenance.${key} must be 1 to 2147483`);
    }
  }
}

export function startHostMaintenance(initial, onError = console.error) {
  let config = initial, timer, active, controller, stopped = false;
  const schedule = () => {
    if (stopped || config.launchLanes !== true || config.hostMaintenance == null) return;
    timer = setTimeout(tick, (config.hostMaintenance.intervalSeconds ?? 30) * 1000);
    timer.unref();
  };
  const tick = async () => {
    const current = config, value = current.hostMaintenance;
    controller = new AbortController();
    active = runHostHook(current, current.stateDir, {args: value.command,
      seconds: value.timeoutSeconds ?? 120, name: 'host-maintenance', prefix: 'HOST_MAINTENANCE',
      signal: controller.signal, validate: () => validateHostMaintenance(current)});
    try { await active; }
    catch (error) { if (!stopped) onError(error.message); }
    finally { active = null; controller = null; schedule(); }
  };
  schedule();
  return {
    use(next) {
      validateHostMaintenance(next);
      config = next;
      if (!active) { clearTimeout(timer); schedule(); }
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      await active?.catch(() => {});
    },
  };
}
