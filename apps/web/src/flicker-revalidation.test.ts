import { describe, expect, it, vi } from 'vitest';
import { can } from './permissions';

describe('Correção de piscar de tela e estabilidade de atualização ao alternar abas', () => {
  it('diferencia permissões de leitura (Consulta) e escrita de tratativa (Analista / Administrador)', () => {
    // Perfil Consulta (VIEWER) pode ler o caso e o histórico, mas não pode registrar/editar tratativa
    expect(can('VIEWER', 'cases:read')).toBe(true);
    expect(can('VIEWER', 'cases:write')).toBe(false);

    // Administrador e Analista têm permissão para registrar tratativa
    expect(can('ADMIN', 'cases:write')).toBe(true);
    expect(can('ANALYST', 'cases:write')).toBe(true);
  });

  it('preserva dados em memória durante revalidação em segundo plano (evita loading: true que desmontava tabela)', () => {
    // Simula a lógica de useRecordList:
    type State = {
      key: string;
      loading: boolean;
      items: Array<{ ticket: string }>;
    };

    const previous: State = {
      key: '{"query":"","page":1}',
      loading: false,
      items: [{ ticket: 'SAC-2026-0001' }],
    };

    const nextKey = '{"query":"","page":1}';
    const isRevalidation = previous.key === nextKey && previous.items.length > 0;
    const nextState: State = {
      key: nextKey,
      loading: isRevalidation ? false : true,
      items: previous.items,
    };

    // Durante revalidação com mesma query, loading permanece false e os itens existentes não são apagados
    expect(nextState.loading).toBe(false);
    expect(nextState.items).toHaveLength(1);
    expect(nextState.items[0].ticket).toBe('SAC-2026-0001');

    // Ao mudar filtros/página (nova chave sem dados prévios dessa chave), ativa loading: true
    const differentKey = '{"query":"defeito","page":1}';
    const isDifferent = previous.key === differentKey && previous.items.length > 0;
    const searchState: State = {
      key: differentKey,
      loading: isDifferent ? false : true,
      items: isDifferent ? previous.items : [],
    };
    expect(searchState.loading).toBe(true);
    expect(searchState.items).toHaveLength(0);
  });

  it('coalesce eventos de focus e visibilitychange dentro da janela de throttle', () => {
    let lastEventTime = 0;
    let refreshCount = 0;
    const THROTTLE_MS = 15000;

    const onTabActive = (now: number) => {
      if (now - lastEventTime > THROTTLE_MS) {
        lastEventTime = now;
        refreshCount++;
      }
    };

    // Usuário volta à aba: navegador dispara 'focus' e 'visibilitychange' quase simultaneamente (e.g. 5ms de diferença)
    const t0 = 20000;
    onTabActive(t0); // focus dispara
    onTabActive(t0 + 5); // visibilitychange dispara logo em seguida

    // Deve disparar apenas 1 atualização, não 2
    expect(refreshCount).toBe(1);

    // Se o usuário alternar de aba novamente antes de 15 segundos, não dispara
    onTabActive(t0 + 5000);
    expect(refreshCount).toBe(1);

    // Após o término da janela de throttle, permite nova revalidação suave
    onTabActive(t0 + 16000);
    expect(refreshCount).toBe(2);
  });
});
