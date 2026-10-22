import { describe, it, expect, vi } from 'vitest';
import {
  maskCpfCnpj,
  maskPhone,
  maskEmail,
  maskClinicalData,
  maskGenericSensitive,
  detectSensitiveCategory,
  hasPersonalIdentificationInFilename,
  sanitizeDocumentImportPayload,
  logSensitiveDataRevealAudit,
} from './privacy.service.js';

describe('Privacy and Masking Service (Synthetic Data)', () => {
  describe('CPF / CNPJ Masking', () => {
    it('masks standard 11-digit CPF with fixed concealment and no fragments', () => {
      const inputs = ['123.456.789-00', '12345678900', '98765432199'];
      for (const input of inputs) {
        const masked = maskCpfCnpj(input);
        expect(masked).toBe('***');
        expect(masked).not.toContain('123');
        expect(masked).not.toContain('789');
        expect(masked).not.toContain('321');
        expect(masked).not.toContain('-');
        expect(masked).not.toContain('.');
      }
    });

    it('masks standard 14-digit CNPJ with fixed concealment and no fragments', () => {
      const inputs = ['12.345.678/0001-90', '12345678000190'];
      for (const input of inputs) {
        const masked = maskCpfCnpj(input);
        expect(masked).toBe('***');
        expect(masked).not.toContain('0001');
        expect(masked).not.toContain('12');
        expect(masked).not.toContain('/');
      }
    });

    it('handles empty, whitespace or short input preserving absence of information', () => {
      expect(maskCpfCnpj('')).toBe('');
      expect(maskCpfCnpj('   ')).toBe('');
      expect(maskCpfCnpj(null)).toBe('');
      expect(maskCpfCnpj(undefined)).toBe('');
      expect(maskCpfCnpj('12345')).toBe('***');
    });
  });

  describe('Phone Masking', () => {
    it('masks phones with fixed concealment without exposing DDD or digits', () => {
      const phones = ['(11) 98765-4321', '11987654321', '(21) 3456-7890', '1234'];
      for (const phone of phones) {
        const masked = maskPhone(phone);
        expect(masked).toBe('***');
        expect(masked).not.toContain('11');
        expect(masked).not.toContain('21');
        expect(masked).not.toContain('4321');
        expect(masked).not.toContain('7890');
      }
    });

    it('handles null, empty and whitespace phone preserving absence of information', () => {
      expect(maskPhone('')).toBe('');
      expect(maskPhone('   ')).toBe('');
      expect(maskPhone(null)).toBe('');
      expect(maskPhone(undefined)).toBe('');
    });
  });

  describe('Email Masking', () => {
    it('masks emails with fixed concealment without exposing user or domain', () => {
      const emails = ['juliana@example.com', 'victor.samuel@empresa.com.br', 'ab@test.com', 'invalid-email'];
      for (const email of emails) {
        const masked = maskEmail(email);
        expect(masked).toBe('***');
        expect(masked).not.toContain('@');
        expect(masked).not.toContain('example.com');
        expect(masked).not.toContain('empresa.com.br');
        expect(masked).not.toContain('juliana');
      }
    });

    it('handles empty and null email preserving absence of information', () => {
      expect(maskEmail('')).toBe('');
      expect(maskEmail('   ')).toBe('');
      expect(maskEmail(null)).toBe('');
      expect(maskEmail(undefined)).toBe('');
    });
  });

  describe('Patient Clinical and Health Data Masking (LGPD Art. 5, II / Art. 11)', () => {
    it('masks clinical values with exact *** concealing patient health data', () => {
      expect(maskClinicalData('Hipertensão e diabetes')).toBe('***');
      expect(maskClinicalData('54 anos')).toBe('***');
      expect(maskClinicalData('Feminino')).toBe('***');
      expect(maskClinicalData('')).toBe('');
      expect(maskClinicalData(null)).toBe('');
    });

    it('detects clinical categories for patient health conditions, demographics and anamnesis', () => {
      expect(detectSensitiveCategory('Idade do paciente', 'CLINICO')).toBe('CLINICAL');
      expect(detectSensitiveCategory('Sexo do paciente', 'CLINICO')).toBe('CLINICAL');
      expect(detectSensitiveCategory('Nome do paciente', 'CLINICO')).toBe('CLINICAL');
      expect(detectSensitiveCategory('Alergia/Hipersensibilidade', 'CLINICO')).toBe('CLINICAL');
      expect(detectSensitiveCategory('Medicamento contínuo', 'CLINICO')).toBe('CLINICAL');
      expect(detectSensitiveCategory('Outras doenças', 'CLINICO')).toBe('CLINICAL');
      expect(detectSensitiveCategory('Cirurgia recente?', 'CLINICO')).toBe('CLINICAL');
      expect(detectSensitiveCategory('Intercorrência cirúrgica', 'CLINICO')).toBe('CLINICAL');
    });

    it('distinguishes operational technical fields from sensitive clinical patient data', () => {
      // Technical product attributes are NOT patient personal clinical data
      expect(detectSensitiveCategory('Tipo de osso', 'CLINICO')).toBeNull();
      expect(detectSensitiveCategory('Estabilidade primária (Torque Ncm)', 'CLINICO')).toBeNull();
      expect(detectSensitiveCategory('Tipo de prótese', 'CLINICO')).toBeNull();
      expect(detectSensitiveCategory('Material da prótese', 'CLINICO')).toBeNull();
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

  describe('Document Import Payload Sanitization and Source Snippet Protection', () => {
    it('masks sensitive fields, patient clinical data, and sanitizes sourceSnippets to avoid fragment leakage', () => {
      const rawExtracted = {
        additionalInfo: [
          { label: 'Nota Fiscal', value: '123456', category: 'FISCAL' },
          { label: 'CPF / CNPJ', value: '111.222.333-44', category: 'SENSITIVE' },
          { label: 'Telefone', value: '(11) 98888-7777', category: 'CONTATO' },
          { label: 'E-mail', value: 'contato.medico@clinica.com.br', category: 'CONTATO' },
          // Patient clinical fields
          { label: 'Idade do paciente', value: '54', category: 'CLINICO', sourceSnippet: 'Idade: 54' },
          { label: 'Sexo do paciente', value: 'Feminino', category: 'CLINICO', sourceSnippet: 'Sexo: Feminino' },
          { label: 'Medicamento contínuo', value: 'Losartana 50mg', category: 'CLINICO', sourceSnippet: 'Medicamento: Losartana 50mg' },
          { label: 'Outras doenças', value: 'Hipertensão arterial', category: 'CLINICO', sourceSnippet: 'Doenças: Hipertensão' },
          // Operational non-sensitive field
          { label: 'Tipo de osso', value: 'Tipo II', category: 'CLINICO' },
        ],
        customerContact: {
          value: '(11) 98888-7777',
          sourceSnippet: 'Tel: (11) 98888-7777 | E-mail: contato.medico@clinica.com.br',
          confidence: 'IDENTIFIED',
        },
        customerAddress: {
          value: 'Rua das Flores, 123, Bairro Centro',
          sourceSnippet: 'Endereço: "Rua das Flores, 123"',
          confidence: 'IDENTIFIED',
        },
      };

      const sanitized = sanitizeDocumentImportPayload(rawExtracted);

      // Verify non-sensitive is unchanged
      expect(sanitized.additionalInfo[0].value).toBe('123456');
      expect(sanitized.additionalInfo[0].isMasked).toBe(false);
      expect(sanitized.additionalInfo[8].value).toBe('Tipo II');
      expect(sanitized.additionalInfo[8].isMasked).toBe(false);

      // Verify CPF is masked to exact '***'
      expect(sanitized.additionalInfo[1].value).toBe('***');
      expect(sanitized.additionalInfo[1].isMasked).toBe(true);
      expect(sanitized.additionalInfo[1].sensitiveCategory).toBe('CPF_CNPJ');

      // Verify Phone & Email are masked
      expect(sanitized.additionalInfo[2].value).toBe('***');
      expect(sanitized.additionalInfo[2].isMasked).toBe(true);
      expect(sanitized.additionalInfo[3].value).toBe('***');
      expect(sanitized.additionalInfo[3].isMasked).toBe(true);

      // Verify patient clinical fields are masked
      expect(sanitized.additionalInfo[4].value).toBe('***');
      expect(sanitized.additionalInfo[4].isMasked).toBe(true);
      expect(sanitized.additionalInfo[4].sensitiveCategory).toBe('CLINICAL');
      expect(sanitized.additionalInfo[4].sourceSnippet).toBeUndefined();

      expect(sanitized.additionalInfo[5].value).toBe('***');
      expect(sanitized.additionalInfo[5].isMasked).toBe(true);
      expect(sanitized.additionalInfo[5].sensitiveCategory).toBe('CLINICAL');

      expect(sanitized.additionalInfo[6].value).toBe('***');
      expect(sanitized.additionalInfo[6].isMasked).toBe(true);
      expect(sanitized.additionalInfo[6].sensitiveCategory).toBe('CLINICAL');

      expect(sanitized.additionalInfo[7].value).toBe('***');
      expect(sanitized.additionalInfo[7].isMasked).toBe(true);
      expect(sanitized.additionalInfo[7].sensitiveCategory).toBe('CLINICAL');

      // Verify contact & address values AND sourceSnippets are sanitized
      expect(sanitized.customerContact.value).toBe('***');
      expect(sanitized.customerContact.isMasked).toBe(true);
      expect(sanitized.customerContact.sourceSnippet).not.toContain('98888-7777');
      expect(sanitized.customerContact.sourceSnippet).not.toContain('clinica.com.br');

      expect(sanitized.customerAddress.value).toBe('***');
      expect(sanitized.customerAddress.isMasked).toBe(true);
      expect(sanitized.customerAddress.sourceSnippet).not.toContain('Rua das Flores');

      // Assert no sensitive fragments appear anywhere in serialized sanitized JSON
      const serialized = JSON.stringify(sanitized);
      expect(serialized).not.toContain('111.222.333-44');
      expect(serialized).not.toContain('98888-7777');
      expect(serialized).not.toContain('clinica.com.br');
      expect(serialized).not.toContain('Rua das Flores');
      expect(serialized).not.toContain('Losartana');
      expect(serialized).not.toContain('Hipertensão');

      // Original raw input was untouched
      expect(rawExtracted.additionalInfo[1].value).toBe('111.222.333-44');
      expect(rawExtracted.additionalInfo[6].value).toBe('Losartana 50mg');
    });
  });

  describe('Audit Logging for Sensitive Data Reveal', () => {
    it('creates AdminAudit event for CLINICAL category without storing sensitive values', async () => {
      const { prisma } = await import('../prisma.js');
      const createSpy = vi.spyOn(prisma.adminAudit, 'create').mockResolvedValue({ id: 'audit-1' } as any);

      await logSensitiveDataRevealAudit({
        actorId: 'admin-user-1',
        resourceType: 'DOCUMENT_IMPORT',
        resourceId: 'import-session-uuid',
        category: 'CLINICAL',
        fieldPath: 'additionalInfo.4',
      });

      expect(createSpy).toHaveBeenCalledWith({
        data: {
          type: 'SENSITIVE_DATA_REVEALED',
          actorId: 'admin-user-1',
          targetUserId: 'admin-user-1',
          metadata: expect.objectContaining({
            resourceType: 'DOCUMENT_IMPORT',
            resourceId: 'import-session-uuid',
            category: 'CLINICAL',
            fieldPath: 'additionalInfo.4',
          }),
        },
      });

      // Confirm sensitive value was NEVER sent to metadata
      const callData = createSpy.mock.calls[0][0].data;
      expect((callData.metadata as any).value).toBeUndefined();
      createSpy.mockRestore();
    });
  });

  describe('Referenced Files Filename Masking and Personal Identification Detection', () => {
    it('detects personal identification in patient filenames', () => {
      expect(hasPersonalIdentificationInFilename('16-05-2025-Paciente-Teste-Ficticio-16-12-19621.jpeg')).toBe(true);
      expect(hasPersonalIdentificationInFilename('09-01-2026-Paciente-Silveira-16-12-1962-11.jpeg')).toBe(true);
      expect(hasPersonalIdentificationInFilename('Paciente_Maria_Silva.pdf')).toBe(true);
      expect(hasPersonalIdentificationInFilename('16-12-1962-Maria-Silva.jpeg')).toBe(true);
      expect(hasPersonalIdentificationInFilename('exame_paciente_carlos.png')).toBe(true);
      expect(hasPersonalIdentificationInFilename('cpf_00000000000_laudo.pdf')).toBe(true);
    });

    it('does not falsely flag non-PII operational or technical filenames', () => {
      expect(hasPersonalIdentificationInFilename('IMG_2858.jpeg')).toBe(false);
      expect(hasPersonalIdentificationInFilename('foto_produto.png')).toBe(false);
      expect(hasPersonalIdentificationInFilename('radiografia_periapical.png')).toBe(false);
      expect(hasPersonalIdentificationInFilename('etiqueta_134597.png')).toBe(false);
      expect(hasPersonalIdentificationInFilename('rotulo_embalagem.jpg')).toBe(false);
      expect(hasPersonalIdentificationInFilename('rx_implante_22274.jpg')).toBe(false);
      expect(hasPersonalIdentificationInFilename('danfe_000865874.pdf')).toBe(false);
    });

    it('masks patient-identifying referenced filenames entirely as "***" without preserving fragments or extensions', () => {
      const rawExtracted = {
        referencedFiles: [
          { name: '16-05-2025-Paciente-Teste-Ficticio-16-12-19621.jpeg', attached: false },
          { name: 'IMG_2858.jpeg', attached: false },
          { name: 'foto_produto.png', attached: false },
        ],
      };

      const sanitized = sanitizeDocumentImportPayload(rawExtracted);

      // Sensitive file: entirely '***' without extension or birthdate
      expect(sanitized.referencedFiles[0].name).toBe('***');
      expect(sanitized.referencedFiles[0].isMasked).toBe(true);
      expect(sanitized.referencedFiles[0].isSensitive).toBe(true);
      expect(sanitized.referencedFiles[0].sensitiveCategory).toBe('CLINICAL');
      expect(sanitized.referencedFiles[0].fileIndex).toBe(0);

      // Operational files: unchanged
      expect(sanitized.referencedFiles[1].name).toBe('IMG_2858.jpeg');
      expect(sanitized.referencedFiles[1].isMasked).toBe(false);
      expect(sanitized.referencedFiles[1].fileIndex).toBe(1);

      expect(sanitized.referencedFiles[2].name).toBe('foto_produto.png');
      expect(sanitized.referencedFiles[2].isMasked).toBe(false);
      expect(sanitized.referencedFiles[2].fileIndex).toBe(2);

      // Serialized sanitized payload contains NO identifying fragments
      const serialized = JSON.stringify(sanitized);
      expect(serialized).not.toContain('Paciente-Teste-Ficticio');
      expect(serialized).not.toContain('16-12-1962');
      expect(sanitized.referencedFiles[0].name).not.toContain('.jpeg'); // The masked entry does not leak .jpeg

      // Raw extracted remains intact
      expect(rawExtracted.referencedFiles[0].name).toBe('16-05-2025-Paciente-Teste-Ficticio-16-12-19621.jpeg');
    });
  });
});
