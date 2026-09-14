import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const localEnvPath = fileURLToPath(new URL('../../../.env', import.meta.url));

// Development uses the ignored root .env. Hosted environments provide variables directly.
if (existsSync(localEnvPath)) process.loadEnvFile(localEnvPath);

export function validateEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const missing = ['DATABASE_URL', 'JWT_SECRET'].filter(name => !environment[name]?.trim());
  if (missing.length) throw new Error(`Configuração obrigatória ausente: ${missing.join(', ')}.`);
  if (!environment.DATABASE_URL!.startsWith('postgresql://') && !environment.DATABASE_URL!.startsWith('postgres://')) {
    throw new Error('DATABASE_URL deve utilizar PostgreSQL.');
  }
  const port = Number(environment.PORT ?? 3333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve ser uma porta TCP válida.');
  return { port };
}
