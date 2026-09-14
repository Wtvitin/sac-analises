import { z } from 'zod';

export const notificationListSchema = z.object({
  filter: z.enum(['all', 'unread']).default('all'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const notificationIdSchema = z.string().trim().min(1).max(80);
