// Fixture only: run Vite --mode listing-test --port 5174, never the normal application.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/App';
import '../src/styles.css';
import '../src/auth.css';
import '../src/enhancements.css';
import '../src/responsive-overrides.css';
import '../src/foundation.css';
import '../src/records.css';

if (import.meta.env.MODE !== 'listing-test') throw new Error('Esta página é exclusiva do ambiente de teste.');
const count = Number(new URLSearchParams(location.search).get('count') ?? 45);
const records = Array.from({ length: count }, (_, i) => ({
  ticket: `TEST-${String(i + 1).padStart(4, '0')}`, orderNumber: String(1000 + i), description: 'Registro exclusivo de teste visual, sem persistência.',
  priority: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'][i % 4], status: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'][i % 4],
  customer: { name: `Cliente de teste ${i + 1}` }, reason: { name: i % 2 ? 'Extravio' : 'Avaria' }, assignee: i % 3 ? { name: 'Responsável de teste' } : null,
  openedAt: '2026-09-01T12:00:00Z', dueAt: '2026-09-15T12:00:00Z', updatedAt: '2026-09-12T12:00:00Z',
}));
let requests = 0;
window.fetch = async (input, options) => {
  if (options?.method && options.method !== 'GET') throw new Error('Escritas bloqueadas no teste.');
  const url = new URL(String(input));
  if (url.pathname !== '/sac-records') throw new Error('Rota não disponível no teste.');
  const q = url.searchParams; requests++;
  const counter = document.getElementById('test-requests'); if (counter) counter.textContent = `Requisições de teste: ${requests}`;
  await new Promise(resolve => setTimeout(resolve, q.get('query') === 'lenta' ? 900 : 100));
  if (q.get('query') === 'erro') return new Response('{}', { status: 500 });
  const items = records.filter(record => (!q.get('query') || JSON.stringify(record).toLowerCase().includes(q.get('query')!.toLowerCase())) && (!q.get('status') || record.status === q.get('status')) && (!q.get('priority') || record.priority === q.get('priority')) && (!q.get('reason') || record.reason.name === q.get('reason')) && (!q.get('owner') || record.assignee?.name === q.get('owner')) && (!q.get('unassigned') || !record.assignee));
  items.sort((a, b) => {
    const key = q.get('sort') as keyof typeof a;
    const left = key === 'customer' ? a.customer.name : String(a[key]); const right = key === 'customer' ? b.customer.name : String(b[key]);
    return left.localeCompare(right) * (q.get('order') === 'asc' ? 1 : -1);
  });
  const size = Number(q.get('pageSize')); const start = (Number(q.get('page')) - 1) * size;
  return new Response(JSON.stringify({ data: { items: items.slice(start, start + size), total: items.length, options: { owners: ['Responsável de teste'], reasons: ['Avaria', 'Extravio'] }, counts: {} } }), { headers: { 'Content-Type': 'application/json' } });
};
createRoot(document.getElementById('root')!).render(<><span id="test-requests" style={{ position: 'fixed', bottom: 0, right: 0, zIndex: 9999, background: '#fff', fontSize: 10 }}>Ambiente isolado de teste</span><App user={{ id: 'test-only', name: 'Teste visual', email: 'test@example.invalid', role: 'ADMIN' }} onLogout={() => {}} /></>);
