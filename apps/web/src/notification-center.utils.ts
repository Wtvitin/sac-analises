export type NotificationFilter = 'all' | 'unread';

export function notificationCountLabel(count: number) { return count > 99 ? '99+' : String(count); }

export function notificationEmptyCopy(filter: NotificationFilter) {
  return filter === 'unread'
    ? { title: 'Tudo em dia', summary: 'Você não possui notificações pendentes de leitura.' }
    : { title: 'Nenhuma notificação', summary: 'Atualizações importantes sobre seus casos aparecerão aqui.' };
}
