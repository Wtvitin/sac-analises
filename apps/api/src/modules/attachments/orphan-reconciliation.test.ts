import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStorageProvider } from '../../lib/storage/local-storage.provider.js';

const mockPrisma = vi.hoisted(() => ({
  attachment: {
    findMany: vi.fn(),
  },
}));

let testProvider: LocalStorageProvider;

vi.mock('../../lib/prisma.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../lib/storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/storage/index.js')>();
  return {
    ...actual,
    getStorageProvider: () => testProvider,
  };
});

import { reconcileStorage } from './orphan-reconciliation.js';

describe('storage reconciliation and orphan detection', () => {
  let tempBaseDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempBaseDir = await mkdtemp(join(tmpdir(), 'sac-reconcile-test-'));
    testProvider = new LocalStorageProvider(tempBaseDir);
  });

  afterEach(async () => {
    await rm(tempBaseDir, { recursive: true, force: true });
  });

  it('runs in dry-run mode by default and detects orphan files and missing records without deleting', async () => {
    // 1. Create a physical attachment file
    const saved = await testProvider.save({
      originalname: 'evidencia.pdf',
      mimetype: 'application/pdf',
      size: 50,
      buffer: Buffer.from('%PDF-1.4\nTest PDF content\n%%EOF'),
    });

    // 2. DB returns NO matching record (so saved file is a physical orphan)
    // and returns a record for a file that does NOT exist physically (missing physical file)
    mockPrisma.attachment.findMany.mockResolvedValueOnce([
      { id: 'att-missing-file', storageKey: 'attachments/2026/01/ghost.pdf', status: 'ACTIVE' },
    ]);

    const report = await reconcileStorage(); // dryRun is true by default

    expect(report.dryRun).toBe(true);
    expect(report.physicalWithoutRecord).toContain(saved.storageKey);
    expect(report.recordWithoutPhysical).toContain('att-missing-file');
    expect(report.actionsTaken).toHaveLength(0); // No deletions in dry-run
  });

  it('cleans up expired temporaries only when dryRun is false', async () => {
    const tempDir = testProvider.getTempDirectory();
    await testProvider.save({
      originalname: 'arquivo.pdf',
      mimetype: 'application/pdf',
      size: 50,
      buffer: Buffer.from('%PDF-1.4\nTest PDF content\n%%EOF'),
    });

    // Create an old temp file
    const oldTempFile = join(tempDir, 'old-upload.tmp');
    await writeFile(oldTempFile, 'abandoned temp data');

    mockPrisma.attachment.findMany.mockResolvedValue([]);

    // Running with tempExpiryMinutes: 0 means any file is immediately considered expired
    const reportDry = await reconcileStorage({ dryRun: true, tempExpiryMinutes: 0 });
    expect(reportDry.expiredTemporaries).toContain('old-upload.tmp');
    expect(reportDry.actionsTaken).toHaveLength(0);

    // Now run with dryRun: false
    const reportApply = await reconcileStorage({ dryRun: false, tempExpiryMinutes: 0 });
    expect(reportApply.expiredTemporaries).toContain('old-upload.tmp');
    expect(reportApply.actionsTaken.some((a) => a.includes('old-upload.tmp'))).toBe(true);
  });
});
