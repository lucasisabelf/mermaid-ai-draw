import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { Motor, Pedido, Resposta } from '../conversa.ts';

/**
 * Motor API: a persona fala pelo Claude, com a chave da Anthropic (ANTHROPIC_API_KEY, ou um perfil
 * do `ant auth login`). O texto chega aos poucos (streaming) e o custo de cada vez é calculado pelo
 * uso de tokens.
 */

/** Dólares por milhão de tokens: entrada, saída e leitura de cache. */
const PRECOS: Record<string, { entrada: number; saida: number; cache: number }> = {
  'claude-fable-5-1': { entrada: 10, saida: 50, cache: 1 },
  'claude-opus-5-5': { entrada: 4, saida: 20, cache: 0.2 },
  'claude-opus-5': { entrada: 5, saida: 25, cache: 0.5 },
  'claude-sonnet-5-5': { entrada: 2, saida: 10, cache: 0.2 },
  'claude-haiku-5-5': { entrada: 0.1, saida: 0.5, cache: 0.01 },
};

/** Modelos oferecidos no painel da persona. */
export const MODELOS_API = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];

export function custoDe(modelo: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
  const p = PRECOS[modelo];
  if (!p) return 0;
  // Escrita de cache custa 1,25× a entrada.
  const entrada = u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25;
  return (entrada * p.entrada + u.output_tokens * p.saida + (u.cache_read_input_tokens ?? 0) * p.cache) / 1_000_000;
}

/** Há credencial? A chave, o token, um perfil escolhido ou um perfil do `ant auth login` no disco. */
export function temCredencial() {
  const e = process.env;
  if (e.ANTHROPIC_API_KEY || e.ANTHROPIC_AUTH_TOKEN || e.ANTHROPIC_PROFILE) return true;
  try {
    return fs.readdirSync(path.join(os.homedir(), '.config', 'anthropic')).length > 0;
  } catch {
    return false;
  }
}

export interface OpcoesApi {
  /** Cliente da Anthropic (os testes passam um falso). */
  client?: Pick<Anthropic, 'messages'>;
  credencial?: () => boolean;
}

const SEM_CHAVE = 'sem credencial da Anthropic: defina ANTHROPIC_API_KEY (ou rode `ant auth login`) e reinicie o servidor';

export function criarMotorApi(opts: OpcoesApi = {}): Motor {
  const credencial = opts.credencial ?? temCredencial;
  let client = opts.client;
  const cliente = () => (client ??= new Anthropic());

  return {
    nome: 'api',
    async disponivel() {
      return credencial() ? { ok: true, detalhe: 'credencial da Anthropic encontrada' } : { ok: false, detalhe: SEM_CHAVE };
    },
    async atender(p: Pedido, delta): Promise<Resposta> {
      if (!credencial()) throw new Error(SEM_CHAVE);
      const tools = p.persona.ferramentas.includes('web_search') ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }] : undefined;
      const stream = cliente().messages.stream(
        {
          model: p.persona.modelo,
          max_tokens: 64000,
          // O prompt da persona é estável entre as vezes: fica em cache.
          system: [{ type: 'text', text: p.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: p.contexto }],
          output_config: { effort: p.persona.esforco },
          ...(tools ? { tools } : {}),
        } as Anthropic.MessageStreamParams,
        { signal: p.signal },
      );
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') delta(ev.delta.text);
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') {
        const cat = (final as { stop_details?: { category?: string | null } }).stop_details?.category;
        throw new Error(`o modelo recusou responder${cat ? ` (categoria: ${cat})` : ''}`);
      }
      let texto = final.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (final.stop_reason === 'max_tokens') texto += '\n\n(resposta cortada: atingiu o limite de tamanho)';
      const u = final.usage;
      return {
        texto,
        uso: { entrada: u.input_tokens, saida: u.output_tokens, cache: u.cache_read_input_tokens ?? 0, custo: custoDe(p.persona.modelo, u) },
      };
    },
  };
}
