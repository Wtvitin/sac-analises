export type Status = 'Pendente' | 'Em andamento' | 'Concluído' | 'Cancelado';
export type AttentionReason = 'OVERDUE' | 'DUE_TODAY' | 'NEAR_DUE' | 'HIGH_PRIORITY' | 'UNASSIGNED' | 'STALE' | 'NO_DUE';
export type OperationalIndicators = {
  isOverdue: boolean; isDueToday: boolean; isNearDue: boolean; isStale: boolean; isUnassigned: boolean;
  attentionReasons: AttentionReason[]; dueState: 'WITHIN_DUE' | 'NEAR_DUE' | 'DUE_TODAY' | 'OVERDUE' | 'NO_DUE' | 'CLOSED';
  overdueDays: number; staleDays: number; openDays?: number | null; lastOperationalActivityAt: string;
};
export type RecordItem = {
  id?: string; ticket: string; department?: string | null; customer: string; order: string; occurrence: string; owner: string;
  status: Status; due: string; updated: string; openedAt: string; createdAt?: string; completedAt?: string | null;
  priority: 'Baixa' | 'Média' | 'Alta' | 'Crítica'; description: string;
  identifiedCause?: string; correctiveAction?: string; responsibleArea?: string;
  operational: OperationalIndicators;
  updatedAt?: string;
  items?: { code: string; description: string; batch: string; quantity: number }[];
  attachments?: { name: string; type: string; size: string }[];
};

// A aplicação começa limpa. Os dados devem vir da API autenticada.
export const records: RecordItem[] = [];
