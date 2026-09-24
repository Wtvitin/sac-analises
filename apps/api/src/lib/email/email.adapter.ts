import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailAdapter, EmailMessage, EmailSendResult } from './email.types.js';

export interface GmailSmtpConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  user: string;
  pass: string;
  from?: string;
}

export class GmailSmtpEmailAdapter implements EmailAdapter {
  private transporter: Transporter;
  private fromAddress: string;

  constructor(config: GmailSmtpConfig, customTransporter?: Transporter) {
    this.fromAddress = config.from?.trim() || config.user.trim();
    if (customTransporter) {
      this.transporter = customTransporter;
    } else {
      const port = config.port ?? (config.secure === false ? 587 : 465);
      const isSecure = config.secure ?? (port === 465);
      const host = config.host?.trim() || 'smtp.gmail.com';

      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: isSecure,
        auth: {
          user: config.user.trim(),
          pass: config.pass.trim(),
        },
      });
    }
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: this.fromAddress,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });

      return {
        success: true,
        delivered: true,
        adapter: 'smtp',
        messageId: info.messageId,
      };
    } catch (err: unknown) {
      const rawMessage = err instanceof Error ? err.message : 'Falha no envio via SMTP';
      const sanitizedMessage = rawMessage.replace(/:([^\s@]+)@/g, ':***@');
      return {
        success: false,
        delivered: false,
        adapter: 'smtp',
        error: sanitizedMessage,
      };
    }
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}

export class MemoryEmailAdapter implements EmailAdapter {
  private sent: EmailMessage[] = [];
  private simulateFailure = false;
  private failureErrorMessage = 'Falha simulada no adaptador de e-mail.';

  setSimulateFailure(fail: boolean, errorMessage?: string): void {
    this.simulateFailure = fail;
    if (errorMessage) this.failureErrorMessage = errorMessage;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (this.simulateFailure) {
      return {
        success: false,
        delivered: false,
        adapter: 'memory',
        error: this.failureErrorMessage,
      };
    }

    this.sent.push({ ...message });
    return {
      success: true,
      delivered: true,
      adapter: 'memory',
      messageId: `mem_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      previewSummary: {
        to: message.to,
        subject: message.subject,
        sentAt: new Date().toISOString(),
      },
    };
  }

  getSentEmails(): EmailMessage[] {
    return [...this.sent];
  }

  getLastEmail(): EmailMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  clear(): void {
    this.sent = [];
    this.simulateFailure = false;
  }
}

export class LocalPreviewEmailAdapter implements EmailAdapter {
  private previews: Array<{ to: string; subject: string; sentAt: string }> = [];

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const summary = {
      to: message.to,
      subject: message.subject,
      sentAt: new Date().toISOString(),
    };
    this.previews.push(summary);

    return {
      success: true,
      delivered: false, // Never mark as real delivery when using local preview
      adapter: 'local-preview',
      messageId: `preview_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      previewSummary: summary,
    };
  }

  getPreviews() {
    return [...this.previews];
  }

  clear() {
    this.previews = [];
  }
}
