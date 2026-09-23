export const MAX_ZIP_ENTRIES = 500;
export const MAX_UNCOMPRESSED_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
export const MAX_COMPRESSION_RATIO = 100; // max 100:1 ratio

export interface OoxmlValidationResult {
  valid: boolean;
  error?: string;
  entryCount: number;
  totalUncompressedSize: number;
}

/**
 * Validates that a buffer is a legitimate, safe OOXML Excel spreadsheet (.xlsx),
 * strictly checking the ZIP directory, required entries ([Content_Types].xml and xl/workbook.xml),
 * prohibiting macros (VBA) / executable payloads, and enforcing ZIP bomb safeguards.
 */
export function validateOoxmlZip(buffer: Buffer): OoxmlValidationResult {
  if (!buffer || buffer.length < 22) {
    return {
      valid: false,
      error: 'Arquivo muito pequeno ou vazio para ser um documento XLSX válido.',
      entryCount: 0,
      totalUncompressedSize: 0,
    };
  }

  // Check magic bytes PK\x03\x04
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
    return {
      valid: false,
      error: 'Assinatura binária incompatível com formato XLSX (esperado PK\\x03\\x04).',
      entryCount: 0,
      totalUncompressedSize: 0,
    };
  }

  // Find End of Central Directory (EOCD) signature PK\x05\x06 searching backwards from the end
  let eocdOffset = -1;
  const maxSearch = Math.min(buffer.length, 65535 + 22);
  for (let i = buffer.length - 22; i >= buffer.length - maxSearch; i--) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x05 && buffer[i + 3] === 0x06) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    return {
      valid: false,
      error: 'Estrutura ZIP corrompida ou inválida: tabela central de diretório não encontrada.',
      entryCount: 0,
      totalUncompressedSize: 0,
    };
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (totalEntries > MAX_ZIP_ENTRIES) {
    return {
      valid: false,
      error: `Quantidade de entradas no arquivo (${totalEntries}) excede o limite de segurança de ${MAX_ZIP_ENTRIES}.`,
      entryCount: totalEntries,
      totalUncompressedSize: 0,
    };
  }

  if (cdOffset + cdSize > buffer.length) {
    return {
      valid: false,
      error: 'Estrutura ZIP inválida: limites do diretório central ultrapassam o tamanho do arquivo.',
      entryCount: totalEntries,
      totalUncompressedSize: 0,
    };
  }

  let offset = cdOffset;
  let accumulatedUncompressedSize = 0;
  const entries = new Set<string>();

  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > buffer.length) {
      return {
        valid: false,
        error: 'Diretório central do ZIP truncado.',
        entryCount: i,
        totalUncompressedSize: accumulatedUncompressedSize,
      };
    }

    // Central directory header signature PK\x01\x02
    if (buffer[offset] !== 0x50 || buffer[offset + 1] !== 0x4b || buffer[offset + 2] !== 0x01 || buffer[offset + 3] !== 0x02) {
      return {
        valid: false,
        error: 'Assinatura inválida no diretório central do ZIP.',
        entryCount: i,
        totalUncompressedSize: accumulatedUncompressedSize,
      };
    }

    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const fileCommentLength = buffer.readUInt16LE(offset + 32);

    // Check compression ratio (ZIP bomb defense)
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
      return {
        valid: false,
        error: `Taxa de compressão excessiva detectada na entrada (${Math.round(uncompressedSize / compressedSize)}:1). Proteção contra ZIP bomb acionada.`,
        entryCount: i,
        totalUncompressedSize: accumulatedUncompressedSize,
      };
    }

    accumulatedUncompressedSize += uncompressedSize;
    if (accumulatedUncompressedSize > MAX_UNCOMPRESSED_SIZE_BYTES) {
      return {
        valid: false,
        error: `Tamanho descompactado total excede o limite de ${MAX_UNCOMPRESSED_SIZE_BYTES / (1024 * 1024)} MB. Proteção contra ZIP bomb acionada.`,
        entryCount: i,
        totalUncompressedSize: accumulatedUncompressedSize,
      };
    }

    const fileNameStart = offset + 46;
    if (fileNameStart + fileNameLength > buffer.length) {
      return {
        valid: false,
        error: 'Nome de entrada de arquivo truncado.',
        entryCount: i,
        totalUncompressedSize: accumulatedUncompressedSize,
      };
    }

    const fileName = buffer.toString('utf8', fileNameStart, fileNameStart + fileNameLength);
    entries.add(fileName.replace(/\\/g, '/').toLowerCase());

    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }

  // Check required OOXML structure
  const hasContentTypes = entries.has('[content_types].xml');
  const hasWorkbook = entries.has('xl/workbook.xml');

  if (!hasContentTypes || !hasWorkbook) {
    return {
      valid: false,
      error: 'O arquivo não é uma planilha Excel legítima (estrutura OOXML ausente: [Content_Types].xml ou xl/workbook.xml não encontrados).',
      entryCount: totalEntries,
      totalUncompressedSize: accumulatedUncompressedSize,
    };
  }

  // Prohibit macros and dangerous executables
  if (
    entries.has('xl/vbaproject.bin') ||
    Array.from(entries).some(e => e.endsWith('.exe') || e.endsWith('.bat') || e.endsWith('.cmd') || e.endsWith('.vbs'))
  ) {
    return {
      valid: false,
      error: 'Planilhas contendo macros (VBA) ou arquivos executáveis embutidos não são permitidas por segurança.',
      entryCount: totalEntries,
      totalUncompressedSize: accumulatedUncompressedSize,
    };
  }

  return {
    valid: true,
    entryCount: totalEntries,
    totalUncompressedSize: accumulatedUncompressedSize,
  };
}
