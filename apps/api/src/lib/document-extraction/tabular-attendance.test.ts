import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  isTabularAttendanceDocument,
  parseTabularAttendanceDocument,
  extractAttendanceComponents,
} from './tabular-attendance.parser.js';
import { interpretDocumentText } from './form-interpreter.js';
import { matchAndScoreFields } from './field-matcher.js';
import { extractDocumentData } from './document-extraction.provider.js';
import { sanitizeDocumentImportPayload } from '../privacy/privacy.service.js';

// Synthetic fixture reproducing the tabular attendance document structure
const SYNTHETIC_TABULAR_ATTENDANCE_TEXT = `
Dados do Atendimento

Atendimento
005233

Cliente A2150001 - ROCHA SERVICOS ODONTOLOGICOS
Contato ROCHA SERVICOS ODONTOLOGICOS

Cidade
Endereço
Bairro

Telefone 11 25616755 /

Data 15/10/2026

Hora Inicial 17:45:19

Operador 000039 - Renato Monteiro

Comunicação
2- CONSULTOR

Status
Planejado

Mídia
1- Sem Formulario

Observação do
Atendimento

Prezados, boa tarde! Identificamos a falta de alguns itens em um dos dois kits cirúrgicos do im plante Veloce, liberados como
bonificação no pedido em questão. O cliente nos encaminhou a foto em anexo, na qual consta a ausência dos se guintes itens:
Fresa Cilíndrica Escalonada 3.7 mm — Cód. 31189 Chave Motor Colocação Implante 93.5 HE — Cód. 34659 Chave Motor
Colocação Implante 94.0 HE — Cód. 34660 Chave Catraca — Implante CM AR — Cód. 34622 Diante disso, peço, por gentileza,
que verifiquem a possibilidade de provi denciarmos o envio dos itens relacionados, a fim de completar o kit e gara ntir que o
cliente receba todos os itens previstos. PEDIDO 360460

Item | Assunto Produto Ocorrência Ação Responsável | Data Ação | Observação | Status — |Execução
001 000033 000189 000016 Renato 15/10/2026 Pendente |15/10/2026
Monteiro
`.trim();

