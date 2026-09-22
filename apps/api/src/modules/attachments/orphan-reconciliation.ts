import { readdir, stat, unlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { prisma } from '../../lib/prisma.js';
import { getStorageProvider, LocalStorageProvider } from '../../lib/storage/index.js';

export interface ReconciliationReport {
  timestamp: string;
  dryRun: boolean;
  physicalWithoutRecord: string[];
  recordWithoutPhysical: string[];
  expiredTemporaries: string[];
  pendingRemoval: string[];
  actionsTaken: string[];
}

export interface ReconcileOptions {
  dryRun?: boolean;
  tempExpiryMinutes?: number;
}

/**
 * Recursively scans a directory for relative file paths.
 */
async function scanFilesRecursively(dir: string, baseDir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await scanFilesRecursively(fullPath, baseDir);
        results.push(...subFiles);
      } else if (entry.isFile()) {
        const rel = relative(baseDir, fullPath).replace(/\\/g, '/');
        results.push(rel);
      }
    }
  } catch {
    // Directory might not exist yet
  }
  return results;
}

/**
 * Administrative storage reconciliation routine.
 * Identifies orphan physical files, missing database references, and expired temporary files.
 * Default behavior is strictly read-only (dry-run).
 */
export async function reconcileStorage(options: ReconcileOptions = {}): Promise<ReconciliationReport> {
  const dryRun = options.dryRun !== false; // Default true
  const tempExpiryMinutes = options.tempExpiryMinutes ?? 60;
  const now = Date.now();
  const tempCutoff = now - tempExpiryMinutes * 60 * 1000;

  const provider = getStorageProvider();
  const physicalWithoutRecord: string[] = [];
  const recordWithoutPhysical: string[] = [];
  const expiredTemporaries: string[] = [];
  const pendingRemoval: string[] = [];
  const actionsTaken: string[] = [];

  if (provider instanceof LocalStorageProvider) {
    const baseDir = provider.getBaseDirectory();
    const tempDir = provider.getTempDirectory();
    const attachmentsDir = resolve(baseDir, 'attachments');

    // 1. Scan physical attachment files
    const physicalFiles = await scanFilesRecursively(attachmentsDir, baseDir);

    // 2. Fetch all known storage keys in DB
    const dbAttachments = await prisma.attachment.findMany({
      select: { id: true, storageKey: true, status: true },
    });
    const dbKeyMap = new Map(dbAttachments.map(a => [a.storageKey.replace(/\\/g, '/'), a]));

    // 3. Detect physical files without DB records
    for (const file of physicalFiles) {
      if (!dbKeyMap.has(file)) {
        physicalWithoutRecord.push(file);
      }
    }

    // 4. Detect DB records without physical files
    for (const record of dbAttachments) {
      const exists = await provider.exists(record.storageKey);
      if (!exists && record.status === 'ACTIVE') {
        recordWithoutPhysical.push(record.id);
      }
      if (record.status === 'PENDING_DELETION' || record.status === 'QUARANTINED') {
        pendingRemoval.push(record.id);
      }
    }

    // 5. Scan expired temporary files
    try {
      const tempEntries = await readdir(tempDir, { withFileTypes: true });
      for (const entry of tempEntries) {
        if (entry.isFile()) {
          const filePath = join(tempDir, entry.name);
          const s = await stat(filePath);
          if (s.mtimeMs < tempCutoff) {
            expiredTemporaries.push(entry.name);
            if (!dryRun) {
              await unlink(filePath).catch(() => undefined);
              actionsTaken.push(`Unlinked expired temp: ${entry.name}`);
            }
          }
        }
      }
    } catch {
      // Temp directory does not exist or empty
    }
  }

  return {
    timestamp: new Date().toISOString(),
    dryRun,
    physicalWithoutRecord,
    recordWithoutPhysical,
    expiredTemporaries,
    pendingRemoval,
    actionsTaken,
  };
}
