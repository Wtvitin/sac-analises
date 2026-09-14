import { validateEnvironment } from './config.js';
import { app } from './app.js';
import { startNotificationMonitor } from './modules/notifications/notification.monitor.js';

const { port } = validateEnvironment();
app.listen(port, () => console.log(`SAC Análises API disponível em http://localhost:${port}`));
startNotificationMonitor();
