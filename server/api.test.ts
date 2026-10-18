import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from './api';

let dir: string;
let server: http.Server;
let api: ReturnType<typeof createApi>;
let base: string;

async function start(file = path.join(dir, 'diagram.json')) {
  api = createApi(file);
  // Como no Vite, a API é montada em /api e recebe o caminho sem o prefixo.
  server = http.createServer((req, res) => {
    req.url = req.url!.replace(/^\/api/, '') || '/';
    api.handler(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

const call = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, rev: Number(res.headers.get('x-rev')), text, json };
};

const SAMPLE = `flowchart LR
    n1("Início")
    n2("Meio")
    n1 -->|"processa"| n2
%% @pos n1 100 100
%% @pos n2 300 100`;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mermaid-draw-'));
});

afterEach(async () => {
  api.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('API granular', () => {
  it('começa vazia e cria retângulos e setas um a um', async () => {
    await start();
    expect((await call('GET', '/diagram')).status).toBe(204);
    const a = await call('POST', '/nodes', { text: 'Início', x: 100, y: 100 });
    expect(a.status).toBe(201);
    expect(a.json).toEqual({ id: 'n1', text: 'Início', active: false, owner: null, x: 100, y: 100 });
    await call('POST', '/nodes', { text: 'Meio' });
    const e = await call('POST', '/edges', { from: 'Início', to: 'meio', text: 'processa' });
    expect(e.json).toEqual({ id: 'e1', from: 'n1', to: 'n2', text: 'processa' });
    const loop = await call('POST', '/edges', { from: 'n2', to: 'n2' });
    expect(loop.json).toMatchObject({ from: 'n2', to: 'n2' });
    expect(loop.rev).toBe(4);
    expect((await call('GET', '/diagram')).text).toContain('n2 --> n2');
  });

  it('PATCH altera só o retângulo pedido', async () => {
    await start();
    await call('PUT', '/diagram', SAMPLE);
    const before = (await call('GET', '/diagram.json')).json.diagram;
    const r = await call('PATCH', '/nodes/n1', { text: 'Começo' });
    expect(r.json).toEqual({ id: 'n1', text: 'Começo', active: false, owner: null, x: 100, y: 100 });
    const after = (await call('GET', '/diagram.json')).json.diagram;
    expect(after.nodes[1]).toEqual(before.nodes[1]);
    expect(after.edges).toEqual(before.edges);
    expect(after.nodes[0]).toEqual({ ...before.nodes[0], text: 'Começo' });
  });

  it('ativar/desativar/alternar continuam funcionando', async () => {
    await start();
    await call('PUT', '/diagram', SAMPLE);
    expect((await call('POST', '/nodes/Meio/ativar')).json.active).toBe(true);
    expect((await call('POST', '/nodes/n2/alternar')).json.active).toBe(false);
    expect((await call('PATCH', '/nodes/n2', { active: true })).json.active).toBe(true);
    expect((await call('GET', '/diagram')).text).toContain('class n2 ativo');
  });

  it('responsável: define, troca e remove, só naquele retângulo', async () => {
    await start();
    await call('PUT', '/diagram', SAMPLE);
    const r = await call('PATCH', '/nodes/Meio', { owner: '  Maria   Souza ', active: true });
    expect(r.json).toMatchObject({ id: 'n2', active: true, owner: 'Maria Souza' });
    expect((await call('GET', '/nodes/n1')).json.owner).toBeNull();
    expect((await call('GET', '/diagram')).text).toContain('n2("Meio<br/><small>👤 Maria Souza</small>")');
    expect((await call('PATCH', '/nodes/n2', { owner: 'João' })).json.owner).toBe('João');
    expect((await call('PATCH', '/nodes/n2', { owner: null })).json.owner).toBeNull();
    expect((await call('PATCH', '/nodes/n2', { owner: 'x' })).status).toBe(200);
    expect((await call('PATCH', '/nodes/n2', { owner: '' })).json.owner).toBeNull();
    expect((await call('GET', '/diagram')).text).not.toContain('👤');
    expect((await call('PATCH', '/nodes/n2', { owner: 42 })).status).toBe(400);
    expect((await call('PATCH', '/nodes/n2', { owner: 'x'.repeat(61) })).status).toBe(400);
    expect((await call('POST', '/nodes', { text: 'Novo', owner: 'Ana' })).json.owner).toBe('Ana');
  });

  it('PUT de código lê o responsável do texto do retângulo (e do comentário antigo)', async () => {
    await start();
    await call('PUT', '/diagram', SAMPLE.replace('n1("Início")', 'n1("Início<br/><small>👤 Ana Lima</small>")'));
    expect((await call('GET', '/nodes/n1')).json).toMatchObject({ text: 'Início', owner: 'Ana Lima' });
    await call('PUT', '/diagram', SAMPLE + '\n%% @owner n2 Bia');
    expect((await call('GET', '/nodes/n2')).json.owner).toBe('Bia');
    expect((await call('GET', '/diagram')).text).toContain('n2("Meio<br/><small>👤 Bia</small>")');
  });

  it('DELETE de retângulo remove as setas dele', async () => {
    await start();
    await call('PUT', '/diagram', SAMPLE);
    const r = await call('DELETE', '/nodes/n2');
    expect(r.json).toEqual({ type: 'node.removed', id: 'n2', edges: ['e1'] });
    expect((await call('GET', '/edges')).json).toEqual([]);
    expect((await call('DELETE', '/edges/e1')).status).toBe(404);
  });

  it('PUT de código mantém os ids das setas existentes', async () => {
    await start();
    await call('PUT', '/diagram', SAMPLE);
    await call('PATCH', '/edges/e1', { text: 'vai' });
    await call('PUT', '/diagram', SAMPLE + '\n    n2 --> n1');
    const edges = (await call('GET', '/edges')).json;
    expect(edges.map((e: { id: string }) => e.id)).toEqual(['e1', 'e2']);
  });

  it('erros: 400, 404, 409', async () => {
    await start();
    await call('PUT', '/diagram', SAMPLE);
    expect((await call('PATCH', '/nodes/n1', '{quebrado')).status).toBe(400);
    expect((await call('PATCH', '/nodes/n1', { cor: 'azul' })).status).toBe(400);
    expect((await call('PATCH', '/nodes/nada', { text: 'x' })).status).toBe(404);
    expect((await call('POST', '/edges', { from: 'n1', to: 'n2' })).status).toBe(409);
    expect((await call('POST', '/nodes', { id: 'n1' })).status).toBe(409);
    expect((await call('PATCH', '/nodes', {})).status).toBe(404);
  });

  it('persiste em JSON e migra o .mmd antigo', async () => {
    fs.writeFileSync(path.join(dir, 'diagram.mmd'), SAMPLE);
    await start();
    expect((await call('GET', '/nodes')).json.map((n: { text: string }) => n.text)).toEqual(['Início', 'Meio']);
    await call('POST', '/nodes/n1/ativar');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'diagram.json'), 'utf8'));
    expect(saved.rev).toBe(1);
    expect(saved.diagram.nodes[0]).toMatchObject({ id: 'n1', active: true });
  });

  it('seta animada e pulso: o pulso é só um evento, sem salvar nem subir o rev', async () => {
    await start();
    await call('PUT', '/diagram', SAMPLE);
    expect((await call('PATCH', '/edges/e1', { animated: true })).json).toMatchObject({ id: 'e1', animated: true });
    expect((await call('GET', '/diagram')).text).toContain('e1@{ animate: true }');
    const rev = (await call('GET', '/diagram.json')).json.rev;

    const ctrl = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const next = async () => {
      while (!buf.includes('\n\n')) buf += decoder.decode((await reader.read()).value);
      const [msg, ...rest] = buf.split('\n\n');
      buf = rest.join('\n\n');
      return JSON.parse(msg.replace(/^data: /, ''));
    };
    await next(); // snapshot
    expect((await call('POST', '/edges/e1/pulse', { label: 'pedido #42' })).status).toBe(204);
    expect(await next()).toEqual({ type: 'edge.pulse', id: 'e1', label: 'pedido #42', source: 'api' });
    ctrl.abort();

    expect((await call('GET', '/diagram.json')).json.rev).toBe(rev);
    expect((await call('POST', '/edges/e9/pulse')).status).toBe(404);
    expect((await call('POST', '/edges/e1/pulse', { label: 7 })).status).toBe(400);
  });

  it('SSE: snapshot ao conectar e depois só o evento de cada mudança', async () => {
    await start();
    await call('PUT', '/diagram', SAMPLE);
    const ctrl = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const next = async () => {
      while (!buf.includes('\n\n')) buf += decoder.decode((await reader.read()).value);
      const [msg, ...rest] = buf.split('\n\n');
      buf = rest.join('\n\n');
      return JSON.parse(msg.replace(/^data: /, ''));
    };
    expect(await next()).toMatchObject({ type: 'snapshot', rev: 1 });
    await fetch(`${base}/nodes/n2`, {
      method: 'PATCH',
      headers: { 'X-Client-Id': 'aba-1' },
      body: JSON.stringify({ x: 333 }),
    });
    expect(await next()).toEqual({
      type: 'node.updated',
      node: { id: 'n2', text: 'Meio', x: 333, y: 100 },
      rev: 2,
      source: 'aba-1',
    });
    ctrl.abort();
  });
});
