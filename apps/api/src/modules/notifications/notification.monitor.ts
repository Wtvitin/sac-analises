import { generateTemporalNotifications } from './notification.service.js';

const CHECK_INTERVAL_MS = 15 * 60_000;
let running = false;

export async function runNotificationCheck() {
  if (running) return { acquired: false, created: 0 };
  running = true;
  try { return await generateTemporalNotifications(); }
  finally { running = false; }
}

/** Local scheduler. Multi-instance hosting can move this call to a worker or external scheduler. */
export function startNotificationMonitor() {
  void runNotificationCheck().catch(error => console.error('Falha ao verificar alertas temporais.', error));
  const timer = setInterval(() => void runNotificationCheck().catch(error => console.error('Falha ao verificar alertas temporais.', error)), CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
