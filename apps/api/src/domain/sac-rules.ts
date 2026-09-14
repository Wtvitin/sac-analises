export type SacStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type UserRole = 'ADMIN' | 'ANALYST' | 'VIEWER';

export const allowedTransitions: Record<SacStatus, SacStatus[]> = {
  PENDING: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: ['IN_PROGRESS'],
  CANCELLED: ['PENDING'],
};

export function assertStatusTransition(from: SacStatus, to: SacStatus, role: UserRole) {
  if (from === to || !allowedTransitions[from].includes(to)) throw new Error(`A transição de ${from} para ${to} não é permitida.`);
  if (from === 'CANCELLED' && to === 'PENDING' && role !== 'ADMIN') throw new Error('Somente administradores podem reativar casos cancelados.');
}

export function isOverdue(status: SacStatus, dueAt: Date, now = new Date()) {
  return status !== 'COMPLETED' && dueAt.getTime() < now.getTime();
}

export function assertCanComplete(solutionSummary?: string) {
  if (!solutionSummary?.trim()) throw new Error('O resumo da solução é obrigatório para concluir o caso.');
}

export function assertCanReopen(reason?: string) {
  if (!reason?.trim()) throw new Error('A justificativa é obrigatória para reabrir o caso.');
}

export function assertCanCancel(reason?: string) {
  if (!reason?.trim()) throw new Error('A justificativa é obrigatória para cancelar o caso.');
}

export function assertCanReactivate(reason?: string) {
  if (!reason?.trim()) throw new Error('A justificativa é obrigatória para reativar o caso.');
}
