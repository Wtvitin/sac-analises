import { createRequire } from 'node:module';
import type { RawDocumentText } from './document-extraction.types.js';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');

function formatCellValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') {
    // If it's a formula cell with a calculated result, use result
    if ('result' in (val as Record<string, unknown>)) {
      const res = (val as { result: unknown }).result;
      return res !== null && res !== undefined ? String(res).trim() : '';
    }
    // If it's rich text
    if ('richText' in (val as Record<string, unknown>)) {
      const rt = (val as { richText: Array<{ text: string }> }).richText;
      return Array.isArray(rt) ? rt.map(p => p.text).join('').trim() : '';
    }
    if ('text' in (val as Record<string, unknown>)) {
      return String((val as { text: unknown }).text).trim();
    }
    if (val instanceof Date) {
      return val.toISOString();
    }
  }
  return String(val).trim();
}

import { validateOoxmlZip } from './ooxml-validator.js';

export async function parseXlsxDocument(buffer: Buffer): Promise<RawDocumentText> {
  const validation = validateOoxmlZip(buffer);
  if (!validation.valid) {
    throw new Error(validation.error || 'Planilha XLSX inválida ou com formato corrompido.');
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const textLines: string[] = [];
  const tableData: Array<Record<string, string>> = [];

  // Iterate over all worksheets
  workbook.eachSheet((worksheet: any) => {
    let headers: string[] = [];

    worksheet.eachRow({ includeEmpty: false }, (row: any) => {
      const rawValues = Array.isArray(row.values) ? row.values.slice(1) : [];
      const rowStrings: string[] = rawValues.map(formatCellValue).filter((v: string | null | undefined): v is string => Boolean(v));

      if (rowStrings.length === 0) return;

      // Add to overall text
      textLines.push(rowStrings.join(' : '));

      // Check if this row looks like a table header (e.g. Código, Descrição/Produto, Qtd, etc.)
      const lowerValues = rowStrings.map((s: string) => s.toLowerCase());
      const hasCode = lowerValues.some((v: string) => v.includes('código') || v.includes('codigo') || v.includes('sku') || v.includes('item'));
      const hasDesc = lowerValues.some((v: string) => v.includes('descri') || v.includes('produto'));
      const hasQty = lowerValues.some((v: string) => v.includes('qtd') || v.includes('quantidade'));

      if (hasCode || (hasDesc && hasQty)) {
        headers = rowStrings;
      } else if (headers.length > 0 && rowStrings.length >= 2) {
        // Build table row dictionary
        const rowDict: Record<string, string> = {};
        headers.forEach((h, i) => {
          if (rowStrings[i]) rowDict[h] = rowStrings[i];
        });
        tableData.push(rowDict);
      }
    });
  });

  return {
    text: textLines.join('\n'),
    format: 'XLSX',
    numPages: workbook.worksheets.length,
    isScanned: false,
    tableData: tableData.length > 0 ? tableData : undefined,
    warnings: [],
  };
}
