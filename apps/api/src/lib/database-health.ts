import { prisma } from './prisma.js';

type ProbeResult = { ready: boolean }[];
type Probe = () => Promise<ProbeResult>;

export async function checkDatabaseHealth(probe: Probe = () => prisma.$queryRaw<ProbeResult>`
  SELECT
    to_regclass('public."User"') IS NOT NULL
    AND to_regclass('public."SacRecord"') IS NOT NULL
    AND to_regclass('public."_prisma_migrations"') IS NOT NULL AS ready
`, timeoutMs = 2000) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      probe(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('DATABASE_HEALTH_TIMEOUT')), timeoutMs); }),
    ]);
    return { connected: true, schemaReady: result[0]?.ready === true };
  } catch {
    return { connected: false, schemaReady: false };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
