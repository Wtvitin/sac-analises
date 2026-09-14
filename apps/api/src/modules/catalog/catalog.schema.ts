import { z } from 'zod';

export function cleanCatalogName(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeCatalogName(value: string) {
  return cleanCatalogName(value).toLocaleLowerCase('pt-BR');
}

const catalogNameSchema = z.string()
  .transform(cleanCatalogName)
  .pipe(z.string().min(2, 'Informe um nome válido.').max(120, 'Use no máximo 120 caracteres.'));

const descriptionSchema = z.string().max(500, 'Use no máximo 500 caracteres.').optional()
  .transform(value => value === undefined ? undefined : value.trim() || null);

export const listCatalogSchema = z.object({
  query: z.string().trim().max(120).optional(),
  status: z.enum(['all', 'active', 'inactive']).default('all'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const listSubreasonsSchema = listCatalogSchema.extend({
  reasonId: z.string().trim().min(1).optional(),
});

const catalogEntryBaseSchema = z.object({
  name: catalogNameSchema,
  description: descriptionSchema,
  active: z.boolean(),
  displayOrder: z.coerce.number().int().min(0).max(9999),
});

export const catalogEntrySchema = catalogEntryBaseSchema.extend({
  active: z.boolean().default(true),
  displayOrder: z.coerce.number().int().min(0).max(9999).default(0),
});

export const updateCatalogEntrySchema = catalogEntryBaseSchema.partial().refine(
  value => Object.values(value).some(field => field !== undefined),
  { message: 'Informe ao menos um campo para atualização.' },
);

export const subreasonEntrySchema = catalogEntrySchema.extend({
  reasonId: z.string().trim().min(1, 'Selecione o motivo principal.'),
});

export const updateSubreasonEntrySchema = catalogEntryBaseSchema.extend({
  reasonId: z.string().trim().min(1, 'Selecione o motivo principal.'),
}).partial().refine(
  value => Object.values(value).some(field => field !== undefined),
  { message: 'Informe ao menos um campo para atualização.' },
);

export const catalogStatusSchema = z.object({ active: z.boolean() });
