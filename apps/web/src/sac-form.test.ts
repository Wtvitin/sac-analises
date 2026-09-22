import { describe, expect, it } from 'vitest';
import {
  createEmptySacForm, hasUnsavedSacChanges, sacFormPayload, validateAttachments, validateSacForm,
  type SacFormValues,
} from './sac-form';

function validForm(): SacFormValues {
  return {
    ...createEmptySacForm(), customerName: 'Cliente Alfa', orderNumber: 'PED-123', channelId: 'channel-1',
    openedAt: '2026-09-14T09:30', reasonId: 'reason-1', priority: 'HIGH',
    description: 'Produto recebido com avaria visível.', dueDate: '2026-09-16',
    items: [{ key: 'local-key', code: 'SKU-1', description: 'Produto teste', batch: 'L1', quantity: '2.5', note: '' }],
  };
}

describe('SAC creation and editing form helpers', () => {
  it('validates required fields, dates and complete optional items', () => {
    expect(validateSacForm(validForm())).toEqual({});
    expect(validateSacForm({ ...validForm(), dueDate: '2026-09-13' })).toMatchObject({ dueDate: expect.any(String) });
    expect(validateSacForm({ ...validForm(), items: [{ ...validForm().items[0], quantity: '0' }] })).toMatchObject({ 'item-0': expect.any(String) });
    expect(validateSacForm(createEmptySacForm())).toMatchObject({ customerName: expect.any(String), orderNumber: expect.any(String), channelId: expect.any(String), reasonId: expect.any(String), priority: expect.any(String) });
  });

  it('builds the API payload without leaking local item keys and keeps edit concurrency data', () => {
    const payload = sacFormPayload(validForm(), true, '2026-09-14T12:00:00.000Z');
    expect(payload).toMatchObject({ customerName: 'Cliente Alfa', priority: 'HIGH', allowDuplicateExternalTicket: true, updatedAt: '2026-09-14T12:00:00.000Z' });
    expect(payload.items).toEqual([{ code: 'SKU-1', description: 'Produto teste', batch: 'L1', quantity: 2.5, note: '' }]);
    expect(new Date(payload.dueAt).getHours()).toBe(23);
  });

  it('enforces the total attachment limit across saved and newly selected evidence', () => {
    const pdf = { name: 'evidencia.pdf', size: 1024, type: 'application/pdf' } as File;
    const jpg = { name: 'foto.jpg', size: 2048, type: 'image/jpeg' } as File;
    const png = { name: 'print.png', size: 4096, type: 'image/png' } as File;

    expect(validateAttachments([pdf, jpg, png], 2)).toBe('');
    expect(validateAttachments([pdf], 4)).toBe('');
    expect(validateAttachments([pdf, pdf], 4)).toContain('no máximo 5');
    expect(validateAttachments([{ ...pdf, type: 'text/plain' }], 0)).toContain('formato não permitido');
    expect(validateAttachments([{ ...pdf, type: 'application/x-msdownload' }], 0)).toContain('formato não permitido');
    expect(validateAttachments([{ ...pdf, size: 0 }], 0)).toContain('deve possuir até 10 MB');
    expect(validateAttachments([{ ...pdf, size: 11 * 1024 * 1024 }], 0)).toContain('deve possuir até 10 MB');
  });

  it('detects changes in fields and newly selected files', () => {
    const initial = validForm();
    expect(hasUnsavedSacChanges(initial, initial, [])).toBe(false);
    expect(hasUnsavedSacChanges({ ...initial, description: `${initial.description} Ajuste.` }, initial, [])).toBe(true);
  });
});
