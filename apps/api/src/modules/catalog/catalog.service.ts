import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import {
  normalizeCatalogName,
  type catalogEntrySchema,
  type listCatalogSchema,
  type listSubreasonsSchema,
  type subreasonEntrySchema,
  type updateCatalogEntrySchema,
  type updateSubreasonEntrySchema,
} from './catalog.schema.js';

type ListInput = z.infer<typeof listCatalogSchema>;
type ListSubreasonsInput = z.infer<typeof listSubreasonsSchema>;
type EntryInput = z.infer<typeof catalogEntrySchema>;
type UpdateEntryInput = z.infer<typeof updateCatalogEntrySchema>;
type SubreasonInput = z.infer<typeof subreasonEntrySchema>;
type UpdateSubreasonInput = z.infer<typeof updateSubreasonEntrySchema>;

export class CatalogError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

function activeFilter(input: ListInput, isAdmin: boolean) {
  if (!isAdmin) return true;
  if (input.status === 'active') return true;
  if (input.status === 'inactive') return false;
  return undefined;
}

function textFilter(query?: string) {
  return query ? {
    OR: [
      { name: { contains: query, mode: Prisma.QueryMode.insensitive } },
      { description: { contains: query, mode: Prisma.QueryMode.insensitive } },
    ],
  } : {};
}

function normalizedData(input: EntryInput | UpdateEntryInput) {
  return { ...input, ...(input.name ? { normalizedName: normalizeCatalogName(input.name) } : {}) };
}

function translateWriteError(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'P2002') {
    throw new CatalogError('DUPLICATE_CATALOG_ENTRY', 'Já existe um cadastro com este nome.', 409);
  }
  if (code === 'P2025') {
    throw new CatalogError('CATALOG_ENTRY_NOT_FOUND', 'Cadastro não encontrado.', 404);
  }
  throw error;
}

export async function listReasons(input: ListInput, isAdmin: boolean) {
  const where: Prisma.ReasonWhereInput = { active: activeFilter(input, isAdmin), ...textFilter(input.query) };
  const [items, total] = await prisma.$transaction([
    prisma.reason.findMany({ where, skip: (input.page - 1) * input.pageSize, take: input.pageSize, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }], include: { _count: { select: { subreasons: { where: { active: true } }, records: true } } } }),
    prisma.reason.count({ where }),
  ]);
  return { items, total, page: input.page, pageSize: input.pageSize };
}

export async function getReason(id: string, isAdmin: boolean) {
  const item = await prisma.reason.findFirst({ where: { id, ...(!isAdmin ? { active: true } : {}) }, include: { subreasons: { orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] }, _count: { select: { subreasons: true, records: true } } } });
  if (!item) throw new CatalogError('CATALOG_ENTRY_NOT_FOUND', 'Cadastro não encontrado.', 404);
  return item;
}

export async function createReason(input: EntryInput) {
  try { return await prisma.reason.create({ data: normalizedData(input) as Prisma.ReasonCreateInput }); }
  catch (error) { return translateWriteError(error); }
}

export async function updateReason(id: string, input: UpdateEntryInput) {
  try { return await prisma.reason.update({ where: { id }, data: normalizedData(input) }); }
  catch (error) { return translateWriteError(error); }
}

export async function setReasonStatus(id: string, active: boolean) {
  try {
    const [item, activeSubreasons] = await prisma.$transaction([
      prisma.reason.update({ where: { id }, data: { active } }),
      prisma.subreason.count({ where: { reasonId: id, active: true } }),
    ]);
    return { ...item, activeSubreasons };
  } catch (error) { return translateWriteError(error); }
}

export async function listSubreasons(input: ListSubreasonsInput, isAdmin: boolean) {
  const where: Prisma.SubreasonWhereInput = { active: activeFilter(input, isAdmin), reasonId: input.reasonId, ...(!isAdmin ? { reason: { active: true } } : {}), ...textFilter(input.query) };
  const [items, total] = await prisma.$transaction([
    prisma.subreason.findMany({ where, skip: (input.page - 1) * input.pageSize, take: input.pageSize, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }], include: { reason: { select: { id: true, name: true, active: true } }, _count: { select: { records: true } } } }),
    prisma.subreason.count({ where }),
  ]);
  return { items, total, page: input.page, pageSize: input.pageSize };
}

async function ensureActiveReason(database: Pick<Prisma.TransactionClient, 'reason'>, reasonId: string) {
  const reason = await database.reason.findUnique({ where: { id: reasonId }, select: { active: true } });
  if (!reason) throw new CatalogError('REASON_NOT_FOUND', 'Motivo principal não encontrado.', 422);
  if (!reason.active) throw new CatalogError('INACTIVE_REASON', 'Selecione um motivo principal ativo.', 422);
}

export async function createSubreason(input: SubreasonInput) {
  try {
    return await prisma.$transaction(async tx => {
      await ensureActiveReason(tx, input.reasonId);
      return tx.subreason.create({ data: { ...normalizedData(input), reasonId: input.reasonId } as Prisma.SubreasonUncheckedCreateInput, include: { reason: { select: { id: true, name: true, active: true } } } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) { return translateWriteError(error); }
}

export async function updateSubreason(id: string, input: UpdateSubreasonInput) {
  try {
    return await prisma.$transaction(async tx => {
      const current = await tx.subreason.findUnique({ where: { id }, select: { reasonId: true, active: true } });
      if (!current) throw new CatalogError('CATALOG_ENTRY_NOT_FOUND', 'Cadastro não encontrado.', 404);
      const reasonId = input.reasonId ?? current.reasonId;
      if (input.reasonId || (input.active === true && !current.active)) await ensureActiveReason(tx, reasonId);
      return tx.subreason.update({ where: { id }, data: { ...normalizedData(input), reasonId }, include: { reason: { select: { id: true, name: true, active: true } } } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
  catch (error) { return translateWriteError(error); }
}

export async function setSubreasonStatus(id: string, active: boolean) {
  try {
    return await prisma.$transaction(async tx => {
      const current = await tx.subreason.findUnique({ where: { id }, select: { reasonId: true } });
      if (!current) throw new CatalogError('CATALOG_ENTRY_NOT_FOUND', 'Cadastro não encontrado.', 404);
      if (active) await ensureActiveReason(tx, current.reasonId);
      return tx.subreason.update({ where: { id }, data: { active }, include: { reason: { select: { id: true, name: true, active: true } } } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
  catch (error) { return translateWriteError(error); }
}

export async function listChannels(input: ListInput, isAdmin: boolean) {
  const where: Prisma.ChannelWhereInput = { active: activeFilter(input, isAdmin), ...textFilter(input.query) };
  const [items, total] = await prisma.$transaction([
    prisma.channel.findMany({ where, skip: (input.page - 1) * input.pageSize, take: input.pageSize, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }] }),
    prisma.channel.count({ where }),
  ]);
  return { items, total, page: input.page, pageSize: input.pageSize };
}

export async function createChannel(input: EntryInput) {
  try { return await prisma.channel.create({ data: normalizedData(input) as Prisma.ChannelCreateInput }); }
  catch (error) { return translateWriteError(error); }
}

export async function updateChannel(id: string, input: UpdateEntryInput) {
  try { return await prisma.channel.update({ where: { id }, data: normalizedData(input) }); }
  catch (error) { return translateWriteError(error); }
}

export async function setChannelStatus(id: string, active: boolean) {
  try { return await prisma.channel.update({ where: { id }, data: { active } }); }
  catch (error) { return translateWriteError(error); }
}
