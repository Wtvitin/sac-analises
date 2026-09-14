import { validateEnvironment } from './config.js';
import { app } from './app.js';

const { port } = validateEnvironment();
app.listen(port, () => console.log(`SAC Análises API disponível em http://localhost:${port}`));
