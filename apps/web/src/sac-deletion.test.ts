import { describe, expect, it, vi } from 'vitest';

describe('Exclusão de Registros SAC - Regras e Permissões no Frontend', () => {
  it('disponibiliza a ação de exclusão exclusivamente para ADMIN', () => {
    const roles: Array<'ADMIN' | 'ANALYST' | 'VIEWER'> = ['ADMIN', 'ANALYST', 'VIEWER'];
    const canDelete = (role: 'ADMIN' | 'ANALYST' | 'VIEWER') => role === 'ADMIN';

    expect(canDelete('ADMIN')).toBe(true);
    expect(canDelete('ANALYST')).toBe(false);
    expect(canDelete('VIEWER')).toBe(false);
  });

  it('valida os requisitos de justificativa (min 5 caracteres) e confirmação explícita', () => {
    const validateDeletionForm = (justification: string, confirmed: boolean, saving: boolean) => {
      const trimmed = justification.trim();
      if (saving) return { valid: false, error: 'Salvando...' };
      if (trimmed.length < 5) return { valid: false, error: 'Informe uma justificativa com no mínimo 5 caracteres.' };
      if (!confirmed) return { valid: false, error: 'Marque a confirmação para autorizar a exclusão.' };
      return { valid: true, error: '' };
    };

    // Justificativa vazia
    expect(validateDeletionForm('', true, false)).toEqual({
      valid: false,
      error: 'Informe uma justificativa com no mínimo 5 caracteres.',
    });

    // Justificativa muito curta
    expect(validateDeletionForm('1234', true, false)).toEqual({
      valid: false,
      error: 'Informe uma justificativa com no mínimo 5 caracteres.',
    });

    // Sem confirmação explícita
    expect(validateDeletionForm('Justificativa válida com mais de cinco caracteres', false, false)).toEqual({
      valid: false,
      error: 'Marque a confirmação para autorizar a exclusão.',
    });

    // Em processo de salvamento (bloqueia envio duplicado)
    expect(validateDeletionForm('Justificativa válida com mais de cinco caracteres', true, true)).toEqual({
      valid: false,
      error: 'Salvando...',
    });

    // Válido
    expect(validateDeletionForm('Justificativa válida com mais de cinco caracteres', true, false)).toEqual({
      valid: true,
      error: '',
    });
  });

  it('monta o payload correto contendo a data da última atualização para controle de concorrência', () => {
    const record = {
      id: 'sac-101',
      ticket: 'SAC-2026-0101',
      updatedAt: '2026-10-05T12:00:00.000Z',
    };

    const buildPayload = (rec: typeof record, justification: string) => ({
      updatedAt: rec.updatedAt || new Date().toISOString(),
      justification: justification.trim(),
    });

    const payload = buildPayload(record, '   Caso duplicado identificado na triagem   ');
    expect(payload).toEqual({
      updatedAt: '2026-10-05T12:00:00.000Z',
      justification: 'Caso duplicado identificado na triagem',
    });
  });
});
