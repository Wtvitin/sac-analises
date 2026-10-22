import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const database = {
    sacRecord: { findFirst: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    user: { findUnique: vi.fn() }, activityLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    comment: { create: vi.fn() },
    notification: { create: vi.fn() },
  };
  return { database, transaction: vi.fn(async (input: unknown) => typeof input === 'function' ? (input as (tx: typeof database) => unknown)(database) : Promise.all(input as Promise<unknown>[])) };
});

vi.mock('../../lib/prisma.js', () => ({ prisma: { ...mock.database, $transaction: mock.transaction } }));
import { addSacComment, assignSacRecord, changeSacDueDate, changeSacPriority, changeSacStatus, getSacRecord, takeSacRecord, updateSacTreatment } from './sac.service.js';

const updatedAt = new Date('2026-09-14T12:00:00Z');
const current = {
  id: 'sac-1', ticket: 'SAC-2026-0001', status: 'PENDING' as const, priority: 'HIGH' as const, assigneeId: null, updatedAt,
  openedAt: new Date('2026-09-10T12:00:00Z'), dueAt: new Date('2026-09-15T23:59:59Z'), solutionSummary: null,
  identifiedCause: null, responsibleArea: null, correctiveAction: null, reopenedReason: null, cancellationReason: null, completedAt: null,
};

