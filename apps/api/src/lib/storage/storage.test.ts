import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AttachmentStorageError,
  sanitizeOriginalName,
  validateFileContent,
} from './file-validation.js';
import { LocalStorageProvider } from './local-storage.provider.js';

const VALID_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
const VALID_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);
const VALID_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const MALICIOUS_EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // MZ
const MALICIOUS_ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]); // ELF
const MALICIOUS_SHEBANG = Buffer.from('#!/bin/bash\nrm -rf /\n');
const MALICIOUS_ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00]); // PK
const MALICIOUS_HTML = Buffer.from('<html><head></head><body><script>alert("xss")</script></body></html>');
const MALICIOUS_SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('Storage and file validation subsystem', () => {
  let tempBaseDir: string;
  let provider: LocalStorageProvider;

  beforeEach(async () => {
    tempBaseDir = await mkdtemp(join(tmpdir(), 'sac-storage-test-'));
    provider = new LocalStorageProvider(tempBaseDir);
  });

  afterEach(async () => {
    await rm(tempBaseDir, { recursive: true, force: true });
  });

  describe('file-validation (magic bytes and signatures)', () => {
    it('validates legitimate PDF, JPEG and PNG files', () => {
      const pdf = validateFileContent(VALID_PDF, 'application/pdf', 'relatorio.pdf');
      expect(pdf).toEqual({ mimeType: 'application/pdf', canonicalExtension: '.pdf' });

      const jpeg = validateFileContent(VALID_JPEG, 'image/jpeg', 'foto.jpg');
      expect(jpeg).toEqual({ mimeType: 'image/jpeg', canonicalExtension: '.jpg' });

      const png = validateFileContent(VALID_PNG, 'image/png', 'captura.png');
      expect(png).toEqual({ mimeType: 'image/png', canonicalExtension: '.png' });
    });

    it('rejects empty files (0 bytes)', () => {
      expect(() => validateFileContent(Buffer.alloc(0), 'application/pdf', 'vazio.pdf')).toThrowError(
        /Arquivo vazio/
      );
    });

    it('rejects files larger than 10 MB', () => {
      const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
      expect(() => validateFileContent(oversized, 'application/pdf', 'grande.pdf')).toThrowError(
        /10 MB/
      );
    });

    it('rejects disguised executables, archives and scripts regardless of reported extension or MIME', () => {
      // Disguised .exe
      expect(() => validateFileContent(MALICIOUS_EXE, 'application/pdf', 'relatorio.pdf')).toThrowError(
        /executáveis são proibidos/
      );

      // Disguised ELF
      expect(() => validateFileContent(MALICIOUS_ELF, 'image/png', 'foto.png')).toThrowError(
        /executáveis são proibidos/
      );

      // Script shebang
      expect(() => validateFileContent(MALICIOUS_SHEBANG, 'image/jpeg', 'foto.jpg')).toThrowError(
        /Scripts executáveis/
      );

      // Disguised ZIP
      expect(() => validateFileContent(MALICIOUS_ZIP, 'application/pdf', 'documento.pdf')).toThrowError(
        /Arquivos compactados/
      );

      // HTML / SVG polyglots
      expect(() => validateFileContent(MALICIOUS_HTML, 'application/pdf', 'documento.pdf')).toThrowError(
        /Conteúdo HTML, SVG, scripts/
      );
      expect(() => validateFileContent(MALICIOUS_SVG, 'image/png', 'imagem.png')).toThrowError(
        /Conteúdo HTML, SVG, scripts/
      );
    });

    it('rejects mismatched extensions and MIME types', () => {
      // Valid PDF buffer with .png extension
      expect(() => validateFileContent(VALID_PDF, 'application/pdf', 'arquivo.png')).toThrowError(
        /incompatível com o conteúdo real/
      );

      // Valid JPEG buffer with PDF MIME
      expect(() => validateFileContent(VALID_JPEG, 'application/pdf', 'foto.jpg')).toThrowError(
        /diverge do tipo real/
      );
    });

    it('sanitizes original filenames against control characters, paths, and excess length', () => {
      expect(sanitizeOriginalName('../../etc/passwd.pdf', '.pdf')).toBe('passwd.pdf');
      expect(sanitizeOriginalName('..\\..\\windows\\system32\\cmd.exe.pdf', '.pdf')).toBe('cmd.exe.pdf');
      expect(sanitizeOriginalName('arquivo\u0000com\u001fcontrole.pdf', '.pdf')).toBe('arquivocomcontrole.pdf');
      expect(sanitizeOriginalName('  meu relatorio final .pdf  ', '.pdf')).toBe('meu relatorio final.pdf');
      expect(sanitizeOriginalName('', '.pdf')).toBe('evidencia.pdf');
      expect(sanitizeOriginalName('a'.repeat(200) + '.pdf', '.pdf').length).toBeLessThan(100);
    });
  });

  describe('LocalStorageProvider (storage operations and security)', () => {
    it('saves a valid file via streaming, produces unpredictable key, calculates SHA-256 and cleans up temp', async () => {
      const result = await provider.save({
        originalname: 'contrato.pdf',
        mimetype: 'application/pdf',
        size: VALID_PDF.length,
        buffer: VALID_PDF,
      });

      expect(result.storageProvider).toBe('local');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.originalName).toBe('contrato.pdf');
      expect(result.sizeBytes).toBe(VALID_PDF.length);
      expect(result.sha256).toHaveLength(64); // SHA-256 hex string

      // Key must be unpredictable and structured
      expect(result.storageKey).toMatch(/^attachments\/\d{4}\/\d{2}\/[a-f0-9-]+\.pdf$/);

      // File must physically exist in storage
      expect(await provider.exists(result.storageKey)).toBe(true);

      // Read back via stream and check content
      const stream = await provider.openReadStream(result.storageKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const readBuffer = Buffer.concat(chunks);
      expect(readBuffer).toEqual(VALID_PDF);
    });

    it('blocks path traversal attempts in storageKey', async () => {
      await expect(provider.openReadStream('../../../sensitive.txt')).rejects.toThrowError(
        /path traversal/i
      );
      await expect(provider.remove('..\\..\\system.ini')).rejects.toThrowError(
        /path traversal/i
      );
      await expect(provider.getMetadata('/etc/shadow')).rejects.toThrowError(
        /path traversal/i
      );
    });

    it('removes files safely and idempotently', async () => {
      const result = await provider.save({
        originalname: 'foto.jpg',
        mimetype: 'image/jpeg',
        size: VALID_JPEG.length,
        buffer: VALID_JPEG,
      });

      expect(await provider.exists(result.storageKey)).toBe(true);
      await provider.remove(result.storageKey);
      expect(await provider.exists(result.storageKey)).toBe(false);

      // Removing again should not throw (idempotent)
      await expect(provider.remove(result.storageKey)).resolves.not.toThrow();
    });

    it('cleans up temporary files when validation fails', async () => {
      await expect(
        provider.save({
          originalname: 'falso.pdf',
          mimetype: 'application/pdf',
          size: MALICIOUS_EXE.length,
          buffer: MALICIOUS_EXE,
        })
      ).rejects.toThrow(AttachmentStorageError);

      // Temp directory should be empty
      const tempFiles = await readFile(provider.getTempDirectory()).catch(() => []);
      expect(tempFiles.length).toBe(0);
    });
  });
});
