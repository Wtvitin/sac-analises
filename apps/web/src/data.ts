export type Status = 'Pendente' | 'Em andamento' | 'Concluído' | 'Cancelado';
export type RecordItem = {
  id?: string; ticket: string; customer: string; order: string; occurrence: string; owner: string;
  status: Status; due: string; updated: string; openedAt: string;
  priority: 'Baixa' | 'Média' | 'Alta' | 'Crítica'; description: string;
  identifiedCause?: string; correctiveAction?: string; responsibleArea?: string;
  items?: { code: string; description: string; batch: string; quantity: number }[];
  attachments?: { name: string; type: string; size: string }[];
};

// A aplicação começa limpa. Os dados devem vir da API autenticada.
export const records: RecordItem[] = [];
