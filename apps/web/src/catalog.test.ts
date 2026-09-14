import { describe, expect, it } from 'vitest';
import { catalogConfig, catalogListPath, isCatalogFormDirty, validateCatalogForm, type CatalogForm } from './catalog';

const valid: CatalogForm = { name: 'Entrega atrasada', description: '', active: true, displayOrder: '0', reasonId: 'reason-1' };

describe('catalog interface helpers', () => {
  it('builds server-side search, state, parent, ordering and pagination queries', () => {
    expect(catalogListPath('subreasons', ' atraso ', 'inactive', 3, 10, 'reason-1')).toBe('/catalog/subreasons?status=inactive&page=3&pageSize=10&query=atraso&reasonId=reason-1');
  });

  it('validates the responsive modal fields before API submission', () => {
    expect(validateCatalogForm('reasons', valid)).toEqual({});
    expect(validateCatalogForm('subreasons', { ...valid, reasonId: '' })).toMatchObject({ reasonId: 'Selecione o motivo principal.' });
    expect(validateCatalogForm('channels', { ...valid, name: ' ', displayOrder: '-1' })).toMatchObject({ name: expect.any(String), displayOrder: expect.any(String) });
  });

  it('detects unsaved changes for the discard confirmation', () => {
    expect(isCatalogFormDirty(valid, valid)).toBe(false);
    expect(isCatalogFormDirty({ ...valid, description: 'Alterado' }, valid)).toBe(true);
  });

  it('keeps the required empty-state copy without examples', () => {
    expect(catalogConfig.reasons.emptyTitle).toBe('Nenhum motivo cadastrado');
    expect(catalogConfig.subreasons.emptyText).toBe('Crie detalhamentos vinculados aos motivos principais.');
    expect(catalogConfig.channels.emptyText).toBe('Cadastre os canais pelos quais os casos são recebidos.');
  });
});
