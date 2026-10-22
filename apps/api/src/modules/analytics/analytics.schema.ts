import { z } from 'zod';

export const analyticsPeriodSchema = z.enum(['7d', '30d', '90d', '6m', 'year', 'custom']);
export type AnalyticsPeriod = z.infer<typeof analyticsPeriodSchema>;

const datePattern = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/;

function parseDateInput(value: string | undefined) {
  if (!value) return undefined;
  if (!datePattern.test(value)) return null;
  const parsed = new Date(value.includes('T') ? value : `${value}T00:00:00.000Z`);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export const analyticsFilterSchema = z.object({
  period: analyticsPeriodSchema.default('30d'),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  assigneeId: z.string().trim().min(1).optional(),
  reasonId: z.string().trim().min(1).optional(),
  subreasonId: z.string().trim().min(1).optional(),
  channelId: z.string().trim().min(1).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
  department: z.string().trim().max(100).optional(),
}).superRefine((data, ctx) => {
  if (data.startDate) {
    const parsedStart = parseDateInput(data.startDate);
    if (!parsedStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Data inicial inválida.', path: ['startDate'] });
    }
  }
  if (data.endDate) {
    const parsedEnd = parseDateInput(data.endDate);
    if (!parsedEnd) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Data final inválida.', path: ['endDate'] });
    }
  }
  if (data.startDate && data.endDate) {
    const start = parseDateInput(data.startDate);
    const end = parseDateInput(data.endDate);
    if (start && end && start > end) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A data inicial deve ser anterior ou igual à data final.', path: ['startDate'] });
    }
  }
  if (data.period === 'custom' && (!data.startDate || !data.endDate)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Informe a data inicial e final para período personalizado.', path: ['period'] });
  }
});

export type AnalyticsFilters = z.infer<typeof analyticsFilterSchema>;
