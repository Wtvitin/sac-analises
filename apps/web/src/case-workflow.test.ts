import { describe, expect, it } from 'vitest';
import { availableCaseActions, buildOperationRequest, requiresDueDateReason, requiresPriorityReason } from './case-workflow';

describe('ações operacionais do caso', () => {
  it('expõe as ações compatíveis com cada estado', () => {
    expect(availableCaseActions('PENDING', 'ANALYST', false)).toEqual(['take-and-start', 'cancel']);
    expect(availableCaseActions('PENDING', 'ANALYST', true)).toEqual(['start', 'cancel']);
    expect(availableCaseActions('IN_PROGRESS', 'ANALYST', true)).toEqual(['complete', 'cancel']);
    expect(availableCaseActions('COMPLETED', 'ANALYST', true)).toEqual(['reopen']);
    expect(availableCaseActions('CANCELLED', 'ADMIN', true)).toEqual(['reactivate']);
  });
  it('não oferece mutações a consulta nem reativação a analista', () => {
    expect(availableCaseActions('PENDING', 'VIEWER', false)).toEqual([]);
    expect(availableCaseActions('CANCELLED', 'ANALYST', true)).toEqual([]);
  });
  it('identifica justificativas de redução e prorrogação', () => {
    expect(requiresPriorityReason('HIGH', 'MEDIUM')).toBe(true);
    expect(requiresPriorityReason('LOW', 'HIGH')).toBe(false);
    expect(requiresDueDateReason('2026-09-14', '2026-09-15')).toBe(true);
    expect(requiresDueDateReason('2026-09-14', '2026-09-13')).toBe(false);
  });
});

describe('buildOperationRequest - montagem segura das requisições operacionais', () => {
  const updatedAt = '2026-10-02T12:00:00.000Z';

  it('constrói payload correto para "Iniciar atendimento" (start) com status IN_PROGRESS e assumeIfUnassigned=false', () => {
    const req = buildOperationRequest('rec-100', {
      operation: 'start',
      updatedAt,
    });
    expect(req).toEqual({
      path: '/sac-records/rec-100/status',
      method: 'POST',
      payload: {
        updatedAt,
        status: 'IN_PROGRESS',
        assumeIfUnassigned: false,
      },
    });
  });

  it('constrói payload correto para "Assumir e iniciar" (take-and-start) com assumeIfUnassigned=true', () => {
    const req = buildOperationRequest('rec-100', {
      operation: 'take-and-start',
      updatedAt,
    });
    expect(req).toEqual({
      path: '/sac-records/rec-100/status',
      method: 'POST',
      payload: {
        updatedAt,
        status: 'IN_PROGRESS',
        assumeIfUnassigned: true,
      },
    });
  });

  it('constrói payload correto para cancelamento com status CANCELLED e justificativa', () => {
    const req = buildOperationRequest('rec-100', {
      operation: 'cancel',
      updatedAt,
      reason: 'Cancelado a pedido do cliente.',
    });
    expect(req).toEqual({
      path: '/sac-records/rec-100/status',
      method: 'POST',
      payload: {
        updatedAt,
        status: 'CANCELLED',
        reason: 'Cancelado a pedido do cliente.',
      },
    });
  });

  it('constrói payload correto para conclusão com dados de tratativa e análise técnica', () => {
    const req = buildOperationRequest('rec-100', {
      operation: 'complete',
      updatedAt,
      solution: 'Dúvida sanada com o cliente.',
      cause: 'Instabilidade momentânea',
      area: 'Operações',
      corrective: 'Ajuste de rota',
    });
    expect(req).toEqual({
      path: '/sac-records/rec-100/status',
      method: 'POST',
      payload: {
        updatedAt,
        status: 'COMPLETED',
        solutionSummary: 'Dúvida sanada com o cliente.',
        identifiedCause: 'Instabilidade momentânea',
        responsibleArea: 'Operações',
        correctiveAction: 'Ajuste de rota',
      },
    });
  });

  it('reutiliza dados técnicos pré-existentes do caso ao concluir se não forem informados novos', () => {
    const req = buildOperationRequest('rec-100', {
      operation: 'complete',
      updatedAt,
      solution: 'Conclusão direta.',
      recordIdentifiedCause: 'Causa anterior',
      recordResponsibleArea: 'Área anterior',
      recordCorrectiveAction: 'Ação anterior',
    });
    expect(req.payload).toMatchObject({
      status: 'COMPLETED',
      solutionSummary: 'Conclusão direta.',
      identifiedCause: 'Causa anterior',
      responsibleArea: 'Área anterior',
      correctiveAction: 'Ação anterior',
    });
  });

  it('constrói requisição para atribuição de responsável', () => {
    const req = buildOperationRequest('rec-100', {
      operation: 'assign',
      updatedAt,
      assigneeId: 'user-42',
      reason: 'Redirecionamento de fila',
    });
    expect(req).toEqual({
      path: '/sac-records/rec-100/assignee',
      method: 'PATCH',
      payload: {
        updatedAt,
        assigneeId: 'user-42',
        justification: 'Redirecionamento de fila',
      },
    });
  });

  it('constrói requisição para alteração de setor e valida setor destino', () => {
    expect(() => buildOperationRequest('rec-100', {
      operation: 'department',
      updatedAt,
      targetDepartment: '   ',
    })).toThrow('Selecione um setor.');

    expect(() => buildOperationRequest('rec-100', {
      operation: 'department',
      updatedAt,
      targetDepartment: 'SAC',
      recordDepartment: 'SAC',
    })).toThrow('O caso já pertence a este setor.');

    const req = buildOperationRequest('rec-100', {
      operation: 'department',
      updatedAt,
      targetDepartment: 'Logística',
      recordDepartment: 'SAC',
      reason: 'Erro de triagem',
    });
    expect(req).toEqual({
      path: '/sac-records/rec-100/department',
      method: 'PATCH',
      payload: {
        department: 'Logística',
        justification: 'Erro de triagem',
      },
    });
  });
});
