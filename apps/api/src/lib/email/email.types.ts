export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  metadata?: Record<string, unknown>;
};

export type EmailSendResult = {
  success: boolean;
  delivered: boolean;
  adapter: 'smtp' | 'local-preview' | 'memory' | 'disabled';
  messageId?: string;
  previewSummary?: {
    to: string;
    subject: string;
    sentAt: string;
  };
  error?: string;
};

export interface EmailAdapter {
  send(message: EmailMessage): Promise<EmailSendResult>;
}
