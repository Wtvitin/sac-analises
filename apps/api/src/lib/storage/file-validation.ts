import { extname } from 'node:path';

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB
export const MAX_ATTACHMENT_COUNT = 5;

export const ALLOWED_MIME_EXTENSIONS: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
};

export const ALLOWED_EXTENSIONS_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export class AttachmentStorageError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) {
    super(message);
  }
}

export type ValidatedFileType = {
  mimeType: string;
  canonicalExtension: '.pdf' | '.jpg' | '.png';
};

/**
 * Normalizes an original filename to prevent path traversal, control character injection,
 * or excessively long filenames while preserving a safe display name and valid extension.
 */
export function sanitizeOriginalName(rawName: string, expectedExt?: string): string {
  if (!rawName || typeof rawName !== 'string') return 'evidencia' + (expectedExt || '.pdf');

  // Strip path segments
  const cleanPath = rawName.replace(/^.*[\\/]/, '');
  // Remove control characters (0x00-0x1f, 0x7f-0x9f)
  const stripped = cleanPath.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();

  const dotIndex = stripped.lastIndexOf('.');
  let base = dotIndex > 0 ? stripped.slice(0, dotIndex) : stripped;
  let ext = dotIndex > 0 ? stripped.slice(dotIndex).toLowerCase() : '';

  if (expectedExt && !ALLOWED_EXTENSIONS_MAP[ext]) {
    ext = expectedExt;
  }

  // Remove dangerous characters from base
  base = base.replace(/[/\\:*?"<>|]/g, '_').trim();
  // Remove leading dots to avoid hidden files
  base = base.replace(/^\.+/, '');
  // Truncate base name to reasonable display size (max 80 chars)
  base = base.slice(0, 80) || 'evidencia';

  return `${base}${ext}`;
}

/**
 * Validates a buffer's binary signature (magic bytes), MIME type and file extension.
 * Rejects executables, scripts, compressed archives, HTML, SVG and polyglot payloads.
 */
export function validateFileContent(
  buffer: Buffer,
  declaredMime: string,
  declaredName: string
): ValidatedFileType {
  if (!buffer || buffer.length === 0) {
    throw new AttachmentStorageError('INVALID_ATTACHMENT_SIZE', 'Arquivo vazio não é permitido.');
  }

  if (buffer.length > MAX_ATTACHMENT_SIZE) {
    throw new AttachmentStorageError('INVALID_ATTACHMENT_SIZE', 'Cada arquivo deve possuir até 10 MB.');
  }

  const rawExt = extname(declaredName).toLowerCase();
  const normalizedMime = declaredMime.toLowerCase().trim();

  // Rejection of obvious malicious signatures
  detectMaliciousSignatures(buffer);

  // Magic bytes checking
  const detected = detectFileTypeByMagicBytes(buffer);
  if (!detected) {
    throw new AttachmentStorageError(
      'INVALID_ATTACHMENT_TYPE',
      'Assinatura de arquivo inválida. Envie somente arquivos PDF, JPG, JPEG ou PNG legítimos.'
    );
  }

  // Verify consistency between detected type, declared MIME, and declared extension
  const allowedExtsForDetected = ALLOWED_MIME_EXTENSIONS[detected.mimeType] ?? [];
  if (!allowedExtsForDetected.includes(rawExt)) {
    throw new AttachmentStorageError(
      'ATTACHMENT_EXTENSION_MISMATCH',
      `Extensão "${rawExt}" incompatível com o conteúdo real do arquivo (${detected.mimeType}).`
    );
  }

  if (normalizedMime !== detected.mimeType) {
    // Note: image/jpg vs image/jpeg tolerance
    const isJpegVariant =
      detected.mimeType === 'image/jpeg' && (normalizedMime === 'image/jpeg' || normalizedMime === 'image/jpg');
    if (!isJpegVariant) {
      throw new AttachmentStorageError(
        'ATTACHMENT_MIME_MISMATCH',
        `Tipo MIME informado (${declaredMime}) diverge do tipo real do arquivo (${detected.mimeType}).`
      );
    }
  }

  return detected;
}

/**
 * Checks the initial buffer bytes for known allowed file signatures.
 */
function detectFileTypeByMagicBytes(buffer: Buffer): ValidatedFileType | null {
  // PDF: starts with '%PDF-' (0x25 0x50 0x44 0x46 0x2D)
  if (
    buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    return { mimeType: 'application/pdf', canonicalExtension: '.pdf' };
  }

  // JPEG: starts with 0xFF 0xD8 0xFF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', canonicalExtension: '.jpg' };
  }

  // PNG: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A ('\x89PNG\r\n\x1a\n')
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: 'image/png', canonicalExtension: '.png' };
  }

  return null;
}

/**
 * Rejects executables, scripts, HTML, SVG and known dangerous headers or polyglots.
 */
function detectMaliciousSignatures(buffer: Buffer): void {
  // Check Windows PE / DOS executable ('MZ')
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    throw new AttachmentStorageError('MALICIOUS_ATTACHMENT_REJECTED', 'Arquivos executáveis são proibidos.');
  }

  // Check Linux ELF executable (0x7F 'ELF')
  if (buffer.length >= 4 && buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
    throw new AttachmentStorageError('MALICIOUS_ATTACHMENT_REJECTED', 'Arquivos executáveis são proibidos.');
  }

  // Check Script Shebang ('#!')
  if (buffer.length >= 2 && buffer[0] === 0x23 && buffer[1] === 0x21) {
    throw new AttachmentStorageError('MALICIOUS_ATTACHMENT_REJECTED', 'Scripts executáveis são proibidos.');
  }

  // Check ZIP / JAR archive ('PK' - 0x50 0x4B)
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    throw new AttachmentStorageError('MALICIOUS_ATTACHMENT_REJECTED', 'Arquivos compactados não são permitidos.');
  }

  // Check GZIP (0x1F 0x8B)
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    throw new AttachmentStorageError('MALICIOUS_ATTACHMENT_REJECTED', 'Arquivos compactados não são permitidos.');
  }

  // Check 7Z (0x37 0x7A 0xBC 0xAF)
  if (buffer.length >= 4 && buffer[0] === 0x37 && buffer[1] === 0x7a && buffer[2] === 0xbc && buffer[3] === 0xaf) {
    throw new AttachmentStorageError('MALICIOUS_ATTACHMENT_REJECTED', 'Arquivos compactados não são permitidos.');
  }

  // Check RAR ('Rar!' - 0x52 0x61 0x72 0x21)
  if (buffer.length >= 4 && buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72 && buffer[3] === 0x21) {
    throw new AttachmentStorageError('MALICIOUS_ATTACHMENT_REJECTED', 'Arquivos compactados não são permitidos.');
  }

  // Textual inspection of header for HTML / SVG / PHP polyglots
  const inspectChunk = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8').toLowerCase();

  if (
    inspectChunk.includes('<html') ||
    inspectChunk.includes('<!doctype html') ||
    inspectChunk.includes('<script') ||
    inspectChunk.includes('<svg') ||
    inspectChunk.includes('<?xml') ||
    inspectChunk.includes('<?php')
  ) {
    throw new AttachmentStorageError(
      'MALICIOUS_ATTACHMENT_REJECTED',
      'Conteúdo HTML, SVG, scripts ou políglotas não são permitidos.'
    );
  }
}
