import { validateEnvironment } from './config.js';
import { app } from './app.js';
import { startNotificationMonitor } from './modules/notifications/notification.monitor.js';
import { isRealEmailDeliveryConfigured } from './lib/email/email.service.js';

const { port } = validateEnvironment();
app.listen(port, () => {
  const emailAdapterType = isRealEmailDeliveryConfigured() ? 'SMTP real (Gmail)' : 'Prévia local';
  console.log(`SAC Análises API disponível em http://localhost:${port}`);
  console.log(`[Email] Adaptador selecionado: ${emailAdapterType}`);
});
startNotificationMonitor();
