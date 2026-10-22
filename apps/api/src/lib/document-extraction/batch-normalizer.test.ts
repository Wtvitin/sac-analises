import { describe, expect, it } from 'vitest';
import {
  BATCH_NOT_PROVIDED_NOTICE,
  normalizeBatchNumber,
} from './batch-normalizer.js';

describe('Normalização e Apresentação do Lote (Regras do SAC Análises)', () => {
  describe('1. Lote válido de 6 dígitos', () => {
    it('identifica e preserva lote com exatamente 6 dígitos numéricos', () => {
      const result = normalizeBatchNumber('146157');
      expect(result.status).toBe('VALID');
      expect(result.batch).toBe('146157');
      expect(result.requiresReview).toBe(false);
      expect(result.confidence).toBe('IDENTIFIED');
      expect(result.confidenceLevel).toBe('HIGH');
      expect(result.warning).toBeUndefined();
    });

    it('remove prefixos como "Lote:", "Lote nº", "Número do lote" sem alterar os 6 dígitos', () => {
      expect(normalizeBatchNumber('Lote: 146157').batch).toBe('146157');
      expect(normalizeBatchNumber('Lote nº 146157').batch).toBe('146157');
      expect(normalizeBatchNumber('Número do lote: 146157').batch).toBe('146157');
      expect(normalizeBatchNumber('(146157)').batch).toBe('146157');
    });

    it('não aplica formatação numérica ou de milhar no lote identificado', () => {
      const result = normalizeBatchNumber('146157');
      expect(result.batch).not.toContain('.');
      expect(result.batch).not.toContain(',');
      expect(result.batch).not.toContain(' ');
      expect(result.batch).toBe('146157');
    });
  });

  describe('2. Lote começando com zero', () => {
    it('preserva zeros à esquerda como string', () => {
      const result = normalizeBatchNumber('012345');
      expect(result.status).toBe('VALID');
      expect(result.batch).toBe('012345');
      expect(typeof result.batch).toBe('string');
      expect(result.batch.startsWith('0')).toBe(true);
      expect(result.batch.length).toBe(6);
    });

    it('preserva múltiplos zeros à esquerda (ex: 000123)', () => {
      const result = normalizeBatchNumber('000123');
      expect(result.status).toBe('VALID');
      expect(result.batch).toBe('000123');
      expect(result.batch.length).toBe(6);
    });
  });

  describe('3. Separador de milhar introduzido na extração', () => {
    it('remove ponto de milhar quando for inequívoco que pertence ao mesmo lote', () => {
      const result = normalizeBatchNumber('146.157');
      expect(result.status).toBe('VALID');
      expect(result.batch).toBe('146157');
      expect(result.requiresReview).toBe(false);
    });

    it('remove vírgula de milhar quando for inequívoco que pertence ao mesmo lote', () => {
      const result = normalizeBatchNumber('146,157');
      expect(result.status).toBe('VALID');
      expect(result.batch).toBe('146157');
      expect(result.requiresReview).toBe(false);
    });

    it('remove separador de milhar preservando zero à esquerda (ex: 012.345 ou 012,345)', () => {
      const dotResult = normalizeBatchNumber('012.345');
      expect(dotResult.status).toBe('VALID');
      expect(dotResult.batch).toBe('012345');

      const commaResult = normalizeBatchNumber('012,345');
      expect(commaResult.status).toBe('VALID');
      expect(commaResult.batch).toBe('012345');
    });

    it('remove espaço ou hífen entre grupos de 3 dígitos (ex: "146 157", "146-157")', () => {
      expect(normalizeBatchNumber('146 157').batch).toBe('146157');
      expect(normalizeBatchNumber('146-157').batch).toBe('146157');
    });
  });

  describe('4. Ausência de lote, permitindo prosseguir e salvar', () => {
    it('mantém campo vazio e exibe aviso padronizado quando o documento não informa lote', () => {
      const emptyResults = [
        normalizeBatchNumber(''),
        normalizeBatchNumber('   '),
        normalizeBatchNumber(null),
        normalizeBatchNumber(undefined),
        normalizeBatchNumber('-'),
        normalizeBatchNumber('?'),
        normalizeBatchNumber('N/A'),
        normalizeBatchNumber('não informado'),
        normalizeBatchNumber('Sem lote'),
      ];

      for (const res of emptyResults) {
        expect(res.status).toBe('EMPTY');
        expect(res.batch).toBe('');
        expect(res.displayNotice).toBe(BATCH_NOT_PROVIDED_NOTICE);
        expect(res.requiresReview).toBe(false);
      }
    });

    it('nunca grava o aviso como valor do lote', () => {
      const result = normalizeBatchNumber(BATCH_NOT_PROVIDED_NOTICE);
      expect(result.batch).toBe('');
      expect(result.batch).not.toBe(BATCH_NOT_PROVIDED_NOTICE);
      expect(result.displayNotice).toBe(BATCH_NOT_PROVIDED_NOTICE);
    });
  });

  describe('5. Valor inválido ou ambíguo', () => {
    it('solicita revisão e preserva o trecho de origem para 5 dígitos com vírgula ("22,278")', () => {
      const result = normalizeBatchNumber('22,278');
      expect(result.status).toBe('AMBIGUOUS');
      expect(result.batch).toBe('');
      expect(result.requiresReview).toBe(true);
      expect(result.confidence).toBe('REVIEW_REQUIRED');
      expect(result.sourceSnippet).toBe('22,278');
      expect(result.warning).toContain('22,278');
    });

    it('não completa com zeros para valores com menos de 6 dígitos ("12345")', () => {
      const result = normalizeBatchNumber('12345');
      expect(result.status).toBe('AMBIGUOUS');
      expect(result.batch).toBe('');
      expect(result.batch).not.toBe('012345');
      expect(result.requiresReview).toBe(true);
      expect(result.sourceSnippet).toBe('12345');
    });

    it('não trunca valores com mais de 6 dígitos ("1234567")', () => {
      const result = normalizeBatchNumber('1234567');
      expect(result.status).toBe('AMBIGUOUS');
      expect(result.batch).toBe('');
      expect(result.batch).not.toBe('123456');
      expect(result.requiresReview).toBe(true);
      expect(result.sourceSnippet).toBe('1234567');
    });

    it('solicita revisão para valores com letras ("LOTE-99812", "ABC123")', () => {
      const result = normalizeBatchNumber('LOTE-99812');
      expect(result.status).toBe('AMBIGUOUS');
      expect(result.batch).toBe('');
      expect(result.requiresReview).toBe(true);
      expect(result.sourceSnippet).toBe('LOTE-99812');
    });
  });

  describe('6. Múltiplos lotes, sem concatená-los', () => {
    it('detecta múltiplos lotes separados por barra ("146157 / 146158") sem concatenar', () => {
      const result = normalizeBatchNumber('146157 / 146158');
      expect(result.status).toBe('MULTIPLE');
      expect(result.batch).toBe('');
      expect(result.batch).not.toBe('146157146158');
      expect(result.candidates).toEqual(['146157', '146158']);
      expect(result.requiresReview).toBe(true);
      expect(result.confidence).toBe('REVIEW_REQUIRED');
      expect(result.sourceSnippet).toBe('146157 / 146158');
      expect(result.warning).toContain('Múltiplos lotes');
    });

    it('detecta múltiplos lotes separados por vírgula ("146157, 146158") sem concatenar', () => {
      const result = normalizeBatchNumber('146157, 146158');
      expect(result.status).toBe('MULTIPLE');
      expect(result.batch).toBe('');
      expect(result.batch).not.toBe('146157146158');
      expect(result.candidates).toEqual(['146157', '146158']);
      expect(result.requiresReview).toBe(true);
    });

    it('detecta múltiplos lotes separados por conjunção ("Lotes 146157 e 146158")', () => {
      const result = normalizeBatchNumber('Lotes 146157 e 146158');
      expect(result.status).toBe('MULTIPLE');
      expect(result.candidates).toEqual(['146157', '146158']);
      expect(result.requiresReview).toBe(true);
    });
  });
});