describe('operações persistentes do caso (isoladas)', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mock.database.sacRecord.findFirst.mockResolvedValue(current); mock.database.sacRecord.updateMany.mockResolvedValue({ count: 1 });
    mock.database.sacRecord.findUniqueOrThrow.mockResolvedValue({ ...current, updatedAt: new Date('2026-09-14T12:01:00Z') });
    mock.database.activityLog.create.mockResolvedValue({ id: 'activity-1' });
    mock.database.notification.create.mockResolvedValue({ id: 'notification-1' });
    mock.database.user.findUnique.mockResolvedValue({ id: 'analyst-1', name: 'Ana Analista', active: true, approvedAt: updatedAt, role: 'ANALYST' });
  });

  it('atribui e assume casos com auditoria', async () => {
    await assignSacRecord('sac-1', { updatedAt, assigneeId: 'analyst-1' }, 'admin-1');
    expect(mock.database.sacRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ assigneeId: 'analyst-1' }) }));
    expect(mock.database.activityLog.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ eventType: 'ASSIGNED' }) });
    expect(mock.database.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ recipientId: 'analyst-1', type: 'ASSIGNED' }) });
    expect(mock.database.sacRecord.updateMany.mock.calls[0][0].data.lastOperationalActivityAt).toBe(mock.database.activityLog.create.mock.calls[0][0].data.createdAt);
    vi.clearAllMocks(); mock.database.sacRecord.findFirst.mockResolvedValue(current); mock.database.sacRecord.updateMany.mockResolvedValue({ count: 1 }); mock.database.sacRecord.findUniqueOrThrow.mockResolvedValue(current); mock.database.user.findUnique.mockResolvedValue({ id: 'analyst-1', name: 'Ana Analista', active: true, approvedAt: updatedAt, role: 'ANALYST' });
    await takeSacRecord('sac-1', { updatedAt }, 'analyst-1');
    expect(mock.database.activityLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'CASE_TAKEN' }) });
  });

  it('não altera a atividade operacional ao somente consultar um caso', async () => {
    await getSacRecord('sac-1');
    expect(mock.database.sacRecord.updateMany).not.toHaveBeenCalled();
    expect(mock.database.activityLog.create).not.toHaveBeenCalled();
  });

  it('exige justificativa ao reduzir prioridade e ao prorrogar prazo', async () => {
    await expect(changeSacPriority('sac-1', { updatedAt, priority: 'MEDIUM' }, 'admin-1')).rejects.toMatchObject({ code: 'JUSTIFICATION_REQUIRED' });
    await expect(changeSacDueDate('sac-1', { updatedAt, dueAt: new Date('2026-09-20T23:59:59Z') }, 'admin-1')).rejects.toMatchObject({ code: 'JUSTIFICATION_REQUIRED' });
    expect(mock.database.sacRecord.updateMany).not.toHaveBeenCalled();
  });

  it('conclui caso exigindo apenas o resumo da solução e permitindo campos técnicos opcionais', async () => {
    mock.database.sacRecord.findFirst.mockResolvedValue({ ...current, status: 'IN_PROGRESS' });
    // Rejeita se o resumo da solução não for informado
    await expect(changeSacStatus('sac-1', { updatedAt, status: 'COMPLETED', assumeIfUnassigned: false }, 'admin-1', 'ADMIN')).rejects.toMatchObject({ code: 'COMPLETION_INCOMPLETE' });

    // Conclui com sucesso apenas com a resposta/solução (campos técnicos omitidos)
    await changeSacStatus('sac-1', { updatedAt, status: 'COMPLETED', solutionSummary: 'Orientação repassada ao cliente e dúvida sanada.', assumeIfUnassigned: false }, 'admin-1', 'ADMIN');
    expect(mock.database.sacRecord.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'COMPLETED',
        solutionSummary: 'Orientação repassada ao cliente e dúvida sanada.',
        identifiedCause: null,
        responsibleArea: null,
        correctiveAction: null,
      }),
    }));
    expect(mock.database.activityLog.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ eventType: 'COMPLETED' }) });

    // Permite também concluir preenchendo todos os campos técnicos se o operador desejar
    await changeSacStatus('sac-1', { updatedAt, status: 'COMPLETED', solutionSummary: 'Troca realizada.', identifiedCause: 'Avaria no transporte.', responsibleArea: 'Logística', correctiveAction: 'Reforço da embalagem.', assumeIfUnassigned: false }, 'admin-1', 'ADMIN');
    expect(mock.database.sacRecord.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'COMPLETED',
        solutionSummary: 'Troca realizada.',
        identifiedCause: 'Avaria no transporte.',
        responsibleArea: 'Logística',
        correctiveAction: 'Reforço da embalagem.',
      }),
    }));
  });

  it('não inicia atendimento sem atribuir ou assumir o caso', async () => {
    await expect(changeSacStatus('sac-1', { updatedAt, status: 'IN_PROGRESS', assumeIfUnassigned: false }, 'admin-1', 'ADMIN')).rejects.toMatchObject({ code: 'ASSIGNEE_REQUIRED' });
    await changeSacStatus('sac-1', { updatedAt, status: 'IN_PROGRESS', assumeIfUnassigned: true }, 'analyst-1', 'ANALYST');
    expect(mock.database.sacRecord.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'IN_PROGRESS', assigneeId: 'analyst-1' }) }));
  });

  it('cancela com justificativa e rejeita reativação por analista', async () => {
    await expect(changeSacStatus('sac-1', { updatedAt, status: 'CANCELLED', assumeIfUnassigned: false }, 'admin-1', 'ADMIN')).rejects.toMatchObject({ code: 'JUSTIFICATION_REQUIRED' });
    await changeSacStatus('sac-1', { updatedAt, status: 'CANCELLED', reason: 'Solicitação duplicada.', assumeIfUnassigned: false }, 'admin-1', 'ADMIN');
    expect(mock.database.activityLog.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ eventType: 'CANCELLED' }) });
    mock.database.sacRecord.findFirst.mockResolvedValue({ ...current, status: 'CANCELLED' });
    await expect(changeSacStatus('sac-1', { updatedAt, status: 'PENDING', reason: 'Retomada aprovada.', assumeIfUnassigned: false }, 'analyst-1', 'ANALYST')).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION', status: 403 });
  });

  it('rejeita concorrência antes de qualquer escrita', async () => {
    mock.database.sacRecord.findFirst.mockResolvedValue({ ...current, updatedAt: new Date('2026-09-14T12:02:00Z') });
    await expect(changeSacPriority('sac-1', { updatedAt, priority: 'CRITICAL' }, 'admin-1')).rejects.toMatchObject({ code: 'STALE_SAC_RECORD', status: 409 });
    expect(mock.database.sacRecord.updateMany).not.toHaveBeenCalled();
  });

  it('bloqueia mudança operacional em caso concluído', async () => {
    mock.database.sacRecord.findFirst.mockResolvedValue({ ...current, status: 'COMPLETED' });
    await expect(assignSacRecord('sac-1', { updatedAt, assigneeId: 'analyst-1' }, 'admin-1')).rejects.toMatchObject({ code: 'CASE_NOT_OPERATIONAL' });
    expect(mock.database.sacRecord.updateMany).not.toHaveBeenCalled();
  });

  it('sanitiza e persiste comentário interno, atualizando o histórico', async () => {
    mock.database.comment.create.mockResolvedValue({ id: 'comment-1', body: 'Atualização segura', author: { id: 'admin-1', name: 'Admin' } });
    await addSacComment('sac-1', { updatedAt, body: '<script>Atualização segura</script>' }, 'admin-1');
    expect(mock.database.comment.create).toHaveBeenCalledWith(expect.objectContaining({ data: { recordId: 'sac-1', authorId: 'admin-1', body: 'Atualização segura' } }));
    expect(mock.database.activityLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'COMMENT_ADDED' }) });
  });

  it('notifica o responsável sobre comentário, elevação de prioridade e mudança de prazo', async () => {
    const assigned = { ...current, assigneeId: 'analyst-1', priority: 'MEDIUM' as const };
    mock.database.sacRecord.findFirst.mockResolvedValue(assigned);
    mock.database.comment.create.mockResolvedValue({ id: 'comment-1', body: 'Atualização', author: { id: 'admin-1', name: 'Admin' } });
    await addSacComment('sac-1', { updatedAt, body: 'Atualização' }, 'admin-1');
    expect(mock.database.notification.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ recipientId: 'analyst-1', type: 'COMMENT_ADDED' }) });

    await changeSacPriority('sac-1', { updatedAt, priority: 'HIGH' }, 'admin-1');
    expect(mock.database.notification.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ recipientId: 'analyst-1', type: 'PRIORITY_RAISED' }) });

    await changeSacDueDate('sac-1', { updatedAt, dueAt: new Date('2026-09-14T23:59:59Z') }, 'admin-1');
    expect(mock.database.notification.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ recipientId: 'analyst-1', type: 'DUE_DATE_CHANGED' }) });
  });

  it('notifica eventos de status sem notificar o próprio ator', async () => {
    mock.database.sacRecord.findFirst.mockResolvedValue({ ...current, assigneeId: 'analyst-1' });
    await changeSacStatus('sac-1', { updatedAt, status: 'IN_PROGRESS', assumeIfUnassigned: false }, 'admin-1', 'ADMIN');
    expect(mock.database.notification.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ recipientId: 'analyst-1', type: 'STATUS_CHANGED' }) });

    mock.database.notification.create.mockClear();
    mock.database.sacRecord.findFirst.mockResolvedValue({ ...current, assigneeId: 'admin-1' });
    await changeSacStatus('sac-1', { updatedAt, status: 'IN_PROGRESS', assumeIfUnassigned: false }, 'admin-1', 'ADMIN');
    expect(mock.database.notification.create).not.toHaveBeenCalled();
  });

  it('atualiza tratativa posterior e registra evento TREATMENT_UPDATED no histórico', async () => {
    mock.database.sacRecord.findFirst.mockResolvedValue({ ...current, status: 'IN_PROGRESS' });
    const treatmentInput = {
      updatedAt,
      solutionSummary: 'Tratativa apresentada ao cliente com reposição de item.',
      identifiedCause: 'Fissura na embalagem externa.',
      responsibleArea: 'Expedição',
      correctiveAction: 'Reforço de fita gomada e inspeção final.',
    };

    await updateSacTreatment('sac-1', treatmentInput, 'analyst-1');

    expect(mock.database.sacRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sac-1', updatedAt },
        data: expect.objectContaining({
          solutionSummary: treatmentInput.solutionSummary,
          identifiedCause: treatmentInput.identifiedCause,
          responsibleArea: treatmentInput.responsibleArea,
          correctiveAction: treatmentInput.correctiveAction,
        }),
      })
    );
    expect(mock.database.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recordId: 'sac-1',
        actorId: 'analyst-1',
        eventType: 'TREATMENT_UPDATED',
        summary: 'Resposta e tratativa operacional registradas.',
        before: expect.objectContaining({
          solutionSummary: null,
          identifiedCause: null,
          responsibleArea: null,
          correctiveAction: null,
        }),
        after: expect.objectContaining({
          solutionSummary: treatmentInput.solutionSummary,
          identifiedCause: treatmentInput.identifiedCause,
          responsibleArea: treatmentInput.responsibleArea,
          correctiveAction: treatmentInput.correctiveAction,
        }),
      }),
    });
  });

  it('registrar tratativa em caso em andamento NÃO conclui o caso nem altera completedAt', async () => {
    mock.database.sacRecord.findFirst.mockResolvedValue({
      ...current,
      status: 'IN_PROGRESS',
      completedAt: null,
    });

    await updateSacTreatment('sac-1', {
      updatedAt,
      solutionSummary: 'Resposta preliminar enviada ao cliente aguardando laudo.',
    }, 'analyst-1');

    // Verifica que status e completedAt NÃO foram incluídos no updateMany
    const updateCall = mock.database.sacRecord.updateMany.mock.calls.at(-1)?.[0];
    expect(updateCall.data.status).toBeUndefined();
    expect(updateCall.data.completedAt).toBeUndefined();
    expect(updateCall.data.solutionSummary).toBe('Resposta preliminar enviada ao cliente aguardando laudo.');

    // Verifica que nenhum evento de conclusão foi gerado
    const activityCall = mock.database.activityLog.create.mock.calls.at(-1)?.[0];
    expect(activityCall.data.eventType).toBe('TREATMENT_UPDATED');
    expect(activityCall.data.eventType).not.toBe('COMPLETED');

    // Confere o conteúdo estrutural de before e after no log de atividade
    expect(activityCall.data.after).not.toHaveProperty('document');
    expect(activityCall.data.after).not.toHaveProperty('password');
    // Os campos de texto livre (solutionSummary, etc.) gravam fielmente o texto digitado pelo operador,
    // podendo conter eventuais dados pessoais ou de contato inseridos no relato.
    expect(activityCall.data.after.solutionSummary).toBe('Resposta preliminar enviada ao cliente aguardando laudo.');
  });

  it('permite concluir o caso aproveitando causa, área e ação já registradas durante a tratativa preliminar', async () => {
    mock.database.sacRecord.findFirst.mockResolvedValue({
      ...current,
      status: 'IN_PROGRESS',
      solutionSummary: 'Tratativa intermediária já registrada.',
      identifiedCause: 'Falha no lote de matéria-prima.',
      responsibleArea: 'Qualidade',
      correctiveAction: 'Bloqueio do lote e descarte.',
    });

    await changeSacStatus('sac-1', {
      updatedAt,
      status: 'COMPLETED',
      solutionSummary: 'Caso concluído com encerramento formal.',
      assumeIfUnassigned: false,
    }, 'admin-1', 'ADMIN');

    expect(mock.database.sacRecord.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'COMPLETED',
          solutionSummary: 'Caso concluído com encerramento formal.',
          identifiedCause: 'Falha no lote de matéria-prima.',
          responsibleArea: 'Qualidade',
          correctiveAction: 'Bloqueio do lote e descarte.',
        }),
      })
    );
    expect(mock.database.activityLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        eventType: 'COMPLETED',
        after: expect.objectContaining({
          status: 'COMPLETED',
          identifiedCause: 'Falha no lote de matéria-prima.',
          responsibleArea: 'Qualidade',
          correctiveAction: 'Bloqueio do lote e descarte.',
        }),
      }),
    });
  });

  it('preserva no evento TREATMENT_UPDATED o histórico exato do texto livre digitado em before e after', async () => {
    mock.database.sacRecord.findFirst.mockResolvedValue({
      ...current,
      status: 'IN_PROGRESS',
      solutionSummary: 'Atendimento inicial com cliente Carlos Silva pelo telefone (11) 98765-4321.',
      identifiedCause: 'Problema na montagem.',
      responsibleArea: 'Produção',
      correctiveAction: 'Reinstrução da equipe.',
    });

    await updateSacTreatment('sac-1', {
      updatedAt,
      solutionSummary: 'Cliente Carlos Silva confirmou recebimento da peça substituta.',
    }, 'analyst-1');

    const activityCall = mock.database.activityLog.create.mock.calls.at(-1)?.[0];
    expect(activityCall.data.eventType).toBe('TREATMENT_UPDATED');
    expect(activityCall.data.before.solutionSummary).toBe('Atendimento inicial com cliente Carlos Silva pelo telefone (11) 98765-4321.');
    expect(activityCall.data.after.solutionSummary).toBe('Cliente Carlos Silva confirmou recebimento da peça substituta.');
  });

  it('bloqueia registro de tratativa direta em casos já concluídos ou cancelados para preservar histórico', async () => {
    mock.database.sacRecord.findFirst.mockResolvedValue({
      ...current,
      status: 'COMPLETED',
      completedAt: new Date('2026-09-12T10:00:00Z'),
      solutionSummary: 'Solução definitiva anterior.',
    });

    await expect(
      updateSacTreatment('sac-1', {
        updatedAt,
        solutionSummary: 'Tentativa de alteração indevida.',
      }, 'analyst-1')
    ).rejects.toThrow('Reabra ou reative o caso antes de alterar seus dados operacionais.');
  });
});
