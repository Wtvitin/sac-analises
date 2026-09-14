import { z } from 'zod';

export const loginSchema = z.object({ email: z.email().transform(v => v.toLowerCase()), password: z.string().min(8).max(128) });
export const registerSchema = z.object({
  name: z.string().trim().min(3).max(120),
  email: z.email().transform(v => v.toLowerCase()),
  password: z.string().min(10).max(128).regex(/[A-Z]/, 'Inclua uma letra maiúscula.').regex(/[a-z]/, 'Inclua uma letra minúscula.').regex(/[0-9]/, 'Inclua um número.'),
});
