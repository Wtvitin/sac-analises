import { describe, expect, it } from 'vitest';
import { notificationCountLabel, notificationEmptyCopy } from './notification-center.utils';

describe('centro de notificações', () => {
  it('limita visualmente o contador em 99+', () => {
    expect(notificationCountLabel(7)).toBe('7');
    expect(notificationCountLabel(100)).toBe('99+');
  });

  it('mantém os estados vazios oficiais sem conteúdo fictício', () => {
    expect(notificationEmptyCopy('all')).toEqual({
      title: 'Nenhuma notificação',
      summary: 'Atualizações importantes sobre seus casos aparecerão aqui.',
    });
    expect(notificationEmptyCopy('unread')).toEqual({
      title: 'Tudo em dia',
      summary: 'Você não possui notificações pendentes de leitura.',
    });
  });
});
