import { useEffect, useState } from 'react';
import { apiRequest } from './api';
import type { RecordItem } from './data';
import { recordListParams, type RecordFilters, type SortKey, type SortOrder } from './record-listing';

type ListResult<T> = { items: T[]; total: number; options: { owners: string[]; reasons: string[] }; counts: Record<string, number> };
const empty = { items: [] as RecordItem[], total: 0, options: { owners: [] as string[], reasons: [] as string[] }, counts: {} as Record<string, number> };

export function useRecordList<T>(query: string, filters: RecordFilters, sort: SortKey, order: SortOrder, page: number, pageSize: number, refresh: unknown, map: (record: T) => RecordItem) {
  const [state, setState] = useState({ ...empty, key: '', loading: true, error: false });
  const [retry, setRetry] = useState(0);
  const invalid = Boolean(filters.startDate && filters.endDate && filters.startDate > filters.endDate);
  const key = recordListParams(query, filters, sort, order, page, pageSize).toString();
  useEffect(() => {
    if (invalid) return;
    const controller = new AbortController();
    setState(previous => ({ ...previous, key, loading: true, error: false }));
    apiRequest<ListResult<T>>(`/sac-records?${key}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setState({ ...result, items: result.items.map(map), key, loading: false, error: false });
    }).catch(() => {
      if (!controller.signal.aborted) setState(previous => ({ ...previous, key, loading: false, error: true }));
    });
    return () => controller.abort();
  }, [key, invalid, retry, refresh, map]);
  return { ...state, loading: !invalid && (state.loading || state.key !== key), onRetry: () => setRetry(value => value + 1) };
}
