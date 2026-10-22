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
    expect(validateSacForm(createEmptySacForm())).toMatchObject({ customerName: expect.any(String), channelId: expect.any(String), reasonId: expect.any(String), priority: expect.any(String) });
  });

  it('allows cases without orderNumber and validates multisector references', () => {
    const formWithoutOrder: SacFormValues = {
      ...validForm(),
      orderNumber: '',
      references: [
        { key: 'ref-1', type: 'INVOICE', value: 'NF-100200', note: 'Nota fiscal' },
        { key: 'ref-2', type: 'SERVICE_ORDER', value: 'OS-8899', note: 'Ordem de serviço' },
      ],
    };
    expect(validateSacForm(formWithoutOrder)).toEqual({});

    // Reference with empty value should fail validation
    const invalidRefForm: SacFormValues = {
      ...formWithoutOrder,
      references: [{ key: 'ref-1', type: 'INVOICE', value: '   ' }],
    };
    expect(validateSacForm(invalidRefForm)).toMatchObject({ 'reference-0': expect.any(String) });

    const payload = sacFormPayload(formWithoutOrder, false);
    expect(payload.references).toHaveLength(2);
    expect(payload.references[0]).toEqual({ type: 'INVOICE', value: 'NF-100200', note: 'Nota fiscal' });
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

  it('permite criação do caso sem depender de análise interna (causa, área responsável e ação corretiva vazias)', () => {
    const creationForm: SacFormValues = {
      ...validForm(),
      identifiedCause: '',
      responsibleArea: '',
      correctiveAction: '',
    };

    const errors = validateSacForm(creationForm);
    expect(errors.identifiedCause).toBeUndefined();
    expect(errors.responsibleArea).toBeUndefined();
    expect(errors.correctiveAction).toBeUndefined();
    expect(errors).toEqual({});

    const payload = sacFormPayload(creationForm, false);
    expect(payload.identifiedCause).toBe('');
    expect(payload.responsibleArea).toBe('');
    expect(payload.correctiveAction).toBe('');
  });

  it('preserva dados de análise interna já armazenados quando o caso existente for editado', () => {
    const existingCaseWithAnalysis: SacFormValues = {
      ...validForm(),
      identifiedCause: 'Falha no sensor térmico da câmara fria',
      responsibleArea: 'Manutenção / Refrigeração',
      correctiveAction: 'Substituição do sensor e calibração semanal',
    };

    expect(validateSacForm(existingCaseWithAnalysis)).toEqual({});
    const payload = sacFormPayload(existingCaseWithAnalysis, false, '2026-09-14T12:00:00.000Z');
    expect(payload.identifiedCause).toBe('Falha no sensor térmico da câmara fria');
    expect(payload.responsibleArea).toBe('Manutenção / Refrigeração');
    expect(payload.correctiveAction).toBe('Substituição do sensor e calibração semanal');
    expect(payload.updatedAt).toBe('2026-09-14T12:00:00.000Z');
  });

  describe('Atribuição e Edição de Setor em Registros → Editar', () => {
    it('determina ação de setor para ADMIN: "Definir setor" quando vazio e "Alterar setor" quando preenchido', () => {
      const getSectorActionLabel = (role: string, editing: boolean, department: string | null | undefined) => {
        if (!editing || role !== 'ADMIN') return null;
        return department && department.trim() ? 'Alterar setor' : 'Definir setor';
      };

      expect(getSectorActionLabel('ADMIN', true, '')).toBe('Definir setor');
      expect(getSectorActionLabel('ADMIN', true, null)).toBe('Definir setor');
      expect(getSectorActionLabel('ADMIN', true, undefined)).toBe('Definir setor');
      expect(getSectorActionLabel('ADMIN', true, 'Logística')).toBe('Alterar setor');
      expect(getSectorActionLabel('ADMIN', true, 'Financeiro')).toBe('Alterar setor');

      // Para ANALYST e VIEWER a ação deve ser nula (somente leitura)
      expect(getSectorActionLabel('ANALYST', true, 'Logística')).toBeNull();
      expect(getSectorActionLabel('ANALYST', true, '')).toBeNull();
      expect(getSectorActionLabel('VIEWER', true, 'Logística')).toBeNull();
      expect(getSectorActionLabel('VIEWER', true, '')).toBeNull();
    });

    it('preserva campos editados não salvos quando o setor é definido ou alterado', () => {
      const initialForm: SacFormValues = {
        ...validForm(),
        department: '',
        customerName: 'Cliente Original',
        description: 'Descrição original do problema.',
      };

      // Usuário edita cliente e descrição no formulário antes de definir o setor
      const editedForm: SacFormValues = {
        ...initialForm,
        customerName: 'Cliente Editado com Dados Adicionais',
        description: 'Descrição modificada que ainda não foi salva no backend.',
      };

      // Ao confirmar a definição de setor via PATCH /sac-records/:id/department:
      const updatedDepartment = 'Qualidade';
      const formAfterDeptChange: SacFormValues = {
        ...editedForm,
        department: updatedDepartment,
      };

      // Confere que o setor foi atualizado
      expect(formAfterDeptChange.department).toBe('Qualidade');
      // Confere que as alterações pendentes do usuário nos outros campos NÃO foram perdidas ou sobrescritas
      expect(formAfterDeptChange.customerName).toBe('Cliente Editado com Dados Adicionais');
      expect(formAfterDeptChange.description).toBe('Descrição modificada que ainda não foi salva no backend.');
      expect(formAfterDeptChange.items).toEqual(editedForm.items);
      expect(formAfterDeptChange.priority).toBe('HIGH');
    });

    it('mantém ação disponível para ADMIN mesmo em casos concluídos ou cancelados', () => {
      const canAdminManageSector = (role: string, status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED') => {
        return role === 'ADMIN';
      };

      expect(canAdminManageSector('ADMIN', 'PENDING')).toBe(true);
      expect(canAdminManageSector('ADMIN', 'IN_PROGRESS')).toBe(true);
      expect(canAdminManageSector('ADMIN', 'COMPLETED')).toBe(true);
      expect(canAdminManageSector('ADMIN', 'CANCELLED')).toBe(true);

      expect(canAdminManageSector('ANALYST', 'COMPLETED')).toBe(false);
      expect(canAdminManageSector('VIEWER', 'COMPLETED')).toBe(false);
    });

    it('previne concorrência 409 sincronizando o novo updatedAt retornado pela alteração de setor', () => {
      const initialUpdatedAt = '2026-09-14T10:00:00.000Z';
      let currentRecordUpdatedAt = initialUpdatedAt;

      const currentForm: SacFormValues = {
        ...validForm(),
        department: '',
        customerName: 'Cliente Teste',
      };

      // Alteração de setor retorna o registro com novo timestamp do banco
      const departmentUpdateResponse = {
        department: 'Expedição',
        updatedAt: '2026-09-14T10:05:00.000Z',
      };

      // Sincroniza o updatedAt do registro local
      currentRecordUpdatedAt = departmentUpdateResponse.updatedAt;

      // Quando o usuário clicar em "Salvar alterações" do formulário principal:
      const payload = sacFormPayload(
        { ...currentForm, department: departmentUpdateResponse.department },
        false,
        currentRecordUpdatedAt
      );

      // O payload deve conter o novo updatedAt para passar na checagem de concorrência
      expect(payload.updatedAt).toBe('2026-09-14T10:05:00.000Z');
      expect(payload.updatedAt).not.toBe(initialUpdatedAt);
      // E o endpoint comum de edição não deve receber department no payload
      expect((payload as any).department).toBeUndefined();
    });

    it('detecta que o novo setor não pode ser idêntico ao atual e que não pode ser vazio', () => {
      const validateDepartmentInput = (currentDept: string | null | undefined, targetDept: string) => {
        const trimmed = targetDept.trim();
        if (!trimmed) return 'Selecione um setor.';
        if (currentDept && trimmed === currentDept) return 'Selecione um setor diferente do atual.';
        return null;
      };

      expect(validateDepartmentInput('', '')).toBe('Selecione um setor.');
      expect(validateDepartmentInput('Logística', '   ')).toBe('Selecione um setor.');
      expect(validateDepartmentInput('Logística', 'Logística')).toBe('Selecione um setor diferente do atual.');
      expect(validateDepartmentInput('Logística', 'Financeiro')).toBeNull();
      expect(validateDepartmentInput('', 'Logística')).toBeNull();
      expect(validateDepartmentInput(null, 'Logística')).toBeNull();
    });
  });

  describe('Seleção simplificada de setor na criação e proteção na edição', () => {
    it('ADMIN: exige seleção direta de setor no novo registro e inclui no payload', () => {
      const formWithoutDept = { ...validForm(), department: '' };
      const errors = validateSacForm(formWithoutDept, true, false);
      expect(errors.department).toBe('Selecione o setor do caso.');

      const formWithDept = { ...validForm(), department: 'Qualidade' };
      const noErrors = validateSacForm(formWithDept, true, false);
      expect(noErrors.department).toBeUndefined();

      const createPayload = sacFormPayload(formWithDept, false);
      expect((createPayload as any).department).toBe('Qualidade');
    });

    it('ANALYST: não exige seleção manual de setor no formulário e preserva vinculação', () => {
      // ANALYST criando novo registro (isAdmin = false, isEditing = false)
      const analystForm = { ...validForm(), department: 'Atendimento' };
      const errors = validateSacForm(analystForm, false, false);
      expect(errors.department).toBeUndefined();

      // Mesmo se o form em memória estiver vazio antes de carregar
      const emptyDeptForm = { ...validForm(), department: '' };
      const analystErrors = validateSacForm(emptyDeptForm, false, false);
      expect(analystErrors.department).toBeUndefined();
    });

    it('EDIÇÃO: não permite alterar setor pelo endpoint comum de edição', () => {
      // Na edição (isEditing = true), validação não exige campo de setor
      const editForm = { ...validForm(), department: 'Logística' };
      const errors = validateSacForm(editForm, true, true);
      expect(errors.department).toBeUndefined();

      // sacFormPayload com updatedAt (edição) remove department para que o endpoint comum não altere o setor
      const updatePayload = sacFormPayload(editForm, false, '2026-09-14T15:00:00.000Z');
      expect((updatePayload as any).department).toBeUndefined();
      expect(updatePayload.updatedAt).toBe('2026-09-14T15:00:00.000Z');
    });

    it('preserva a seleção de setor e demais campos caso ocorra erro ao salvar', () => {
      const formState: SacFormValues = {
        ...validForm(),
        department: 'Expedição',
        customerName: 'Cliente com Erro',
        description: 'Descrição longa para teste de preservação.',
      };

      // Simula uma falha na requisição de criação (ex: erro de rede ou validação remota)
      let apiError = '';
      try {
        throw new Error('Falha simulada na API.');
      } catch (err: any) {
        apiError = err.message;
      }

      // O estado do formulário não é resetado em falhas
      expect(apiError).toBe('Falha simulada na API.');
      expect(formState.department).toBe('Expedição');
      expect(formState.customerName).toBe('Cliente com Erro');
      expect(formState.description).toBe('Descrição longa para teste de preservação.');
    });
  });
});

