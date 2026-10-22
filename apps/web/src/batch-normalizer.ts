export const BATCH_NOT_PROVIDED_NOTICE = 'O lote não foi informado no documento.';

export type BatchStatus = 'VALID' | 'EMPTY' | 'AMBIGUOUS' | 'MULTIPLE';

export interface BatchNormalizationResult {
  status: BatchStatus;
  batch: string;
  displayNotice?: string;
  sourceSnippet?: string;
  warning?: string;
  requiresReview: boolean;
  confidence: 'IDENTIFIED' | 'REVIEW_REQUIRED' | 'UNIDENTIFIED';
  confidenceLevel?: 'HIGH' | 'MEDIUM' | 'LOW';
  candidates?: string[];
}

/**
 * Normaliza e valida número de lote extraído de documentos conforme regras do SAC Análises:
 * - Quando identificado, o lote deve conter exatamente 6 dígitos numéricos, sem vírgulas, pontos ou espaços.
 * - Trata o lote como string, preservando zeros à esquerda.
 * - Não aplica formatação numérica ou de milhar.
 * - Remove separadores somente quando for inequívoco que pertencem ao mesmo lote. Não une lotes diferentes.
 * - Não completa com zeros, trunca ou inventa dígitos.
 * - Se houver um valor ambíguo ou diferente de 6 dígitos, solicita revisão e preserva o trecho de origem.
 * - Se o documento não informar lote, mantém o campo vazio, permite prosseguir e exibe "O lote não foi informado no documento."
 * - Não grava o aviso como valor do lote.
 */
export function normalizeBatchNumber(rawInput: unknown): BatchNormalizationResult {
  if (rawInput == null) {
    return {
      status: 'EMPTY',
      batch: '',
      displayNotice: BATCH_NOT_PROVIDED_NOTICE,
      requiresReview: false,
      confidence: 'UNIDENTIFIED',
    };
  }

  const raw = String(rawInput).trim();
  if (
    !raw ||
    raw === '-' ||
    raw === '?' ||
    raw.toLowerCase() === 'n/a' ||
    /^n[aã]o\s*informad[oa]/i.test(raw) ||
    /^sem\s*lote/i.test(raw) ||
    /^o\s+lote\s+n[aã]o\s+foi\s+informado/i.test(raw)
  ) {
    return {
      status: 'EMPTY',
      batch: '',
      displayNotice: BATCH_NOT_PROVIDED_NOTICE,
      requiresReview: false,
      confidence: 'UNIDENTIFIED',
    };
  }

  // 1. Strip common label prefixes and outer enclosing punctuation
  let stripped = raw
    .replace(/^(?:n[úu]mero\s+do\s+lote|n[úu]m\.?\s*do\s*lote|lote\s*n[º°o]?\.?|lote|batch)\s*[:#\-]?\s*/i, '')
    .trim();

  // Strip leading/trailing parens, brackets or quotes
  stripped = stripped.replace(/^[(\[{<"']/, '').replace(/[)\]}>"']$/, '').trim();

  // 2. Check for multiple distinct batches (e.g. '146157 / 146158', '146157, 146158', '146157 e 146158')
  const sixDigitMatches = raw.match(/\b[0-9]{6}\b/g) || [];
  const formattedMatches = raw.match(/\b[0-9]{3}[.,\s\-][0-9]{3}\b/g) || [];
  const allCandidates = Array.from(new Set([
    ...sixDigitMatches,
    ...formattedMatches.map(m => m.replace(/[.,\s\-]/g, ''))
  ]));

  if (allCandidates.length > 1) {
    return {
      status: 'MULTIPLE',
      batch: '',
      candidates: allCandidates,
      requiresReview: true,
      confidence: 'REVIEW_REQUIRED',
      confidenceLevel: 'MEDIUM',
      sourceSnippet: raw,
      warning: 'Múltiplos lotes identificados no trecho ("' + raw + '"). Não unificados automaticamente. Revise os lotes individualmente.',
    };
  }

  // Also check if raw contains multiple segments separated by delimiters like '/', ';', ',', ' e '
  const delimiterSplit = stripped.split(/\s*(?:\/|;| e | and |\sou\s)\s*/i).filter(Boolean);
  if (delimiterSplit.length > 1 && !/^[0-9]{3}[.,\s\-][0-9]{3}$/.test(stripped)) {
    return {
      status: 'MULTIPLE',
      batch: '',
      candidates: allCandidates.length ? allCandidates : delimiterSplit,
      requiresReview: true,
      confidence: 'REVIEW_REQUIRED',
      confidenceLevel: 'MEDIUM',
      sourceSnippet: raw,
      warning: 'Múltiplos lotes identificados no trecho ("' + raw + '"). Não unificados automaticamente. Revise os lotes individualmente.',
    };
  }

  // 3. Exact 6-digit match
  if (/^[0-9]{6}$/.test(stripped)) {
    return {
      status: 'VALID',
      batch: stripped,
      requiresReview: false,
      confidence: 'IDENTIFIED',
      confidenceLevel: 'HIGH',
    };
  }

  // 4. Unequivocal separator in a single 6-digit batch (e.g. '146.157', '146,157', '012.345', '146 157', '146-157')
  // Exactly 3 digits + 1 separator + 3 digits
  const singleSeparatorMatch = stripped.match(/^([0-9]{3})[.,\s\-]([0-9]{3})$/);
  if (singleSeparatorMatch) {
    const unformatted = `${singleSeparatorMatch[1]}${singleSeparatorMatch[2]}`;
    return {
      status: 'VALID',
      batch: unformatted,
      requiresReview: false,
      confidence: 'IDENTIFIED',
      confidenceLevel: 'HIGH',
    };
  }

  // 5. Ambiguous or different from 6 digits (do NOT pad with zeros, do NOT truncate!)
  return {
    status: 'AMBIGUOUS',
    batch: '',
    requiresReview: true,
    confidence: 'REVIEW_REQUIRED',
    confidenceLevel: 'MEDIUM',
    sourceSnippet: raw,
    warning: 'Lote com valor ambíguo ou diferente de 6 dígitos numéricos ("' + raw + '"). Revise o trecho de origem.',
  };
}
