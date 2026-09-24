import type { EmailAdapter, EmailSendResult } from './email.types.js';
import { GmailSmtpEmailAdapter, LocalPreviewEmailAdapter, MemoryEmailAdapter } from './email.adapter.js';

export function isRealEmailDeliveryConfigured(): boolean {
  return Boolean(process.env.SMTP_USER?.trim() && process.env.SMTP_PASS?.trim());
}

export function createDefaultEmailAdapter(): EmailAdapter {
  if (process.env.NODE_ENV === 'test') {
    return new MemoryEmailAdapter();
  }

  const smtpUser = process.env.SMTP_USER?.trim();
  const smtpPass = process.env.SMTP_PASS?.trim();

  if (smtpUser && smtpPass) {
    return new GmailSmtpEmailAdapter({
      host: process.env.SMTP_HOST?.trim() || 'smtp.gmail.com',
      port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 465,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : true,
      user: smtpUser,
      pass: smtpPass,
      from: process.env.SMTP_FROM?.trim() || smtpUser,
    });
  }

  return new LocalPreviewEmailAdapter();
}

let defaultAdapter: EmailAdapter = createDefaultEmailAdapter();

export function setEmailAdapter(adapter: EmailAdapter) {
  defaultAdapter = adapter;
}

export function refreshEmailAdapter(): EmailAdapter {
  defaultAdapter = createDefaultEmailAdapter();
  return defaultAdapter;
}

export function getEmailAdapter(): EmailAdapter {
  return defaultAdapter;
}

export type SendProvisionalPasswordInput = {
  to: string;
  name: string;
  provisionalPassword: string;
  expiresAt: Date;
  loginUrl?: string;
};

export async function sendProvisionalPasswordEmail(
  input: SendProvisionalPasswordInput,
  adapter?: EmailAdapter
): Promise<EmailSendResult> {
  const activeAdapter = adapter || getEmailAdapter();
  const expiresAtFormatted = input.expiresAt.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  });
  const webOrigin = input.loginUrl || process.env.WEB_ORIGIN || 'http://localhost:5173';

  const text = [
    `Olá, ${input.name}!`,
    '',
    'Sua solicitação de acesso ao SAC Análises foi aprovada.',
    '',
    `Sua senha provisória de primeiro acesso é: ${input.provisionalPassword}`,
    `Esta senha é provisória e válida até: ${expiresAtFormatted}`,
    '',
    'No seu primeiro login, será obrigatório definir sua nova senha permanente antes de acessar qualquer funcionalidade do sistema.',
    '',
    `Acesse o sistema pelo link: ${webOrigin}`,
    '',
    'Atenciosamente,',
    'Equipe SAC Análises',
  ].join('\n');

  const html = `
<div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 560px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
  <h2 style="color: #0f172a; margin-top: 0;">Seu acesso ao SAC Análises foi aprovado</h2>
  <p>Olá, <strong>${input.name}</strong>!</p>
  <p>Sua conta foi aprovada por um administrador. Utilize a senha provisória abaixo para realizar seu primeiro acesso:</p>
  <div style="background-color: #f1f5f9; padding: 16px; border-radius: 6px; text-align: center; margin: 20px 0;">
    <span style="font-size: 18px; font-family: monospace; font-weight: bold; letter-spacing: 1px; color: #0284c7;">${input.provisionalPassword}</span>
  </div>
  <p style="font-size: 13px; color: #64748b;">
    <strong>Atenção:</strong> Esta senha é válida até <strong>${expiresAtFormatted}</strong>.<br/>
    No primeiro acesso, você deverá definir sua nova senha permanente.
  </p>
  <div style="margin-top: 24px;">
    <a href="${webOrigin}" style="background-color: #0284c7; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">Acessar SAC Análises</a>
  </div>
</div>
  `.trim();

  return activeAdapter.send({
    to: input.to,
    subject: '[SAC Análises] Seu acesso foi aprovado - Senha provisória',
    text,
    html,
    metadata: {
      action: 'PROVISIONAL_PASSWORD',
      expiresAt: input.expiresAt.toISOString(),
    },
  });
}

export type SendPasswordResetInput = {
  to: string;
  name: string;
  resetToken: string;
  expiresAt: Date;
  resetUrl?: string;
};

export async function sendPasswordResetEmail(
  input: SendPasswordResetInput,
  adapter?: EmailAdapter
): Promise<EmailSendResult> {
  const activeAdapter = adapter || getEmailAdapter();
  const expiresAtFormatted = input.expiresAt.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  });
  const webOrigin = process.env.WEB_ORIGIN || 'http://localhost:5173';
  const resetLink = input.resetUrl || `${webOrigin}/?token=${input.resetToken}&action=reset-password`;

  const text = [
    `Olá, ${input.name}!`,
    '',
    'Recebemos uma solicitação para redefinir a senha da sua conta no SAC Análises.',
    '',
    'Para definir uma nova senha, utilize o link abaixo:',
    resetLink,
    '',
    `Este link é de uso único e expira em: ${expiresAtFormatted}.`,
    '',
    'Se você não solicitou a redefinição de senha, desconsidere esta mensagem. Sua conta permanece segura.',
    '',
    'Atenciosamente,',
    'Equipe SAC Análises',
  ].join('\n');

  const html = `
<div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 560px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
  <h2 style="color: #0f172a; margin-top: 0;">Recuperação de Senha - SAC Análises</h2>
  <p>Olá, <strong>${input.name}</strong>!</p>
  <p>Recebemos uma solicitação para redefinir a senha de acesso da sua conta.</p>
  <div style="margin: 24px 0; text-align: center;">
    <a href="${resetLink}" style="background-color: #0284c7; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">Redefinir Minha Senha</a>
  </div>
  <p style="font-size: 13px; color: #64748b;">
    <strong>Atenção:</strong> Este link é de uso único e expira em <strong>${expiresAtFormatted}</strong>.<br/>
    Caso o botão acima não funcione, copie e cole o link a seguir no seu navegador:<br/>
    <span style="word-break: break-all; color: #0284c7;">${resetLink}</span>
  </p>
  <p style="font-size: 12px; color: #94a3b8; margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 12px;">
    Se você não realizou esta solicitação, por favor ignore este e-mail. Nenhuma alteração foi realizada na sua conta.
  </p>
</div>
  `.trim();

  return activeAdapter.send({
    to: input.to,
    subject: '[SAC Análises] Recuperação de senha',
    text,
    html,
    metadata: {
      action: 'PASSWORD_RESET',
      expiresAt: input.expiresAt.toISOString(),
    },
  });
}
