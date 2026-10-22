import { z } from 'zod';

export const normalizeEmail = (value: string) => value.trim().toLowerCase();
export const sanitizeName = (value: string) => value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
const strongPassword = z.string().min(12, 'A senha deve ter pelo menos 12 caracteres.').max(128).regex(/[A-Z]/, 'Inclua uma letra maiúscula.').regex(/[a-z]/, 'Inclua uma letra minúscula.').regex(/[0-9]/, 'Inclua um número.');

export const loginSchema = z.object({ email: z.email().transform(normalizeEmail), password: z.string().min(8).max(128) });
export const registerSchema = z.object({
  name: z.string().max(120).transform(sanitizeName).pipe(z.string().min(3).max(120)),
  email: z.string().max(254).pipe(z.email()).transform(normalizeEmail),
  password: strongPassword,
  confirmPassword: z.string().max(128),
  department: z.string().trim().max(100).optional().nullable(),
}).refine(input => input.password === input.confirmPassword, { path: ['confirmPassword'], message: 'As senhas não coincidem.' });

export const profileNameSchema = z.object({ name: z.string().max(120).transform(sanitizeName).pipe(z.string().min(3).max(120)) });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(8).max(128), newPassword: strongPassword, confirmPassword: z.string().max(128) })
  .refine(input => input.newPassword === input.confirmPassword, { path: ['confirmPassword'], message: 'As senhas não coincidem.' })
  .refine(input => input.newPassword !== input.currentPassword, { path: ['newPassword'], message: 'A nova senha deve ser diferente da atual.' });

export const forgotPasswordSchema = z.object({
  email: z.string().max(254).pipe(z.email()).transform(normalizeEmail),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(16).max(256),
  newPassword: strongPassword,
  confirmPassword: z.string().max(128),
}).refine(input => input.newPassword === input.confirmPassword, {
  path: ['confirmPassword'],
  message: 'As senhas não coincidem.',
});
