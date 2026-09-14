export type CatalogTab = 'reasons' | 'subreasons' | 'channels';
export type CatalogStatus = 'all' | 'active' | 'inactive';

export type CatalogItem = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
  reasonId?: string;
  reason?: { id: string; name: string; active: boolean };
  _count?: { subreasons?: number; records?: number };
};

export type CatalogForm = { name: string; description: string; active: boolean; displayOrder: string; reasonId: string };

export const catalogConfig = {
  reasons: { label: 'Motivos', singular: 'motivo', endpoint: '/catalog/reasons', description: 'Classificações principais utilizadas nas ocorrências.', emptyTitle: 'Nenhum motivo cadastrado', emptyText: 'Cadastre os motivos utilizados para classificar as ocorrências.', emptyAction: 'Cadastrar motivo' },
  subreasons: { label: 'Submotivos', singular: 'submotivo', endpoint: '/catalog/subreasons', description: 'Detalhamentos vinculados aos motivos principais.', emptyTitle: 'Nenhum submotivo cadastrado', emptyText: 'Crie detalhamentos vinculados aos motivos principais.', emptyAction: 'Cadastrar submotivo' },
  channels: { label: 'Canais', singular: 'canal', endpoint: '/catalog/channels', description: 'Canais pelos quais os casos são recebidos.', emptyTitle: 'Nenhum canal cadastrado', emptyText: 'Cadastre os canais pelos quais os casos são recebidos.', emptyAction: 'Cadastrar canal' },
} as const;

export function catalogListPath(tab: CatalogTab, query: string, status: CatalogStatus, page: number, pageSize: number, reasonId = '') {
  const params = new URLSearchParams({ status, page: String(page), pageSize: String(pageSize) });
  if (query.trim()) params.set('query', query.trim());
  if (tab === 'subreasons' && reasonId) params.set('reasonId', reasonId);
  return `${catalogConfig[tab].endpoint}?${params}`;
}

export function validateCatalogForm(tab: CatalogTab, form: CatalogForm) {
  const errors: Partial<Record<keyof CatalogForm, string>> = {};
  const normalizedName = form.name.trim().replace(/\s+/g, ' ');
  if (normalizedName.length < 2) errors.name = 'Informe um nome com pelo menos 2 caracteres.';
  else if (normalizedName.length > 120) errors.name = 'Use no máximo 120 caracteres.';
  if (form.description.trim().length > 500) errors.description = 'Use no máximo 500 caracteres.';
  if (!/^\d+$/.test(form.displayOrder) || Number(form.displayOrder) > 9999) errors.displayOrder = 'Informe um número entre 0 e 9999.';
  if (tab === 'subreasons' && !form.reasonId) errors.reasonId = 'Selecione o motivo principal.';
  return errors;
}

export function isCatalogFormDirty(form: CatalogForm, initial: CatalogForm) {
  return JSON.stringify(form) !== JSON.stringify(initial);
}

