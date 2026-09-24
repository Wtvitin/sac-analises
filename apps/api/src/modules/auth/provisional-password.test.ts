import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  generateProvisionalPassword,
  hashPassword,
  isProvisionalPasswordExpired,
} from '../../lib/auth/provisional-password.js';
import { MemoryEmailAdapter, LocalPreviewEmailAdapter, GmailSmtpEmailAdapter } from '../../lib/email/email.adapter.js';
import { sendProvisionalPasswordEmail, isRealEmailDeliveryConfigured, setEmailAdapter } from '../../lib/email/email.service.js';

// Setup Mocks for Services
const mock = vi.hoisted(() => {
  const database = {
    user: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    adminAudit: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    authSession: {
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
    notification: {
      create: vi.fn(),
      createMany: vi.fn(),
    },
    activityLog: {
      create: vi.fn(),
    },
    sacRecord: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    $executeRaw: vi.fn(),
  };

  const transaction = vi.fn(async (input: unknown) => {
    if (typeof input === 'function') {
      return (input as (tx: typeof database) => unknown)(database);
    }
    return Promise.all(input as Promise<unknown>[]);
  });

  return { database, transaction };
});

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    ...mock.database,
    $transaction: mock.transaction,
  },
}));

vi.mock('./session.service.js', () => ({
  currentSession: vi.fn(),
  createSession: vi.fn(),
  revokeAllSessions: vi.fn(),
  revokeOtherSessions: vi.fn(),
  revokeRefreshSession: vi.fn(),
  rotateSession: vi.fn(),
}));

import { authenticate, changeOwnPassword, requestPasswordReset, resetPasswordWithToken, GENERIC_RESET_RESPONSE } from './auth.service.js';
import { approveUser, completeActivation, resendProvisionalPassword } from '../users/users.service.js';
import { requireAuth } from './auth.middleware.js';
import { currentSession } from './session.service.js';

