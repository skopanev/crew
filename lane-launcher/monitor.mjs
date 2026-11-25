// A read-only Dolber monitor polls counts separately from screen redraws.
import {createDashboard} from './dashboard.mjs';
import {refreshAvailability} from './availability.mjs';

export async function monitorDashboard(config, paint) {
  const dashboard = createDashboard({...config, monitorOnly: true}, paint);
  const abort = new AbortController();
  dashboard.state.message = '';
  let ticker, counter, stop, pending;
  const draw = () => {
    try { dashboard.refresh(); dashboard.draw(null); }
    catch (error) { dashboard.state.fail(error.message); }
  };
  const poll = async () => {
    if (pending || abort.signal.aborted) return;
    pending = refreshAvailability(config, dashboard.state, abort.signal);
    try { await pending; if (!abort.signal.aborted) draw(); }
    finally { pending = null; }
  };
  try {
    draw(); void poll();
    ticker = setInterval(draw, 5000);
    counter = setInterval(() => { void poll(); }, config.intervalSeconds * 1000);
    await new Promise(resolve => {
      stop = () => { abort.abort(); resolve(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  } finally {
    clearInterval(ticker); clearInterval(counter); abort.abort();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await pending;
    dashboard.close();
  }
}
