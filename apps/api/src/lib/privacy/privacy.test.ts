import { describe, it, expect, vi } from 'vitest';
import {
  maskCpfCnpj,
  maskPhone,
  maskEmail,
  maskGenericSensitive,
  detectSensitiveCategory,
  sanitizeDocumentImportPayload,
  logSensitiveDataRevealAudit,
} from './privacy.service.js';

describe('Privacy and Masking Service (Synthetic Data)', () => {
  describe('CPF / CNPJ Masking', () => {
    it('masks standard 11-digit CPF preserving only last group safely', () => {
      expect(maskCpfCnpj('123.456.789-00')).toBe('***.***.789-**');
      expect(maskCpfCnpj('12345678900')).toBe('***.***.789-**');
      expect(maskCpfCnpj('98765432199')).toBe('***.***.321-**');
    });

    it('masks standard 14-digit CNPJ preserving branch identifier', () => {
      expect(maskCpfCnpj('12.345.678/0001-90')).toBe('**.***.***/0001-**');
      expect(maskCpfCnpj('12345678000190')).toBe('**.***.***/0001-**');
    });

    it('handles empty or short input gracefully', () => {
      expect(maskCpfCnpj('')).toBe('');
      expect(maskCpfCnpj(null)).toBe('');
      expect(maskCpfCnpj(undefined)).toBe('');
      expect(maskCpfCnpj('12345')).toBe('***');
    });
  });

  describe('Phone Masking', () => {
    it('masks standard Brazilian mobile and landline phones', () => {
      expect(maskPhone('(11) 98765-4321')).toBe('(11) *****-4321');
      expect(maskPhone('11987654321')).toBe('(11) *****-4321');
      expect(maskPhone('(21) 3456-7890')).toBe('(21) *****-7890');
    });

    it('handles null and empty phone', () => {
      expect(maskPhone('')).toBe('');
      expect(maskPhone(null)).toBe('');
      expect(maskPhone('1234')).toBe('****');
    });
  });

  describe('Email Masking', () => {
    it('masks local-part while preserving domain', () => {
      expect(maskEmail('juliana@example.com')).toBe('j***a@example.com');
      expect(maskEmail('victor.samuel@empresa.com.br')).toBe('v***l@empresa.com.br');
      expect(maskEmail('ab@test.com')).toBe('a*@test.com');
    });

    it('handles malformed or empty email', () => {
      expect(maskEmail('')).toBe('');
      expect(maskEmail(null)).toBe('');
      expect(maskEmail('invalid-email')).toBe('***@***');
    });
  });

  describe('Category Detection', () => {
    it('detects CPF/CNPJ, phone and email from labels and category hints', () => {
      expect(detectSensitiveCategory('CPF / CNPJ')).toBe('CPF_CNPJ');
      expect(detectSensitiveCategory('Telefone')).toBe('PHONE');
      expect(detectSensitiveCategory('Celular')).toBe('PHONE');
      expect(detectSensitiveCategory('E-mail')).toBe('EMAIL');
      expect(detectSensitiveCategory('Endereço', 'SENSITIVE')).toBe('SENSITIVE');
      expect(detectSensitiveCategory('CRO/UF', 'SENSITIVE')).toBe('SENSITIVE');
      expect(detectSensitiveCategory('Nota Fiscal', 'FISCAL')).toBeNull();
      expect(detectSensitiveCategory('Qual foi o ocorrido?', 'OUTROS')).toBeNull();
    });
  });

  describe('Document Import Payload Sanitization', () => {
    it('masks sensitive fields in additionalInfo and contact without mutating raw inputs', () => {
      const rawExtracted = {
        additionalInfo: [
          { label: 'Nota Fiscal', value: '123456', category: 'FISCAL' },
          { label: 'CPF / CNPJ', value: '111.222.333-44', category: 'SENSITIVE' },
          { label: 'Telefone', value: '(11) 98888-7777', category: 'CONTATO' },
          { label: 'E-mail', value: 'contato.medico@clinica.com.br', category: 'CONTATO' },
        ],
        customerContact: { value: '(11) 98888-7777', confidence: 'IDENTIFIED' },
        customerAddress: { value: 'Rua das Flores, 123, Bairro Centro', confidence: 'IDENTIFIED' },
      };

      const sanitized = sanitizeDocumentImportPayload(rawExtracted);

      // Verify non-sensitive is unchanged
      expect(sanitized.additionalInfo[0].value).toBe('123456');
      expect(sanitized.additionalInfo[0].isMasked).toBe(false);

      // Verify CPF is masked
      expect(sanitized.additionalInfo[1].value).toBe('***.***.333-**');
      expect(sanitized.additionalInfo[1].isMasked).toBe(true);
      expect(sanitized.additionalInfo[1].sensitiveCategory).toBe('CPF_CNPJ');

      // Verify Phone is masked
      expect(sanitized.additionalInfo[2].value).toBe('(11) *****-7777');
      expect(sanitized.additionalInfo[2].isMasked).toBe(true);

      // Verify Email is masked
      expect(sanitized.additionalInfo[3].value).toBe('c***o@clinica.com.br');
      expect(sanitized.additionalInfo[3].isMasked).toBe(true);

      // Verify contact & address are masked
      expect(sanitized.customerContact.value).toBe('(11) *****-7777');
      expect(sanitized.customerContact.isMasked).toBe(true);
      expect(sanitized.customerAddress.isMasked).toBe(true);

      // Original raw input was untouched
      expect(rawExtracted.additionalInfo[1].value).toBe('111.222.333-44');
    });
  });

  describe('Audit Logging for Sensitive Data Reveal', () => {
    it('creates AdminAudit event without storing the sensitive value', async () => {
      const { prisma } = await import('../prisma.js');
      const createSpy = vi.spyOn(prisma.adminAudit, 'create').mockResolvedValue({ id: 'audit-1' } as any);

      await logSensitiveDataRevealAudit({
        actorId: 'admin-user-1',
        resourceType: 'DOCUMENT_IMPORT',
        resourceId: 'import-session-uuid',
        category: 'CPF_CNPJ',
      });

      expect(createSpy).toHaveBeenCalledWith({
        data: {
          type: 'SENSITIVE_DATA_REVEALED',
          actorId: 'admin-user-1',
          targetUserId: 'admin-user-1',
          metadata: expect.objectContaining({
            resourceType: 'DOCUMENT_IMPORT',
            resourceId: 'import-session-uuid',
            category: 'CPF_CNPJ',
          }),
        },
      });

      // Confirm sensitive value was NEVER sent to metadata
      const callData = createSpy.mock.calls[0][0].data;
      expect((callData.metadata as any).value).toBeUndefined();
      createSpy.mockRestore();
    });
  });
});