describe('Fluxo de Primeiro Acesso por Senha Provisória', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret-provisional-flow';
    mock.database.authSession.updateMany.mockResolvedValue({ count: 0 });
    mock.database.adminAudit.create.mockResolvedValue({ id: 'audit-id' });
  });

  describe('1. Gerador e Utilitários de Senha Provisória', () => {
    it('gera senha aleatória forte com pelo menos 14 caracteres contendo maiúsculas, minúsculas, números e símbolos', () => {
      const pwd1 = generateProvisionalPassword();
      const pwd2 = generateProvisionalPassword();

      expect(pwd1.length).toBeGreaterThanOrEqual(14);
      expect(pwd2.length).toBeGreaterThanOrEqual(14);
      expect(pwd1).not.toBe(pwd2); // Aleatoriedade

      // Complexidade obrigatória
      expect(pwd1).toMatch(/[A-Z]/);
      expect(pwd1).toMatch(/[a-z]/);
      expect(pwd1).toMatch(/[0-9]/);
      expect(pwd1).toMatch(/[!@#$%&*]/);
    });

    it('faz hash com bcrypt corretamente', async () => {
      const pwd = generateProvisionalPassword();
      const hash = await hashPassword(pwd);

      expect(hash).not.toBe(pwd);
      expect(hash.startsWith('$2')).toBe(true);
      const isMatch = await bcrypt.compare(pwd, hash);
      expect(isMatch).toBe(true);
    });

    it('identifica corretamente expiração temporal da senha provisória', () => {
      const past = new Date(Date.now() - 60 * 1000); // 1 minuto atrás
      const future = new Date(Date.now() + 48 * 3600 * 1000); // 48 horas à frente

      expect(isProvisionalPasswordExpired(past)).toBe(true);
      expect(isProvisionalPasswordExpired(future)).toBe(false);
      expect(isProvisionalPasswordExpired(null)).toBe(false);
      expect(isProvisionalPasswordExpired(undefined)).toBe(false);
    });
  });

  describe('2. Adaptador de E-mail Testável e Prévia Local', () => {
    it('MemoryEmailAdapter captura e-mail enviado sem vazamento', async () => {
      const adapter = new MemoryEmailAdapter();
      const expiresAt = new Date(Date.now() + 48 * 3600 * 1000);

      const result = await sendProvisionalPasswordEmail(
        {
          to: 'usuario.teste@empresa.com',
          name: 'Usuário Teste',
          provisionalPassword: 'TempPassword123!',
          expiresAt,
        },
        adapter
      );

      expect(result.success).toBe(true);
      expect(result.delivered).toBe(true);
      expect(adapter.getSentEmails().length).toBe(1);

      const sent = adapter.getLastEmail()!;
      expect(sent.to).toBe('usuario.teste@empresa.com');
      expect(sent.text).toContain('TempPassword123!');
      expect(sent.text).toContain('válida até');
      expect(sent.html).toContain('TempPassword123!');
    });

    it('LocalPreviewEmailAdapter define delivered como false para não alegar entrega real não configurada', async () => {
      const previewAdapter = new LocalPreviewEmailAdapter();
      const expiresAt = new Date(Date.now() + 48 * 3600 * 1000);

      const result = await sendProvisionalPasswordEmail(
        {
          to: 'usuario.preview@empresa.com',
          name: 'Usuário Prévia',
          provisionalPassword: 'TempPreview123!',
          expiresAt,
        },
        previewAdapter
      );

      expect(result.success).toBe(true);
      expect(result.delivered).toBe(false); // Explicitamente false conforme requisito!
      expect(result.adapter).toBe('local-preview');
      expect(result.previewSummary?.to).toBe('usuario.preview@empresa.com');
    });

    it('MemoryEmailAdapter simula falha no envio sem quebrar a execução', async () => {
      const adapter = new MemoryEmailAdapter();
      adapter.setSimulateFailure(true, 'SMTP timeout test error');

      const result = await sendProvisionalPasswordEmail(
        {
          to: 'falha@empresa.com',
          name: 'Usuário Falha',
          provisionalPassword: 'TempPassword123!',
          expiresAt: new Date(),
        },
        adapter
      );

      expect(result.success).toBe(false);
      expect(result.delivered).toBe(false);
      expect(result.error).toBe('SMTP timeout test error');
    });

    it('GmailSmtpEmailAdapter envia e-mail com sucesso usando transporter', async () => {
      const mockTransporter = {
        sendMail: vi.fn().mockResolvedValue({ messageId: 'gmail-msg-12345' }),
        verify: vi.fn().mockResolvedValue(true),
      };

      const adapter = new GmailSmtpEmailAdapter(
        { user: 'sac@empresa.com', pass: 'secretpass1234' },
        mockTransporter as never
      );

      const result = await adapter.send({
        to: 'destinatario@empresa.com',
        subject: 'Teste Gmail SMTP',
        text: 'Conteúdo de teste',
      });

      expect(result.success).toBe(true);
      expect(result.delivered).toBe(true);
      expect(result.adapter).toBe('smtp');
      expect(result.messageId).toBe('gmail-msg-12345');
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'sac@empresa.com',
          to: 'destinatario@empresa.com',
          subject: 'Teste Gmail SMTP',
        })
      );
    });

    it('GmailSmtpEmailAdapter trata falha de envio sem expor senhas', async () => {
      const mockTransporter = {
        sendMail: vi.fn().mockRejectedValue(new Error('Invalid credentials at smtp://user:supersecretpass@smtp.gmail.com')),
        verify: vi.fn().mockRejectedValue(new Error('Auth failed')),
      };

      const adapter = new GmailSmtpEmailAdapter(
        { user: 'sac@empresa.com', pass: 'supersecretpass' },
        mockTransporter as never
      );

      const result = await adapter.send({
        to: 'destinatario@empresa.com',
        subject: 'Teste Falha',
        text: 'Falha',
      });

      expect(result.success).toBe(false);
      expect(result.delivered).toBe(false);
      expect(result.adapter).toBe('smtp');
      expect(result.error).not.toContain('supersecretpass');
      expect(result.error).toContain('***@');
    });

    it('reconhece se entrega real está configurada baseado em SMTP_USER e SMTP_PASS', () => {
      const oldUser = process.env.SMTP_USER;
      const oldPass = process.env.SMTP_PASS;

      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;
      expect(isRealEmailDeliveryConfigured()).toBe(false);

      process.env.SMTP_USER = 'sac@gmail.com';
      delete process.env.SMTP_PASS;
      expect(isRealEmailDeliveryConfigured()).toBe(false);

      process.env.SMTP_PASS = '16-char-app-pass';
      expect(isRealEmailDeliveryConfigured()).toBe(true);

      if (oldUser) process.env.SMTP_USER = oldUser; else delete process.env.SMTP_USER;
      if (oldPass) process.env.SMTP_PASS = oldPass; else delete process.env.SMTP_PASS;
    });
  });

  describe('3. Bloqueio de Login Antes da Aprovação', () => {
    it('impede login de usuário registrado que ainda não foi aprovado pelo administrador', async () => {
      mock.database.user.findUnique.mockResolvedValueOnce({
        id: 'user-pending',
        email: 'pendente@empresa.com',
        name: 'Pendente',
        active: false,
        approvedAt: null,
        rejectedAt: null,
        passwordHash: await bcrypt.hash('Senha12345678', 10),
      });

      await expect(
        authenticate({ email: 'pendente@empresa.com', password: 'Senha12345678' })
      ).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });

      expect(mock.database.user.update).not.toHaveBeenCalled();
    });
  });

  describe('4. Aprovação por Administrador, Envio Real e Modo de Prévia', () => {
    it('com envio real bem-sucedido: ativa usuário, define validade limitada e envia e-mail sem expor senha em texto puro', async () => {
      const pendingUser = {
        id: 'user-to-approve',
        name: 'Novo Colaborador',
        email: 'novo@empresa.com',
        role: 'ANALYST',
        active: false,
        approvedAt: null,
        rejectedAt: null,
        createdAt: new Date(),
        lastLoginAt: null,
      };

      mock.database.user.findUnique.mockResolvedValueOnce(pendingUser);
      mock.database.user.update.mockResolvedValueOnce({
        ...pendingUser,
        active: true,
        approvedAt: new Date(),
      });
      mock.database.authSession.updateMany.mockResolvedValueOnce({ count: 0 });
      mock.database.adminAudit.create.mockResolvedValue({ id: 'audit-1' });

      const result = await approveUser('user-to-approve', 'ANALYST', 'admin-id');

      // Verifica que o usuário foi ativado com hash de senha e expiração
      expect(mock.database.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-to-approve' },
          data: expect.objectContaining({
            active: true,
            role: 'ANALYST',
            mustChangePassword: true,
            provisionalPasswordExpiresAt: expect.any(Date),
            tokenVersion: { increment: 1 },
          }),
        })
      );

      const updateData = mock.database.user.update.mock.calls[0][0].data;
      expect(updateData.passwordHash).toMatch(/^\$2/);
      expect(updateData.provisionalPasswordHash).toMatch(/^\$2/);

      // Auditorias geradas
      expect(mock.database.adminAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'ACCESS_APPROVED',
            actorId: 'admin-id',
            targetUserId: 'user-to-approve',
          }),
        })
      );

      expect(result.emailDelivery.delivered).toBe(true);
      expect(result.emailDelivery.statusMessage).toBe('Envio aceito pelo servidor de e-mail; conta ativada');

      // Nenhuma senha em texto puro em logs, retornos da API ou auditoria
      const auditCalls = mock.database.adminAudit.create.mock.calls;
      for (const call of auditCalls) {
        expect(JSON.stringify(call)).not.toMatch(/provisionalPassword|passwordHash/i);
      }
      expect((result as Record<string, unknown>).provisionalPassword).toBeUndefined();
    });

    it('em modo de prévia: a aprovação NÃO deixa o usuário ativo com senha que ele não recebeu, exibe "E-mail não enviado" e a ativação manual é desabilitada', async () => {
      const pendingUser = {
        id: 'user-preview-1',
        name: 'Usuário Prévia',
        email: 'preview1@empresa.com',
        role: 'ANALYST',
        active: false,
        approvedAt: null,
        rejectedAt: null,
        createdAt: new Date(),
        lastLoginAt: null,
      };

      const previewAdapter = new LocalPreviewEmailAdapter();
      setEmailAdapter(previewAdapter);

      mock.database.user.findUnique.mockResolvedValueOnce(pendingUser);
      mock.database.user.update.mockResolvedValueOnce({
        ...pendingUser,
        active: false,
        approvedAt: null,
        mustChangePassword: true,
      });

      const result = await approveUser('user-preview-1', 'ANALYST', 'admin-id');

      // CRUCIAL: NÃO deixa o usuário ativo no banco com uma senha que ele não recebeu!
      expect(mock.database.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-preview-1' },
          data: expect.objectContaining({
            active: false, // Permanece inativo!
            approvedAt: null,
            mustChangePassword: true,
          }),
        })
      );

      // Mostra claramente ao administrador "E-mail não enviado; conta inativa" e não expõe a senha
      expect(result.active).toBe(false);
      expect(result.approvedAt).toBe(null);
      expect(result.emailDelivery.delivered).toBe(false);
      expect(result.emailDelivery.statusMessage).toBe('E-mail não enviado; conta inativa');
      expect((result as Record<string, unknown>).previewPassword).toBeUndefined();
      expect((result.emailDelivery as Record<string, unknown>).previewPassword).toBeUndefined();

      // Login do usuário DEVE ser rejeitado antes da ativação
      mock.database.user.findUnique.mockResolvedValueOnce({
        ...pendingUser,
        active: false, // inativo!
        approvedAt: null,
        passwordHash: await bcrypt.hash('SenhaProvisoria123!', 10),
      });

      await expect(
        authenticate({
          email: 'preview1@empresa.com',
          password: 'SenhaProvisoria123!',
        })
      ).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });

      // A ativação manual está explicitamente desabilitada:
      await expect(
        completeActivation('user-preview-1', 'admin-id')
      ).rejects.toMatchObject({
        code: 'MANUAL_ACTIVATION_DISABLED',
        status: 400,
      });

      // Restaura adapter de teste
      setEmailAdapter(new MemoryEmailAdapter());
    });

    it('se o envio real falhar: não informa sucesso, lança erro genérico sem expor SMTP e mantém usuário pendente com acesso recuperável', async () => {
      const pendingUser = {
        id: 'user-fail-delivery',
        name: 'Usuário Falha SMTP',
        email: 'falha-smtp@empresa.com',
        role: 'ANALYST',
        active: false,
        approvedAt: null,
        rejectedAt: null,
        createdAt: new Date(),
        lastLoginAt: null,
      };

      const failingAdapter = new MemoryEmailAdapter();
      failingAdapter.setSimulateFailure(true, 'Conexão recusada pela porta 587 (SMTP timeout)');
      setEmailAdapter(failingAdapter);

      mock.database.user.findUnique.mockResolvedValueOnce(pendingUser);

      // Deve rejeitar a operação, NÃO informar sucesso e retornar erro 502 genérico
      await expect(
        approveUser('user-fail-delivery', 'ANALYST', 'admin-id')
      ).rejects.toMatchObject({
        code: 'EMAIL_DELIVERY_FAILED',
        status: 502,
        message: 'Não foi possível enviar o e-mail com a senha provisória. A solicitação permanece pendente e pode ser tentada novamente.',
      });

      // O usuário NÃO foi ativado
      expect(mock.database.user.update).not.toHaveBeenCalled();

      // Auditoria registrou a falha de forma sanitizada (sem expor detalhes internos do SMTP)
      expect(mock.database.adminAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              emailSuccess: false,
              emailDelivered: false,
              error: 'Falha no envio de e-mail',
            }),
          }),
        })
      );

      // O usuário continua recuperável na lista de solicitações pendentes
      // Administrador pode repetir a ativação
      failingAdapter.setSimulateFailure(false);
      mock.database.user.findUnique.mockResolvedValueOnce(pendingUser);
      mock.database.user.update.mockResolvedValueOnce({
        ...pendingUser,
        active: true,
        approvedAt: new Date(),
      });

      const retryResult = await approveUser('user-fail-delivery', 'ANALYST', 'admin-id');
      expect(retryResult.emailDelivery.delivered).toBe(true);
      expect(retryResult.emailDelivery.statusMessage).toBe('Envio aceito pelo servidor de e-mail; conta ativada');

      // Restaura adapter
      setEmailAdapter(new MemoryEmailAdapter());
    });
  });

  describe('5. Primeiro Login com Senha Provisória e Retorno de mustChangePassword', () => {
    it('permite login com senha provisória válida e sinaliza obrigatoriedade de troca de senha', async () => {
      const provisionalPlain = 'Temp@Secret123!';
      const provisionalHash = await bcrypt.hash(provisionalPlain, 10);
      const validUntil = new Date(Date.now() + 24 * 3600 * 1000); // 24h restantes

      const approvedUser = {
        id: 'user-provisional',
        name: 'Primeiro Acesso',
        email: 'primeiro@empresa.com',
        role: 'ANALYST',
        active: true,
        approvedAt: new Date(),
        rejectedAt: null,
        passwordHash: provisionalHash,
        mustChangePassword: true,
        provisionalPasswordHash: provisionalHash,
        provisionalPasswordCreatedAt: new Date(),
        provisionalPasswordExpiresAt: validUntil,
        lastLoginAt: null,
        createdAt: new Date(),
      };

      mock.database.user.findUnique.mockResolvedValueOnce(approvedUser);
      mock.database.user.update.mockResolvedValueOnce(approvedUser);

      const authResult = await authenticate({
        email: 'primeiro@empresa.com',
        password: provisionalPlain,
      });

      expect(authResult.publicUser.mustChangePassword).toBe(true);
      expect(mock.database.user.update).toHaveBeenCalledWith({
        where: { id: 'user-provisional' },
        data: { lastLoginAt: expect.any(Date) },
      });
    });
  });

  describe('6. Bloqueio de Rotas Operacionais Antes da Definição da Nova Senha', () => {
    const runMiddleware = async (url: string, mustChangePassword: boolean) => {
      const token = jwt.sign(
        { version: 1, sessionId: 'session-provisional' },
        process.env.JWT_SECRET!,
        { subject: 'user-prov-1' }
      );

      (currentSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'session-provisional',
        tokenVersion: 1,
        user: {
          id: 'user-prov-1',
          role: 'ANALYST',
          active: true,
          approvedAt: new Date(),
          rejectedAt: null,
          tokenVersion: 1,
          mustChangePassword,
        },
      });

      const req = {
        headers: { cookie: `sac_access=${token}` },
        baseUrl: '',
        path: url,
        originalUrl: url,
        url,
      } as never;

      const status = vi.fn().mockReturnThis();
      const json = vi.fn();
      const next = vi.fn();

      await requireAuth(req, { status, json } as never, next);
      return { status, json, next };
    };

    it('bloqueia rotas operacionais (/sac-records, /users, /analytics) com 403 PASSWORD_CHANGE_REQUIRED se mustChangePassword for true', async () => {
      const casesResult = await runMiddleware('/api/sac-records', true);
      expect(casesResult.status).toHaveBeenCalledWith(403);
      expect(casesResult.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'PASSWORD_CHANGE_REQUIRED',
          }),
        })
      );
      expect(casesResult.next).not.toHaveBeenCalled();

      const usersResult = await runMiddleware('/api/users', true);
      expect(usersResult.status).toHaveBeenCalledWith(403);
      expect(usersResult.next).not.toHaveBeenCalled();

      const analyticsResult = await runMiddleware('/api/analytics/overview', true);
      expect(analyticsResult.status).toHaveBeenCalledWith(403);
      expect(analyticsResult.next).not.toHaveBeenCalled();
    });

    it('permite rotas de sessão, perfil e troca de senha mesmo com mustChangePassword = true', async () => {
      const changePwdResult = await runMiddleware('/api/auth/change-password', true);
      expect(changePwdResult.next).toHaveBeenCalled();
      expect(changePwdResult.status).not.toHaveBeenCalled();

      const sessionResult = await runMiddleware('/api/auth/session', true);
      expect(sessionResult.next).toHaveBeenCalled();
      expect(sessionResult.status).not.toHaveBeenCalled();

      const logoutResult = await runMiddleware('/api/auth/logout', true);
      expect(logoutResult.next).toHaveBeenCalled();
      expect(logoutResult.status).not.toHaveBeenCalled();
    });

    it('permite todas as rotas normalmente após a senha definitiva ser definida (mustChangePassword = false)', async () => {
      const casesResult = await runMiddleware('/api/sac-records', false);
      expect(casesResult.next).toHaveBeenCalled();
      expect(casesResult.status).not.toHaveBeenCalled();
    });
  });

  describe('7. Expiração da Senha Provisória', () => {
    it('bloqueia login se a senha provisória estiver expirada, com código PROVISIONAL_PASSWORD_EXPIRED', async () => {
      const expiredDate = new Date(Date.now() - 10 * 1000); // expirada 10 segundos atrás
      const provisionalPlain = 'Temp@Expired123!';
      const provisionalHash = await bcrypt.hash(provisionalPlain, 10);

      const expiredUser = {
        id: 'user-expired',
        name: 'Usuário Expirado',
        email: 'expirado@empresa.com',
        role: 'ANALYST',
        active: true,
        approvedAt: new Date(),
        rejectedAt: null,
        passwordHash: provisionalHash,
        mustChangePassword: true,
        provisionalPasswordHash: provisionalHash,
        provisionalPasswordCreatedAt: new Date(Date.now() - 49 * 3600 * 1000),
        provisionalPasswordExpiresAt: expiredDate,
        lastLoginAt: null,
      };

      mock.database.user.findUnique.mockResolvedValueOnce(expiredUser);

      await expect(
        authenticate({
          email: 'expirado@empresa.com',
          password: provisionalPlain,
        })
      ).rejects.toMatchObject({
        code: 'PROVISIONAL_PASSWORD_EXPIRED',
        status: 401,
      });

      // Não registra login
      expect(mock.database.user.update).not.toHaveBeenCalled();
    });
  });

  describe('8. Reenvio da Senha Provisória pelo Administrador', () => {
    it('gera nova senha aleatória diferente, renova expiração, revoga sessões e audita PROVISIONAL_PASSWORD_RESENT', async () => {
      const currentUser = {
        id: 'user-resend',
        name: 'Usuário Para Reenvio',
        email: 'reenvio@empresa.com',
        role: 'ANALYST',
        active: true,
        approvedAt: new Date(),
        approvedById: 'admin-original',
        rejectedAt: null,
        mustChangePassword: true,
        lastLoginAt: null,
        createdAt: new Date(),
      };

      mock.database.user.findUnique.mockResolvedValueOnce(currentUser);
      mock.database.user.update.mockResolvedValueOnce({
        ...currentUser,
        mustChangePassword: true,
      });
      mock.database.authSession.updateMany.mockResolvedValueOnce({ count: 2 }); // revoga 2 sessões antigas
      mock.database.adminAudit.create.mockResolvedValueOnce({ id: 'audit-resend' });

      const result = await resendProvisionalPassword('user-resend', 'admin-actor-id');

      // Verifica chamada transacional com hash renovado
      expect(mock.database.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-resend' },
          data: expect.objectContaining({
            mustChangePassword: true,
            tokenVersion: { increment: 1 },
            provisionalPasswordExpiresAt: expect.any(Date),
          }),
        })
      );

      // Sessões anteriores devem ter sido revogadas
      expect(mock.database.authSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-resend', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });

      // Auditoria registrada
      expect(mock.database.adminAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'PROVISIONAL_PASSWORD_RESENT',
            actorId: 'admin-actor-id',
            targetUserId: 'user-resend',
          }),
        })
      );

      // Sem senha exposta
      expect((result as Record<string, unknown>).provisionalPassword).toBeUndefined();
      expect((result as Record<string, unknown>).passwordHash).toBeUndefined();
    });

    it('rejeita reenvio para usuário inativo ou não aprovado', async () => {
      mock.database.user.findUnique.mockResolvedValueOnce({
        id: 'user-unapproved',
        active: false,
        approvedAt: null,
        rejectedAt: null,
      });

      await expect(
        resendProvisionalPassword('user-unapproved', 'admin-id')
      ).rejects.toMatchObject({
        code: 'USER_NOT_APPROVED',
      });

      mock.database.user.findUnique.mockResolvedValueOnce({
        id: 'user-inactive',
        active: false,
        approvedAt: new Date(),
        rejectedAt: null,
      });

      await expect(
        resendProvisionalPassword('user-inactive', 'admin-id')
      ).rejects.toMatchObject({
        code: 'USER_INACTIVE',
      });
    });
  });

  describe('9. Troca de Senha Obrigatória no Primeiro Acesso', () => {
    it('define nova senha definitiva, desmarca mustChangePassword, limpa dados provisórios e revoga sessões', async () => {
      const provisionalPlain = 'TempOld123456!';
      const currentProvisionalHash = await bcrypt.hash(provisionalPlain, 10);

      mock.database.user.findUniqueOrThrow.mockResolvedValueOnce({
        passwordHash: currentProvisionalHash,
      });
      mock.database.user.update.mockResolvedValueOnce({ id: 'user-first-access' });
      mock.database.authSession.updateMany.mockResolvedValueOnce({ count: 1 });
      mock.database.adminAudit.create.mockResolvedValueOnce({ id: 'audit-pwd-change' });

      await changeOwnPassword('user-first-access', {
        currentPassword: provisionalPlain,
        newPassword: 'MinhaNovaSenhaDefinitiva2026!',
        confirmPassword: 'MinhaNovaSenhaDefinitiva2026!',
      });

      expect(mock.database.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-first-access' },
          data: expect.objectContaining({
            mustChangePassword: false,
            provisionalPasswordHash: null,
            provisionalPasswordCreatedAt: null,
            provisionalPasswordExpiresAt: null,
            tokenVersion: { increment: 1 },
          }),
        })
      );

      // Sessões anteriores invalidadas
      expect(mock.database.authSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-first-access', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });

      // Auditoria registrada sem dados sensíveis
      expect(mock.database.adminAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'PASSWORD_CHANGED',
            actorId: 'user-first-access',
            targetUserId: 'user-first-access',
          }),
        })
      );
    });
  });

  describe('10. Tentativa de Reutilização da Senha Provisória', () => {
    it('rejeita qualquer tentativa de login com a senha provisória após a definição da nova senha permanente', async () => {
      const provisionalPlain = 'TempOld123456!';
      const newDefinitivePlain = 'MinhaNovaSenhaDefinitiva2026!';
      const newDefinitiveHash = await bcrypt.hash(newDefinitivePlain, 10);

      const userAfterPasswordChange = {
        id: 'user-first-access',
        name: 'Usuário Ativo',
        email: 'colaborador@empresa.com',
        role: 'ANALYST',
        active: true,
        approvedAt: new Date(),
        rejectedAt: null,
        passwordHash: newDefinitiveHash, // Hash agora é da senha definitiva
        mustChangePassword: false,
        provisionalPasswordHash: null, // Hash provisório foi apagado
        provisionalPasswordCreatedAt: null,
        provisionalPasswordExpiresAt: null,
        lastLoginAt: new Date(),
      };

      // Tentativa de reutilizar a senha provisória anterior
      mock.database.user.findUnique.mockResolvedValueOnce(userAfterPasswordChange);

      await expect(
        authenticate({
          email: 'colaborador@empresa.com',
          password: provisionalPlain, // Senha provisória antiga
        })
      ).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });

      // Login com a nova senha definitiva tem sucesso
      mock.database.user.findUnique.mockResolvedValueOnce(userAfterPasswordChange);
      mock.database.user.update.mockResolvedValueOnce(userAfterPasswordChange);

      const successLogin = await authenticate({
        email: 'colaborador@empresa.com',
        password: newDefinitivePlain,
      });

      expect(successLogin.publicUser.mustChangePassword).toBe(false);
    });
  });

  describe('11. Tratamento de Falha no Envio de E-mail e Recuperabilidade', () => {
    it('se o envio falhar no reenvio de senha provisória, não altera a senha anterior e lança EMAIL_DELIVERY_FAILED', async () => {
      const activeUser = {
        id: 'user-active-resend-fail',
        name: 'Usuário Ativo',
        email: 'ativo@empresa.com',
        role: 'ANALYST',
        active: true,
        approvedAt: new Date(),
        rejectedAt: null,
        passwordHash: 'hash-original-preservado',
      };

      const failingAdapter = new MemoryEmailAdapter();
      failingAdapter.setSimulateFailure(true, 'Conexão SMTP recusada');
      setEmailAdapter(failingAdapter);

      mock.database.user.findUnique.mockResolvedValueOnce(activeUser);

      await expect(
        resendProvisionalPassword('user-active-resend-fail', 'admin-id')
      ).rejects.toMatchObject({
        code: 'EMAIL_DELIVERY_FAILED',
        status: 502,
        message: 'Não foi possível reenviar o e-mail com a senha provisória. As credenciais anteriores foram preservadas.',
      });

      // Usuário não teve senha alterada nem sessões revogadas
      expect(mock.database.user.update).not.toHaveBeenCalled();
      expect(mock.database.authSession.updateMany).not.toHaveBeenCalled();

      // Auditoria registra tentativa com falha
      expect(mock.database.adminAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'PROVISIONAL_PASSWORD_RESENT',
            targetUserId: 'user-active-resend-fail',
            metadata: expect.objectContaining({
              emailSuccess: false,
              emailDelivered: false,
            }),
          }),
        })
      );

      // Restaura adapter
      setEmailAdapter(new MemoryEmailAdapter());
    });
  });

  describe('12. Recuperação de Senha por Link Temporário de Uso Único (Esqueci Minha Senha)', () => {
    it('retorna resposta genérica para e-mail inexistente sem vazar existência de contas', async () => {
      mock.database.user.findUnique.mockResolvedValueOnce(null);

      const res = await requestPasswordReset({ email: 'inexistente@empresa.com' });
      expect(res).toEqual(GENERIC_RESET_RESPONSE);
      expect(mock.database.user.update).not.toHaveBeenCalled();
    });

    it('retorna resposta genérica para conta inativa ou pendente de aprovação', async () => {
      mock.database.user.findUnique.mockResolvedValueOnce({
        id: 'user-inactive',
        email: 'inativo@empresa.com',
        active: false,
        approvedAt: null,
      });

      const res = await requestPasswordReset({ email: 'inativo@empresa.com' });
      expect(res).toEqual(GENERIC_RESET_RESPONSE);
      expect(mock.database.user.update).not.toHaveBeenCalled();
    });

    it('gera token seguro, salva hash no banco, envia link temporário por e-mail e audita solicitação', async () => {
      const memoryAdapter = new MemoryEmailAdapter();
      setEmailAdapter(memoryAdapter);

      const activeUser = {
        id: 'user-active-reset',
        name: 'Usuário Ativo',
        email: 'recuperar@empresa.com',
        active: true,
        approvedAt: new Date(),
        rejectedAt: null,
      };

      mock.database.user.findUnique.mockResolvedValueOnce(activeUser);
      mock.database.user.update.mockResolvedValueOnce(activeUser);

      const res = await requestPasswordReset({ email: 'recuperar@empresa.com' });
      expect(res).toEqual(GENERIC_RESET_RESPONSE);

      expect(mock.database.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-active-reset' },
          data: expect.objectContaining({
            passwordResetTokenHash: expect.any(String),
            passwordResetExpiresAt: expect.any(Date),
          }),
        })
      );

      const updateData = mock.database.user.update.mock.calls[0][0].data;
      expect(updateData.passwordResetTokenHash).toHaveLength(64); // SHA-256 hex

      // Verifica envio de e-mail com link
      expect(memoryAdapter.getSentEmails()).toHaveLength(1);
      const sent = memoryAdapter.getLastEmail()!;
      expect(sent.to).toBe('recuperar@empresa.com');
      expect(sent.subject).toContain('Recuperação de senha');
      expect(sent.text).toContain('token=');
      expect(sent.text).toContain('action=reset-password');

      // Auditoria
      expect(mock.database.adminAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'PASSWORD_RESET_REQUESTED',
            targetUserId: 'user-active-reset',
          }),
        })
      );
    });

    it('rejeita redefinição de senha com token inválido ou expirado', async () => {
      mock.database.user.findFirst.mockResolvedValueOnce(null);

      await expect(
        resetPasswordWithToken({
          token: 'token-invalido-ou-expirado',
          newPassword: 'NovaSenhaForte123!',
          confirmPassword: 'NovaSenhaForte123!',
        })
      ).rejects.toMatchObject({
        code: 'INVALID_RESET_TOKEN',
        status: 400,
      });
    });

    it('rejeita redefinição se nova senha for igual à anterior', async () => {
      const currentHash = await bcrypt.hash('SenhaAtual123!', 10);
      mock.database.user.findFirst.mockResolvedValueOnce({
        id: 'user-reset-same',
        email: 'mesmasenha@empresa.com',
        passwordHash: currentHash,
      });

      await expect(
        resetPasswordWithToken({
          token: 'token-valido-123456',
          newPassword: 'SenhaAtual123!',
          confirmPassword: 'SenhaAtual123!',
        })
      ).rejects.toMatchObject({
        code: 'PASSWORD_UNCHANGED',
        status: 422,
      });
    });

    it('redefine senha com sucesso: limpa tokens, revoga sessões anteriores e registra auditoria', async () => {
      const oldHash = await bcrypt.hash('SenhaAntiga123!', 10);
      const user = {
        id: 'user-success-reset',
        email: 'sucesso@empresa.com',
        passwordHash: oldHash,
        mustChangePassword: true,
      };

      mock.database.user.findFirst.mockResolvedValueOnce(user);
      mock.database.user.update.mockResolvedValueOnce({ ...user, mustChangePassword: false });
      mock.database.authSession.updateMany.mockResolvedValueOnce({ count: 2 });

      const res = await resetPasswordWithToken({
        token: 'token-valido-12345',
        newPassword: 'NovaSenhaDefinitiva123!',
        confirmPassword: 'NovaSenhaDefinitiva123!',
      });

      expect(res.success).toBe(true);

      // Limpa token de reset e provisório, incrementa tokenVersion
      expect(mock.database.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-success-reset' },
          data: expect.objectContaining({
            passwordResetTokenHash: null,
            passwordResetExpiresAt: null,
            mustChangePassword: false,
            provisionalPasswordHash: null,
            tokenVersion: { increment: 1 },
          }),
        })
      );

      // Revoga sessões
      expect(mock.database.authSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-success-reset', revokedAt: null },
          data: { revokedAt: expect.any(Date) },
        })
      );

      // Auditoria
      expect(mock.database.adminAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'PASSWORD_CHANGED',
            targetUserId: 'user-success-reset',
          }),
        })
      );
    });
  });
});
