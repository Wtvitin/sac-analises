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
  return { port, ...getSecurityConfig(environment), storage: getStorageConfig(environment) };
}

function positiveInteger(value: string | undefined, fallback: number, name: string, maximum: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} deve ser um inteiro entre 1 e ${maximum}.`);
  return parsed;
}

export function getSecurityConfig(environment: NodeJS.ProcessEnv = process.env) {
  const production = environment.NODE_ENV === 'production';
  const webOrigin = environment.WEB_ORIGIN?.trim() || (production ? '' : 'http://localhost:5173');
  if (!webOrigin || webOrigin === '*' || !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(webOrigin)) throw new Error('WEB_ORIGIN deve conter uma origem HTTP explícita e não pode ser curinga.');
  const trustProxyValue = environment.TRUST_PROXY?.trim() || 'false';
  const trustProxy = trustProxyValue === 'false' ? false : trustProxyValue === 'loopback' ? 'loopback' : Number(trustProxyValue);
  if (trustProxy !== false && trustProxy !== 'loopback' && (!Number.isInteger(trustProxy) || trustProxy < 1 || trustProxy > 3)) throw new Error('TRUST_PROXY deve ser false, loopback ou um número entre 1 e 3.');
  return {
    production,
    webOrigin,
    trustProxy: trustProxy as false | 'loopback' | number,
    accessTokenMinutes: positiveInteger(environment.ACCESS_TOKEN_TTL_MINUTES, 15, 'ACCESS_TOKEN_TTL_MINUTES', 60),
    refreshTokenDays: positiveInteger(environment.REFRESH_TOKEN_TTL_DAYS, 30, 'REFRESH_TOKEN_TTL_DAYS', 90),
  };
}

export function getStorageConfig(environment: NodeJS.ProcessEnv = process.env) {
  const production = environment.NODE_ENV === 'production';
  const driver = (environment.STORAGE_DRIVER || environment.UPLOAD_STORAGE_DRIVER || 'local').toLowerCase().trim();

  if (driver !== 'local' && driver !== 's3') {
    throw new Error('STORAGE_DRIVER deve ser "local" ou "s3".');
  }

  const localUploadDir = environment.LOCAL_UPLOAD_DIR?.trim() || environment.UPLOAD_DIR?.trim() || '';

  if (production && driver === 'local' && !localUploadDir) {
    throw new Error('Em produção, o armazenamento local de evidências exige LOCAL_UPLOAD_DIR configurado.');
  }

  if (production && driver === 's3') {
    if (!environment.S3_BUCKET?.trim() || !environment.S3_REGION?.trim()) {
      throw new Error('Em produção com storage S3, S3_BUCKET e S3_REGION são obrigatórios.');
    }
  }

  return {
    driver,
    localUploadDir,
    maxFileSize: 10 * 1024 * 1024,
    maxAttachmentCount: 5,
    tempExpiryMinutes: positiveInteger(environment.TEMP_UPLOAD_EXPIRY_MINUTES, 60, 'TEMP_UPLOAD_EXPIRY_MINUTES', 1440),
  };
}

