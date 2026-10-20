import fs from 'node:fs';
import type { Motor, Pedido, Resposta } from '../conversa.ts';

/**
 * Motor Ollama: a persona fala por um modelo local (ex.: qwen2.5:3b), pela API HTTP do Ollama
 * (`POST /api/chat` em streaming, `GET /api/tags` para os modelos). Sem custo, mas na CPU de um
 * notebook é lento: um pedido por vez, e a tela mostra os tokens por segundo.
 */

/** O IP do Windows visto do WSL (o gateway padrão), onde o Ollama do Windows escuta. */
function gatewayDoWsl(): string | undefined {
  if (!process.env.WSL_DISTRO_NAME) return undefined;
  try {
    for (const linha of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const [, destino, gateway] = linha.trim().split(/\s+/);
      if (destino === '00000000' && gateway) {
        const bytes = gateway.match(/../g)!.reverse().map((h) => parseInt(h, 16));
        return `http://${bytes.join('.')}:11434`;
      }
    }
  } catch {}
  return undefined;
}

/** Onde procurar o Ollama: OLLAMA_URL, o localhost e (no WSL) o Windows. */
export function urlsPadrao(): string[] {
  return [process.env.OLLAMA_URL, 'http://localhost:11434', gatewayDoWsl()].filter((u): u is string => Boolean(u));
}

export interface OpcoesOllama {
  urls?: string[];
}

export function criarMotorOllama(opts: OpcoesOllama = {}): Motor & { modelos(): Promise<string[]> } {
  const urls = opts.urls ?? urlsPadrao();
  let achada: string | undefined;
  let fila: Promise<unknown> = Promise.resolve();

  const tags = async (url: string) => {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
  };

  /** A primeira URL que responde (e fica guardada). */
  const url = async () => {
    if (achada) return achada;
    for (const u of urls) {
      try {
        await tags(u);
        return (achada = u);
      } catch {}
    }
    throw new Error(`Ollama fora do ar (procurei em ${urls.join(', ')}). Instale no Windows (winget install Ollama.Ollama), abra o Ollama e baixe um modelo (ollama pull qwen2.5:3b).`);
  };

  const conversar = async (p: Pedido, delta: (t: string) => void): Promise<Resposta> => {
    const base = await url();
    let res: Response;
    try {
      res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: p.persona.modelo,
          stream: true,
          messages: [
            { role: 'system', content: p.system },
            { role: 'user', content: p.contexto },
          ],
        }),
        signal: p.signal,
      });
    } catch (err) {
      achada = undefined;
      throw new Error(`Ollama fora do ar em ${base}: ${(err as Error).message}`);
    }
    if (res.status === 404) throw new Error(`o modelo "${p.persona.modelo}" não está no Ollama: rode \`ollama pull ${p.persona.modelo}\``);
    if (!res.ok || !res.body) throw new Error(`Ollama respondeu ${res.status}: ${await res.text()}`);

    let texto = '';
    let fim: { prompt_eval_count?: number; eval_count?: number; eval_duration?: number } = {};
    let resto = '';
    const decoder = new TextDecoder();
    for await (const pedaco of res.body as unknown as AsyncIterable<Uint8Array>) {
      resto += decoder.decode(pedaco, { stream: true });
      const linhas = resto.split('\n');
      resto = linhas.pop()!;
      for (const l of linhas) {
        if (!l.trim()) continue;
        const ev = JSON.parse(l) as { message?: { content?: string }; done?: boolean; error?: string };
        if (ev.error) throw new Error(`Ollama: ${ev.error}`);
        const t = ev.message?.content ?? '';
        if (t) {
          texto += t;
          delta(t);
        }
        if (ev.done) fim = ev as typeof fim;
      }
    }
    const saida = fim.eval_count ?? 0;
    const segundos = (fim.eval_duration ?? 0) / 1e9;
    return {
      texto,
      uso: { entrada: fim.prompt_eval_count ?? 0, saida, custo: 0, tokensPorSegundo: segundos ? Math.round((saida / segundos) * 10) / 10 : undefined },
    };
  };

  return {
    nome: 'ollama',
    async disponivel() {
      try {
        const u = await url();
        const m = await tags(u);
        return { ok: true, detalhe: m.length ? `${u} · modelos: ${m.join(', ')}` : `${u} · nenhum modelo baixado (ollama pull qwen2.5:3b)` };
      } catch (err) {
        return { ok: false, detalhe: (err as Error).message };
      }
    },
    async modelos() {
      try {
        return await tags(await url());
      } catch {
        return [];
      }
    },
    /** Um pedido por vez: na CPU, dois ao mesmo tempo só deixam os dois mais lentos. */
    atender(p, delta) {
      const vez = fila.then(() => conversar(p, delta));
      fila = vez.catch(() => {});
      return vez;
    },
  };
}