describe('Tabular Attendance Parser (Dados do Atendimento)', () => {
  describe('Document Type Identification', () => {
    it('identifies synthetic tabular attendance text correctly', () => {
      expect(isTabularAttendanceDocument(SYNTHETIC_TABULAR_ATTENDANCE_TEXT)).toBe(true);
    });

    it('rejects unrelated documents (e.g. generic invoices or Outlook Forms)', () => {
      const unrelated = 'Relatório Geral Financeiro\nData: 10/10/2026\nValor: R$ 1.500,00';
      expect(isTabularAttendanceDocument(unrelated)).toBe(false);
    });
  });

  describe('Field Extraction and Evidence Association', () => {
    const parsed = parseTabularAttendanceDocument({
      text: SYNTHETIC_TABULAR_ATTENDANCE_TEXT,
      format: 'IMAGE',
      warnings: [],
    });

    it('extracts customer name and customer code reference correctly', () => {
      expect(parsed.customerName.value).toBe('ROCHA SERVICOS ODONTOLOGICOS');
      expect(parsed.customerName.confidence).toBe('IDENTIFIED');
      expect(parsed.customerName.confidenceLevel).toBe('HIGH');
      expect(parsed.customerName.requiresReview).toBe(false);

      const customerCodeRef = parsed.candidateReferences?.find(r => r.type === 'CUSTOMER_CODE');
      expect(customerCodeRef).toBeDefined();
      expect(customerCodeRef?.value).toBe('A2150001');
    });

    it('does NOT confuse customer name with narrative sentences mentioning "cliente"', () => {
      expect(parsed.customerName.value).not.toContain('nos encaminhou');
      expect(parsed.customerName.value).not.toContain('foto em anexo');
    });

    it('extracts external ticket preserving leading zeros as a string ("005233")', () => {
      expect(parsed.externalTicket.value).toBe('005233');
      expect(parsed.externalTicket.confidence).toBe('IDENTIFIED');
      expect(parsed.externalTicket.confidenceLevel).toBe('HIGH');

      const attendanceRef = parsed.candidateReferences?.find(r => r.type === 'ATTENDANCE');
      expect(attendanceRef).toBeDefined();
      expect(attendanceRef?.value).toBe('005233');
    });

    it('extracts order number and candidate reference from the observation', () => {
      expect(parsed.orderNumber.value).toBe('360460');
      expect(parsed.orderNumber.confidence).toBe('IDENTIFIED');

      const orderRef = parsed.candidateReferences?.find(r => r.type === 'ORDER');
      expect(orderRef).toBeDefined();
      expect(orderRef?.value).toBe('360460');
    });

    it('extracts document date/time as suggestion subject to review (15/10/2026 às 17:45:19)', () => {
      expect(parsed.openedAt.value).toBe('2026-10-15T17:45');
      expect(parsed.openedAt.confidence).toBe('REVIEW_REQUIRED');
      expect(parsed.openedAt.requiresReview).toBe(true);
      expect(parsed.openedAt.sourceSnippet).toContain('15/10/2026 às 17:45:19');
    });

    it('preserves full description from "Observação do Atendimento" without mid-sentence truncations', () => {
      expect(parsed.description.value).toMatch(/^Prezados, boa tarde!/);
      expect(parsed.description.value).toMatch(/PEDIDO 360460$/);
      expect(parsed.description.value).toContain('Identificamos a falta de alguns itens em um dos dois kits cirúrgicos do implante Veloce');
      expect(parsed.description.value).toContain('garantir que o cliente receba todos os itens previstos');
      expect(parsed.description.confidence).toBe('IDENTIFIED');
      expect(parsed.description.confidenceLevel).toBe('HIGH');
    });

    it('extracts exactly 4 components with codes and descriptions', () => {
      expect(parsed.items.length).toBe(4);

      const [item1, item2, item3, item4] = parsed.items;

      expect(item1.code).toBe('31189');
      expect(item1.description).toContain('Fresa Cilíndrica Escalonada 3.7 mm');

      expect(item2.code).toBe('34659');
      expect(item2.description).toContain('Chave Motor Colocação Implante Ø3.5 HE');

      expect(item3.code).toBe('34660');
      expect(item3.description).toContain('Chave Motor Colocação Implante Ø4.0 HE');

      expect(item4.code).toBe('34622');
      expect(item4.description).toContain('Chave Catraca – Implante CM AR');
    });

    it('does NOT invent quantities and does NOT interpret "um dos dois kits" as item quantity', () => {
      for (const item of parsed.items) {
        expect(item.quantity).toBe(0);
      }
    });

    it('sets absent lotes as EMPTY with required notice, permitting progression', () => {
      for (const item of parsed.items) {
        expect(item.batch).toBe('');
        expect(item.batchStatus).toBe('EMPTY');
        expect(item.batchNotice).toBe('O lote não foi informado no documento.');
      }
    });

    it('does NOT assign document operator to suggestedAssignee (isolation of operator)', () => {
      expect(parsed.suggestedAssignee).toBeUndefined();
    });

    it('leaves channel and reason for review without arbitrary status changes', () => {
      expect(parsed.channelName?.value).toBe('2 - CONSULTOR');
      expect(parsed.channelName?.requiresReview).toBe(true);
      expect(parsed.channelName?.confidence).toBe('REVIEW_REQUIRED');
    });
  });

  describe('Privacy & Sensitive Data Masking', () => {
    it('masks phone number when sanitized for non-admin viewers', () => {
      const parsed = parseTabularAttendanceDocument({
        text: SYNTHETIC_TABULAR_ATTENDANCE_TEXT,
        format: 'IMAGE',
        warnings: [],
      });

      const phoneInfo = parsed.additionalInfo?.find(i => i.label === 'Telefone');
      expect(phoneInfo).toBeDefined();
      expect(phoneInfo?.isSensitive).toBe(true);
      expect(phoneInfo?.category).toBe('CONTATO');

      const fullResult = {
        format: 'IMAGE' as const,
        modelId: parsed.modelId,
        modelName: parsed.modelName,
        externalTicket: parsed.externalTicket,
        customerName: parsed.customerName,
        openedAt: parsed.openedAt,
        orderNumber: parsed.orderNumber,
        description: parsed.description,
        candidateReferences: parsed.candidateReferences,
        items: parsed.items,
        additionalInfo: parsed.additionalInfo || [],
        summary: { totalIdentified: 3, totalReviewRequired: 2, totalUnidentified: 0 },
        warnings: [],
      };

      const sanitized = sanitizeDocumentImportPayload(fullResult);
      const sanitizedPhone = sanitized.additionalInfo?.find((i: { label: string }) => i.label === 'Telefone');
      expect(sanitizedPhone?.value).toBe('***');
      expect(sanitizedPhone?.isMasked).toBe(true);
    });
  });

  describe('End-to-End Extraction on the Real Uploaded Attendance Image', () => {
    it('processes the real uploaded image buffer correctly end-to-end', async () => {
      const imgPath = path.resolve(process.cwd(), 'uploads/temp/imports/ad21351b-d99e-48cf-a6d5-bf8c77e02396.png');
      if (!fs.existsSync(imgPath)) {
        // Skip if image is not present in local test environment
        return;
      }

      const buffer = fs.readFileSync(imgPath);
      const result = await extractDocumentData(buffer, 'atendimento.png');

      expect(result.modelId).toBe('TABULAR_ATTENDANCE');
      expect(result.modelName).toBe('Atendimento Tabular');

      // Customer
      expect(result.customerName.value).toBe('ROCHA SERVICOS ODONTOLOGICOS');
      expect(result.customerName.confidence).toBe('IDENTIFIED');
      expect(result.customerName.confidenceLevel).toBe('HIGH');

      // Ticket
      expect(result.externalTicket.value).toBe('005233');
      expect(result.externalTicket.confidence).toBe('IDENTIFIED');

      // Order
      expect(result.orderNumber.value).toBe('360460');

      // References
      expect(result.candidateReferences?.some(r => r.type === 'CUSTOMER_CODE' && r.value === 'A2150001')).toBe(true);
      expect(result.candidateReferences?.some(r => r.type === 'ATTENDANCE' && r.value === '005233')).toBe(true);
      expect(result.candidateReferences?.some(r => r.type === 'ORDER' && r.value === '360460')).toBe(true);

      // Date
      expect(result.openedAt.value).toBe('2026-10-15T17:45');
      expect(result.openedAt.requiresReview).toBe(true);

      // Description
      expect(result.description.value).toContain('Identificamos a falta de alguns itens em um dos dois kits cirúrgicos do implante Veloce');
      expect(result.description.value).toContain('PEDIDO 360460');

      // 4 Components
      expect(result.items.length).toBe(4);
      expect(result.items.map(it => it.code)).toEqual(['31189', '34659', '34660', '34622']);
      for (const it of result.items) {
        expect(it.quantity).toBe(0);
        expect(it.batch).toBe('');
        expect(it.batchStatus).toBe('EMPTY');
        expect(it.batchNotice).toBe('O lote não foi informado no documento.');
      }
    }, 45000);
  });
});
