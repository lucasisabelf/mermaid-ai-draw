import { describe, expect, it } from 'vitest';
import type { Pedido } from '../conversa.ts';
import { criarMotorApi, custoDe } from './api.ts';

const pedido = (over: Partial<Pedido> = {}): Pedido => ({
  id: 't1',
  conversa: 'c1',
  diagrama: 'd',
  tipo: 'fala',
  persona: { id: 'n1', nome: 'Cética', prompt: 'p', motor: 'api', modelo: 'claude-opus-5-5', esforco: 'high', papel: 'debatedora', cor: '#000000', ferramentas: [], inicio: false, saida: false, arquivo: 'saida.md', humana: false, aoVencer: 'seguir', memoria: false, escuta: 'todas', quando: 'rodada', limite: 4000, resumoPara: 'todas', curadoria: false },
  system: 'Você é a Cética.',
  contexto: 'Assunto: x',
  respondendoA: [],
  delegaveis: [],
  signal: new AbortController().signal,
  ...over,
});

/** Cliente falso com o formato de client.messages.stream(): eventos + finalMessage(). */
function clienteFalso(final: Record<string, unknown>, textos = ['Ol', 'á!']) {
  const chamadas: any[] = [];
  const client = {
    messages: {
      stream(params: any) {
        chamadas.push(params);
        const eventos = textos.map((text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }));
        return {
          async *[Symbol.asyncIterator]() {
            yield* eventos;
          },
          finalMessage: async () => ({ content: [{ type: 'text', text: textos.join('') }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 }, ...final }),
        };
      },
    },
  };
  return { client, chamadas };
}

describe('motor API (Claude)', () => {
  it('manda o prompt com cache, o modelo e o esforço da persona, e repassa o texto aos poucos', async () => {
    const { client, chamadas } = clienteFalso({});
    const motor = criarMotorApi({ client: client as any, credencial: () => true });
    const deltas: string[] = [];
    const r = await motor.atender(pedido(), (t) => deltas.push(t));

    expect(deltas).toEqual(['Ol', 'á!']);
    expect(r.texto).toBe('Olá!');
    const p = chamadas[0];
    expect(p.model).toBe('claude-opus-5-5');
    expect(p.output_config).toEqual({ effort: 'high' });
    expect(p.max_tokens).toBeGreaterThanOrEqual(16000);
    expect(p.system).toEqual([{ type: 'text', text: 'Você é a Cética.', cache_control: { type: 'ephemeral' } }]);
    expect(p.messages).toEqual([{ role: 'user', content: 'Assunto: x' }]);
    // Opus 5.5: $4 / $20 por milhão; leitura de cache a $0,20.
    expect(r.uso).toEqual({ entrada: 1000, saida: 500, cache: 2000, custo: custoDe('claude-opus-5-5', { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000 }) });
    expect(r.uso!.custo).toBeCloseTo(0.004 + 0.01 + 0.0004, 6);
  });

  it('recusa e corte por tamanho viram erros claros', async () => {
    const recusa = criarMotorApi({ client: clienteFalso({ stop_reason: 'refusal', stop_details: { category: 'cyber' } }).client as any, credencial: () => true });
    await expect(recusa.atender(pedido(), () => {})).rejects.toThrow(/recusou.*cyber/);
    const corte = criarMotorApi({ client: clienteFalso({ stop_reason: 'max_tokens' }).client as any, credencial: () => true });
    const r = await corte.atender(pedido(), () => {});
    expect(r.texto).toMatch(/cortada/);
  });

  it('sem credencial, fica indisponível e explica como resolver', async () => {
    const motor = criarMotorApi({ client: clienteFalso({}).client as any, credencial: () => false });
    expect(await motor.disponivel()).toMatchObject({ ok: false, detalhe: expect.stringMatching(/ANTHROPIC_API_KEY|ant auth login/) });
    await expect(motor.atender(pedido(), () => {})).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('custo por modelo', () => {
    expect(custoDe('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(12);
    expect(custoDe('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(0.1);
    expect(custoDe('modelo-desconhecido', { input_tokens: 10, output_tokens: 10 })).toBe(0);
  });
});
