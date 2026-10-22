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

export type CaseOperation = CaseAction | 'take' | 'assign' | 'priority' | 'due' | 'treatment' | 'department';

export type BuildOperationInput = {
  operation: CaseOperation;
  updatedAt: string;
  assigneeId?: string;
  priority?: string;
  dueAt?: string;
  reason?: string;
  solution?: string;
  cause?: string;
  area?: string;
  corrective?: string;
  targetDepartment?: string;
  recordDepartment?: string | null;
  recordIdentifiedCause?: string | null;
  recordResponsibleArea?: string | null;
  recordCorrectiveAction?: string | null;
};

export type CaseOperationRequest = {
  path: string;
  method: 'POST' | 'PATCH';
  payload: Record<string, unknown>;
};

export function buildOperationRequest(recordId: string, input: BuildOperationInput): CaseOperationRequest {
  const { operation, updatedAt } = input;
  let path = `/sac-records/${recordId}/status`;
  let method: 'POST' | 'PATCH' = 'POST';
  let payload: Record<string, unknown> = { updatedAt };

  switch (operation) {
    case 'start':
      payload = {
        ...payload,
        status: 'IN_PROGRESS',
        assumeIfUnassigned: false,
      };
      break;

    case 'take-and-start':
      payload = {
        ...payload,
        status: 'IN_PROGRESS',
        assumeIfUnassigned: true,
      };
      break;

    case 'complete':
      payload = {
        ...payload,
        status: 'COMPLETED',
        solutionSummary: input.solution?.trim() || undefined,
        identifiedCause: input.cause?.trim() || (input.recordIdentifiedCause ?? undefined),
        responsibleArea: input.area?.trim() || (input.recordResponsibleArea ?? undefined),
        correctiveAction: input.corrective?.trim() || (input.recordCorrectiveAction ?? undefined),
      };
      break;

    case 'cancel':
      payload = {
        ...payload,
        status: 'CANCELLED',
        reason: input.reason?.trim() || undefined,
      };
      break;

    case 'reopen':
      payload = {
        ...payload,
        status: 'IN_PROGRESS',
        reason: input.reason?.trim() || undefined,
      };
      break;

    case 'reactivate':
      payload = {
        ...payload,
        status: 'PENDING',
        reason: input.reason?.trim() || undefined,
      };
      break;

    case 'assign':
      path = `/sac-records/${recordId}/assignee`;
      method = 'PATCH';
      payload = {
        ...payload,
        assigneeId: input.assigneeId || null,
        justification: input.reason?.trim() || undefined,
      };
      break;

    case 'take':
      path = `/sac-records/${recordId}/take`;
      method = 'POST';
      break;

    case 'priority':
      path = `/sac-records/${recordId}/priority`;
      method = 'PATCH';
      payload = {
        ...payload,
        priority: input.priority,
        justification: input.reason?.trim() || undefined,
      };
      break;

    case 'due':
      path = `/sac-records/${recordId}/due-date`;
      method = 'PATCH';
      payload = {
        ...payload,
        dueAt: input.dueAt ? new Date(`${input.dueAt}T23:59:59`).toISOString() : undefined,
        justification: input.reason?.trim() || undefined,
      };
      break;

    case 'treatment':
      path = `/sac-records/${recordId}/treatment`;
      method = 'PATCH';
      payload = {
        ...payload,
        solutionSummary: input.solution || null,
        identifiedCause: input.cause || null,
        responsibleArea: input.area || null,
        correctiveAction: input.corrective || null,
      };
      break;

    case 'department': {
      const trimmed = input.targetDepartment?.trim() || '';
      if (!trimmed) {
        throw new Error('Selecione um setor.');
      }
      if (input.recordDepartment && trimmed === input.recordDepartment) {
        throw new Error('O caso já pertence a este setor. Selecione um setor diferente.');
      }
      path = `/sac-records/${recordId}/department`;
      method = 'PATCH';
      payload = {
        department: trimmed,
        justification: input.reason?.trim() || undefined,
      };
      break;
    }

    default:
      throw new Error(`Operação não suportada: ${operation}`);
  }

  return { path, method, payload };
}
