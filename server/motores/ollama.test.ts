import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Pedido } from '../conversa.ts';
import { criarMotorOllama } from './ollama.ts';

const pedido = (modelo = 'qwen2.5:3b'): Pedido => ({
  id: 't1',
  conversa: 'c1',
  diagrama: 'd',
  tipo: 'fala',
  persona: { id: 'n1', nome: 'Otimista', prompt: 'p', motor: 'ollama', modelo, esforco: 'medium', papel: 'debatedora', cor: '#000000', ferramentas: [], inicio: false, saida: false, arquivo: 'saida.md', humana: false, aoVencer: 'seguir', memoria: false, escuta: 'todas', quando: 'rodada', limite: 4000, resumoPara: 'todas', curadoria: false },
  system: 'Você é a Otimista.',
  contexto: 'Assunto: x',
  respondendoA: [],
  delegaveis: [],
  signal: new AbortController().signal,
});

let server: http.Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

/** Ollama falso: /api/tags e /api/chat em NDJSON, contando pedidos simultâneos. */
async function ollamaFalso() {
  const corpos: any[] = [];
  let ativos = 0;
  let pico = 0;
  server = http.createServer(async (req, res) => {
    if (req.url === '/api/tags') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:3b' }, { name: 'llama3.2:3b' }] }));
    }
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    corpos.push(body);
    if (body.model === 'nao-baixado') {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: `model "${body.model}" not found, try pulling it first` }));
    }
    ativos++;
    pico = Math.max(pico, ativos);
    res.setHeader('Content-Type', 'application/x-ndjson');
    for (const parte of ['Que ', 'ótima ', 'ideia!']) {
      res.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: parte }, done: false })}\n`);
      await new Promise((r) => setTimeout(r, 10));
    }
    res.end(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 42, eval_count: 7, eval_duration: 700_000_000 })}\n`);
    ativos--;
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, corpos, pico: () => pico };
}

describe('motor Ollama (local)', () => {
  it('conversa em streaming pelo /api/chat e conta tokens e velocidade', async () => {
    const f = await ollamaFalso();
    const motor = criarMotorOllama({ urls: [f.url] });
    const deltas: string[] = [];
    const r = await motor.atender(pedido(), (t) => deltas.push(t));
    expect(deltas).toEqual(['Que ', 'ótima ', 'ideia!']);
    expect(r.texto).toBe('Que ótima ideia!');
    expect(r.uso).toMatchObject({ entrada: 42, saida: 7, custo: 0, tokensPorSegundo: 10 });
    expect(f.corpos[0]).toMatchObject({
      model: 'qwen2.5:3b',
      stream: true,
      messages: [
        { role: 'system', content: 'Você é a Otimista.' },
        { role: 'user', content: 'Assunto: x' },
      ],
    });
  });

  it('atende um pedido por vez (CPU)', async () => {
    const f = await ollamaFalso();
    const motor = criarMotorOllama({ urls: [f.url] });
    await Promise.all([motor.atender(pedido(), () => {}), motor.atender(pedido(), () => {})]);
    expect(f.pico()).toBe(1);
  });

  it('lista os modelos, e explica modelo não baixado e Ollama fora do ar', async () => {
    const f = await ollamaFalso();
    const motor = criarMotorOllama({ urls: ['http://127.0.0.1:1', f.url] });
    expect(await motor.disponivel()).toMatchObject({ ok: true });
    expect(await motor.modelos()).toEqual(['qwen2.5:3b', 'llama3.2:3b']);
    await expect(motor.atender(pedido('nao-baixado'), () => {})).rejects.toThrow(/ollama pull nao-baixado/);

    const fora = criarMotorOllama({ urls: ['http://127.0.0.1:1'] });
    expect(await fora.disponivel()).toMatchObject({ ok: false, detalhe: expect.stringMatching(/Ollama/) });
    await expect(fora.atender(pedido(), () => {})).rejects.toThrow(/Ollama/);
  });
});
