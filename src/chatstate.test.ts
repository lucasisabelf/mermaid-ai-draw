import { describe, expect, it } from 'vitest';
import { aplicar, formatarCusto, inicial, sugerirMencoes } from './chatstate';

const msg = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  nome: 'Cética',
  persona: 'n2',
  tipo: 'fala',
  texto: 'texto',
  em: '2026-10-20T00:00:00Z',
  ...over,
});

describe('estado do chat a partir dos eventos', () => {
  it('início, "pensando" com o texto chegando, mensagem final e fim', () => {
    let s = inicial();
    s = aplicar(s, { type: 'chat.inicio', conversa: 'c1', assunto: 'Cafeteria?', modo: 'debate', rodadas: 2, ordem: ['Otimista', 'Cética'] });
    expect(s).toMatchObject({ conversa: 'c1', status: 'rodando', assunto: 'Cafeteria?', mensagens: [] });

    s = aplicar(s, { type: 'chat.mensagem', conversa: 'c1', mensagem: msg('m0', { nome: 'Você', persona: undefined, tipo: 'usuario', texto: 'Cafeteria?' }) });
    s = aplicar(s, { type: 'chat.turno', conversa: 'c1', turno: 't1', persona: 'n2', nome: 'Cética', tipo: 'fala', status: 'pensando', motor: 'ollama' });
    expect(s.pendentes).toEqual([{ turno: 't1', persona: 'n2', nome: 'Cética', tipo: 'fala', motor: 'ollama', texto: '' }]);
    s = aplicar(s, { type: 'chat.delta', conversa: 'c1', turno: 't1', texto: 'Mas ' });
    s = aplicar(s, { type: 'chat.delta', conversa: 'c1', turno: 't1', texto: 'e o custo?' });
    expect(s.pendentes[0].texto).toBe('Mas e o custo?');

    // Evento de outra conversa é ignorado.
    s = aplicar(s, { type: 'chat.delta', conversa: 'outra', turno: 't1', texto: 'xxx' });
    expect(s.pendentes[0].texto).toBe('Mas e o custo?');

    s = aplicar(s, { type: 'chat.mensagem', conversa: 'c1', mensagem: msg('m1', { turno: 't1', texto: 'Mas e o custo?', uso: { entrada: 10, saida: 5, custo: 0.0123 } }) });
    expect(s.pendentes).toEqual([]);
    expect(s.mensagens.map((m) => m.id)).toEqual(['m0', 'm1']);
    expect(s.custo).toBeCloseTo(0.0123);
    // A mesma mensagem duas vezes (reconexão do SSE) não duplica.
    s = aplicar(s, { type: 'chat.mensagem', conversa: 'c1', mensagem: msg('m1', { turno: 't1' }) });
    expect(s.mensagens).toHaveLength(2);

    s = aplicar(s, { type: 'chat.fim', conversa: 'c1', status: 'terminada', resposta: 'Polida.' });
    expect(s).toMatchObject({ status: 'terminada', resposta: 'Polida.' });
  });

  it('ao carregar uma conversa em andamento, os turnos pendentes aparecem como "pensando"', () => {
    const s = aplicar(inicial(), {
      type: 'carregar',
      conversa: { id: 'c3', assunto: 'z', modo: 'debate', status: 'rodando', mensagens: [], pendentes: [{ turno: 't1', persona: 'n1', nome: 'Otimista', tipo: 'fala', motor: 'mcp' }] },
    });
    expect(s.pendentes).toEqual([{ turno: 't1', persona: 'n1', nome: 'Otimista', tipo: 'fala', motor: 'mcp', texto: '' }]);
  });

  it('turno com erro sai dos pendentes; carregar uma conversa salva substitui tudo', () => {
    let s = aplicar(inicial(), { type: 'chat.inicio', conversa: 'c1', assunto: 'x', modo: 'tarefa', rodadas: 1, ordem: [] });
    s = aplicar(s, { type: 'chat.turno', conversa: 'c1', turno: 't9', persona: 'n1', nome: 'A', tipo: 'tarefa', status: 'pensando', motor: 'api' });
    s = aplicar(s, { type: 'chat.turno', conversa: 'c1', turno: 't9', persona: 'n1', nome: 'A', tipo: 'tarefa', status: 'fim', motor: 'api' });
    expect(s.pendentes).toEqual([]);

    s = aplicar(s, {
      type: 'carregar',
      conversa: { id: 'c2', assunto: 'y', modo: 'resposta', status: 'terminada', resposta: 'R', mensagens: [msg('a', { uso: { custo: 0.5 } }), msg('b', { uso: { custo: 0.25 } })] },
    });
    expect(s).toMatchObject({ conversa: 'c2', assunto: 'y', status: 'terminada', resposta: 'R', pendentes: [] });
    expect(s.mensagens).toHaveLength(2);
    expect(s.custo).toBeCloseTo(0.75);
  });
});

describe('ajudas do chat', () => {
  const pessoas = [
    { id: 'n1', nome: 'Otimista' },
    { id: 'n2', nome: 'Cética' },
    { id: 'n3', nome: 'Moderadora' },
  ];

  it('sugere personas para completar a @menção que está sendo digitada', () => {
    expect(sugerirMencoes('e aí @ce', pessoas).map((p) => p.nome)).toEqual(['Cética']);
    expect(sugerirMencoes('@', pessoas)).toHaveLength(3);
    expect(sugerirMencoes('sem arroba', pessoas)).toEqual([]);
    expect(sugerirMencoes('@Cética já completa ', pessoas)).toEqual([]);
  });

  it('formata o custo', () => {
    expect(formatarCusto(0)).toBe('US$ 0,00');
    expect(formatarCusto(0.0042)).toBe('US$ 0,0042');
    expect(formatarCusto(1.5)).toBe('US$ 1,50');
  });
});
