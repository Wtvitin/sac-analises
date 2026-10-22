import type { Priority, SacStatus } from '@prisma/client';

export const OPERATIONAL_TIME_ZONE = 'America/Sao_Paulo';
export const NEAR_DUE_DAYS = 2;
export const STALE_AFTER_DAYS = 3;
const DAY_MS = 86_400_000;

export type AttentionReasonCode = 'OVERDUE' | 'DUE_TODAY' | 'NEAR_DUE' | 'HIGH_PRIORITY' | 'UNASSIGNED' | 'STALE' | 'NO_DUE';
export type DueState = 'WITHIN_DUE' | 'NEAR_DUE' | 'DUE_TODAY' | 'OVERDUE' | 'NO_DUE' | 'CLOSED';

export type OperationalRecord = {
  status: SacStatus;
  priority: Priority;
  dueAt: Date | null;
  assigneeId: string | null;
  lastOperationalActivityAt?: Date;
  updatedAt?: Date;
  createdAt?: Date;
  completedAt?: Date | null;
  activities?: Array<{
    eventType: string;
    createdAt: Date | string;
    [key: string]: any;
  }>;
};

const civilFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: OPERATIONAL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

export function civilDateParts(date: Date) {
  const values = Object.fromEntries(civilFormatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day };
}

export function civilDayNumber(date: Date) {
  const { year, month, day } = civilDateParts(date);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function zonedDayStart(dayNumber: number) {
  const approximate = dayNumber * DAY_MS; let low = approximate - 18 * 3_600_000; let high = approximate + 18 * 3_600_000;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (civilDayNumber(new Date(middle)) < dayNumber) low = middle + 1; else high = middle; }
  return new Date(low);
}

export function operationalBoundaries(now = new Date()) {
  const today = civilDayNumber(now);
  return {
    todayStart: zonedDayStart(today), tomorrowStart: zonedDayStart(today + 1), nearDueEnd: zonedDayStart(today + NEAR_DUE_DAYS + 1),
    staleBefore: new Date(now.getTime() - STALE_AFTER_DAYS * DAY_MS),
  };
}

export function resolveClosedDate(record: {
  status: SacStatus | string;
  completedAt?: Date | string | null;
  activities?: Array<{ eventType: string; createdAt: Date | string; [key: string]: any }>;
}): Date | null {
  const isClosed =
    record.status === 'COMPLETED' ||
    record.status === 'CANCELLED' ||
    record.status === 'Concluído' ||
    record.status === 'Cancelado';
  if (!isClosed) return null;

  // 1. Prioritize a persisted and reliable closing date
  if (record.completedAt) {
    const parsed = record.completedAt instanceof Date ? record.completedAt : new Date(record.completedAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  // 2. For legacy cases without completedAt, consult the last valid completion or cancellation event of the current cycle in history
  if (record.activities && record.activities.length > 0) {
    const parsedActivities = record.activities
      .map(a => ({
        eventType: a.eventType,
        createdAt: a.createdAt instanceof Date ? a.createdAt : new Date(a.createdAt),
      }))
      .filter(a => !Number.isNaN(a.createdAt.getTime()))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    let lastReopenIndex = -1;
    for (let i = parsedActivities.length - 1; i >= 0; i--) {
      if (parsedActivities[i].eventType === 'REOPENED' || parsedActivities[i].eventType === 'REACTIVATED') {
        lastReopenIndex = i;
        break;
      }
    }

    const targetEvent =
      record.status === 'COMPLETED' || record.status === 'Concluído' ? 'COMPLETED' : 'CANCELLED';

    for (let i = parsedActivities.length - 1; i > lastReopenIndex; i--) {
      if (parsedActivities[i].eventType === targetEvent) {
        return parsedActivities[i].createdAt;
      }
    }
  }

  // 3. If no reliable evidence exists, return null (never invent a date, never use updatedAt)
  return null;
}

export function classifyOperationalAttention(record: OperationalRecord, now = new Date()) {
  const open = record.status === 'PENDING' || record.status === 'IN_PROGRESS';
  const dueDifference = record.dueAt ? civilDayNumber(record.dueAt) - civilDayNumber(now) : null;
  const isOverdue = open && dueDifference !== null && dueDifference < 0;
  const isDueToday = open && dueDifference === 0;
  const isNearDue = open && dueDifference !== null && dueDifference > 0 && dueDifference <= NEAR_DUE_DAYS;
  const lastOperationalActivityAt = record.lastOperationalActivityAt ?? record.updatedAt ?? now;
  const staleMilliseconds = Math.max(0, now.getTime() - lastOperationalActivityAt.getTime());
  const staleDays = Math.floor(staleMilliseconds / DAY_MS);
  const isStale = open && staleMilliseconds >= STALE_AFTER_DAYS * DAY_MS;
  const isUnassigned = open && !record.assigneeId;
  const attentionReasons: AttentionReasonCode[] = [];
  if (isOverdue) attentionReasons.push('OVERDUE');
  else if (isDueToday) attentionReasons.push('DUE_TODAY');
  else if (isNearDue) attentionReasons.push('NEAR_DUE');
  if (open && (record.priority === 'HIGH' || record.priority === 'CRITICAL')) attentionReasons.push('HIGH_PRIORITY');
  if (isUnassigned) attentionReasons.push('UNASSIGNED');
  if (isStale) attentionReasons.push('STALE');
  if (open && !record.dueAt) attentionReasons.push('NO_DUE');
  const dueState: DueState = !open ? 'CLOSED' : !record.dueAt ? 'NO_DUE' : isOverdue ? 'OVERDUE' : isDueToday ? 'DUE_TODAY' : isNearDue ? 'NEAR_DUE' : 'WITHIN_DUE';

  // Calculate openDays based on system registration time (createdAt) and closure/current time
  const startDate = record.createdAt;
  let openDays: number | null = null;
  if (startDate) {
    if (open) {
      openDays = Math.max(0, civilDayNumber(now) - civilDayNumber(startDate));
    } else {
      const closedDate = resolveClosedDate(record);
      if (closedDate) {
        openDays = Math.max(0, civilDayNumber(closedDate) - civilDayNumber(startDate));
      } else {
        openDays = null;
      }
    }
  }

  return { isOverdue, isDueToday, isNearDue, isStale, isUnassigned, attentionReasons, dueState, overdueDays: isOverdue ? -dueDifference! : 0, staleDays, openDays, lastOperationalActivityAt };
}

export function compareAttention(left: OperationalRecord & { openedAt: Date }, right: OperationalRecord & { openedAt: Date }, now = new Date()) {
  const rank = (record: OperationalRecord) => {
    const flags = classifyOperationalAttention(record, now);
    return [flags.isOverdue, flags.isDueToday, flags.isNearDue, record.priority === 'HIGH' || record.priority === 'CRITICAL', flags.isUnassigned, flags.isStale].map(value => value ? 0 : 1);
  };
  const leftRank = rank(left); const rightRank = rank(right);
  for (let index = 0; index < leftRank.length; index++) if (leftRank[index] !== rightRank[index]) return leftRank[index] - rightRank[index];
  const due = (left.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (right.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER);
  return due || left.openedAt.getTime() - right.openedAt.getTime();
}
