import type { AuthUser } from './api';

export type CaseStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type CaseAction = 'start' | 'take-and-start' | 'complete' | 'cancel' | 'reopen' | 'reactivate';

export function availableCaseActions(status: CaseStatus, role: AuthUser['role'], assigned: boolean): CaseAction[] {
  if (role === 'VIEWER') return [];
  if (status === 'PENDING') return [assigned ? 'start' : 'take-and-start', 'cancel'];
  if (status === 'IN_PROGRESS') return ['complete', 'cancel'];
  if (status === 'COMPLETED') return ['reopen'];
  return role === 'ADMIN' ? ['reactivate'] : [];
}

export function requiresPriorityReason(current: string, next: string) {
  const rank: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
  return Boolean(rank[current] && rank[next] && rank[next] < rank[current]);
}

export function requiresDueDateReason(current: string, next: string) {
  return new Date(next).getTime() > new Date(current).getTime();
}
