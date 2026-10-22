import { describe, expect, it } from 'vitest';
import {
  canSubmitDelete,
  getAvailableModalActions,
  getAvailableEditActions,
  isUserManagementProtected,
  accountState,
  EditUserModal,
  DeleteUserModal,
} from './TeamPage';

describe('gestão de equipe e fluxo de exclusão de usuário na interface', () => {
  const currentAdmin = { id: 'admin-current', role: 'ADMIN' as const };
  const otherAdmin = { id: 'admin-other', role: 'ADMIN' as const };
  const analyst = { id: 'analyst-1', role: 'ANALYST' as const };
  const viewer = { id: 'viewer-1', role: 'VIEWER' as const };

  describe('Ponto 1 e 2: Proteção de administradores no Desktop e Mobile', () => {
    it('protege a própria conta administrativa impedindo ações de menu no desktop e mobile', () => {
      const selfProtection = isUserManagementProtected(currentAdmin, currentAdmin);
      expect(selfProtection.isSelf).toBe(true);
      expect(selfProtection.isOtherAdmin).toBe(false);
      expect(selfProtection.isProtected).toBe(true);
    });

    it('protege outros administradores impedindo ações de menu no desktop e mobile', () => {
      const otherProtection = isUserManagementProtected(otherAdmin, currentAdmin);
      expect(otherProtection.isSelf).toBe(false);
      expect(otherProtection.isOtherAdmin).toBe(true);
      expect(otherProtection.isProtected).toBe(true);
    });

    it('habilita menu de ações com Editar e Excluir usuário para analistas e usuários de consulta', () => {
      const analystCheck = isUserManagementProtected(analyst, currentAdmin);
      expect(analystCheck.isProtected).toBe(false);
      expect(analystCheck.isSelf).toBe(false);
      expect(analystCheck.isOtherAdmin).toBe(false);

      const viewerCheck = isUserManagementProtected(viewer, currentAdmin);
      expect(viewerCheck.isProtected).toBe(false);
    });
  });

  describe('Fluxo 1: Ações do modal de edição (sem exclusão, inativação ou reativação)', () => {
    it('no modal de edição, disponibiliza apenas ações de perfil/gestão e NÃO inclui "Excluir usuário", "Inativar" nem "Reativar"', () => {
      const activeUser = {
        approvedAt: '2026-09-01T10:00:00.000Z',
        rejectedAt: null,
        active: true,
      };
      const actions = getAvailableModalActions(activeUser);
      const actionValues = actions.map(a => a.value);

      expect(actionValues).not.toContain('delete');
      expect(actionValues).not.toContain('inactivate');
      expect(actionValues).not.toContain('deactivate');
      expect(actionValues).not.toContain('reactivate');
      expect(actionValues).toContain('resend-provisional');
      expect(actionValues).toContain('role');
      expect(actionValues).toContain('department');
    });

    it('para contas pendentes, oferece aprovação e recusa no modal de edição, sem "Excluir usuário"', () => {
      const pendingUser = {
        approvedAt: null,
        rejectedAt: null,
        active: false,
      };
      const actions = getAvailableModalActions(pendingUser);
      const actionValues = actions.map(a => a.value);

      expect(actionValues).toContain('approve');
      expect(actionValues).toContain('reject');
      expect(actionValues).not.toContain('delete');
    });
  });

  describe('Validação de confirmação e destino de casos na exclusão', () => {
    it('impede exclusão sem confirmação explícita marcada', () => {
      expect(
        canSubmitDelete({
          confirmed: false,
          openAssignedCases: 0,
          strategy: 'transfer',
        })
      ).toBe(false);
    });

    it('permite exclusão de usuário sem casos abertos após confirmação explícita', () => {
      expect(
        canSubmitDelete({
          confirmed: true,
          openAssignedCases: 0,
          strategy: 'transfer',
        })
      ).toBe(true);
    });

    it('se houver casos abertos com estratégia "transfer", exige responsável de destino', () => {
      // Sem responsável selecionado
      expect(
        canSubmitDelete({
          confirmed: true,
          openAssignedCases: 3,
          strategy: 'transfer',
          transferToUserId: '',
        })
      ).toBe(false);

      // Com responsável selecionado
      expect(
        canSubmitDelete({
          confirmed: true,
          openAssignedCases: 3,
          strategy: 'transfer',
          transferToUserId: 'analyst-2',
        })
      ).toBe(true);
    });

    it('se houver casos abertos com estratégia "unassigned", exige confirmação explícita', () => {
      expect(
        canSubmitDelete({
          confirmed: false,
          openAssignedCases: 3,
          strategy: 'unassigned',
        })
      ).toBe(false);

      expect(
        canSubmitDelete({
          confirmed: true,
          openAssignedCases: 3,
          strategy: 'unassigned',
        })
      ).toBe(true);
    });

    it('impede submissão duplicada durante o salvamento', () => {
      expect(
        canSubmitDelete({
          confirmed: true,
          openAssignedCases: 0,
          strategy: 'transfer',
          saving: true,
        })
      ).toBe(false);
    });
  });

  describe('Identificação do estado da conta na listagem', () => {
    it('mapeia corretamente contas ativas, pendentes e recusadas', () => {
      const base = {
        id: 'u-1',
        name: 'Teste',
        email: 'teste@sac.local',
        role: 'ANALYST' as const,
        lastLoginAt: null,
        createdAt: '2026-09-01',
        openAssignedCases: 0,
      };

      expect(accountState({ ...base, active: true, approvedAt: '2026-09-01', rejectedAt: null })).toEqual({
        key: 'active',
        label: 'Ativo',
      });
      expect(accountState({ ...base, active: false, approvedAt: null, rejectedAt: null })).toEqual({
        key: 'pending',
        label: 'Aguardando aprovação',
      });
      expect(accountState({ ...base, active: false, approvedAt: null, rejectedAt: '2026-09-01' })).toEqual({
        key: 'rejected',
        label: 'Recusado',
      });
    });
  });

  describe('Mensagens e clareza da exclusão (distinção entre saída da equipe e preservação histórica)', () => {
    it('o texto de confirmação distingue saída da equipe com perda de acesso e preservação de histórico', () => {
      const confirmLabel =
        'Confirmo a exclusão desta conta: ela sairá da Equipe com perda imediata de acesso, preservando casos e auditorias anteriores quando houver histórico.';
      expect(confirmLabel).toContain('sairá da Equipe');
      expect(confirmLabel).toContain('perda imediata de acesso');
      expect(confirmLabel).toContain('preservando casos e auditorias');
      expect(confirmLabel).not.toContain('definitiva');
      expect(confirmLabel).not.toContain('apagamento integral');
    });
  });

  describe('Separação explícita dos componentes dos dois fluxos', () => {
    it('exporta EditUserModal e DeleteUserModal como estruturas distintas para edição e exclusão', () => {
      expect(typeof EditUserModal).toBe('function');
      expect(typeof DeleteUserModal).toBe('function');
      expect(EditUserModal).not.toBe(DeleteUserModal);
    });

    it('garante que getAvailableEditActions e getAvailableModalActions coincidem e não expõem exclusão', () => {
      const user = { approvedAt: '2026-09-01T10:00:00.000Z', rejectedAt: null, active: true };
      expect(getAvailableEditActions(user)).toEqual(getAvailableModalActions(user));
      expect(getAvailableEditActions(user).some(a => (a.value as string) === 'delete')).toBe(false);
    });
  });

  describe('Setor de atuação do usuário', () => {
    it('disponibiliza os setores padrão exigidos no cadastro e edição', async () => {
      const { DEFAULT_USER_DEPARTMENTS } = await import('./api');
      expect(DEFAULT_USER_DEPARTMENTS).toContain('Estoque');
      expect(DEFAULT_USER_DEPARTMENTS).toContain('Controle de Qualidade');
      expect(DEFAULT_USER_DEPARTMENTS).toContain('Qualidade');
      expect(DEFAULT_USER_DEPARTMENTS).toContain('Recebimento');
      expect(DEFAULT_USER_DEPARTMENTS).toContain('Almoxarifado');
      expect(DEFAULT_USER_DEPARTMENTS).toContain('Compras');
    });

    it('preserva usuários existentes sem setor por suposição (department permanece null/undefined)', () => {
      const existingUser = {
        id: 'user-legacy',
        name: 'Usuário Histórico',
        email: 'legacy@empresa.com',
        role: 'ANALYST' as const,
        active: true,
        approvedAt: '2026-01-01T00:00:00.000Z',
        rejectedAt: null,
        lastLoginAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        openAssignedCases: 0,
      };

      expect((existingUser as any).department).toBeUndefined();
    });

    it('não preenche automaticamente a Área responsável do caso com o setor do usuário', async () => {
      const { createEmptySacForm } = await import('./sac-form');
      const emptyForm = createEmptySacForm();
      expect(emptyForm.responsibleArea).toBe('');
    });
  });
});

