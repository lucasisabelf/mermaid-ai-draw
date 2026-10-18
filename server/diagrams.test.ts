import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDiagrams, slugify } from './diagrams';

let dir: string;
let server: http.Server;
let diagrams: ReturnType<typeof createDiagrams>;
let base: string;

async function start(options: Parameters<typeof createDiagrams>[1] = {}) {
  diagrams = createDiagrams(path.join(dir, 'diagrams'), options);
  server = http.createServer((req, res) => {
    req.url = req.url!.replace(/^\/api/, '') || '/';
    diagrams.handler(req, res, () => {
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
    body: (body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit,
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(buf);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json, buf, headers: res.headers };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mermaid-draw-d-'));
});

afterEach(async () => {
  diagrams?.close();
  if (server?.listening) await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('vários diagramas', () => {
  it('slug sem acentos nem espaços', () => {
    expect(slugify('Fluxo de Vendas')).toBe('fluxo-de-vendas');
    expect(slugify('  Ação & Reação!! ')).toBe('acao-reacao');
    expect(slugify('')).toBe('diagrama');
  });

  it('começa com um diagrama vazio, ou com o diagram.json de antes', async () => {
    await start();
    expect((await call('GET', '/diagrams')).json.map((d: { slug: string }) => d.slug)).toEqual(['meu-diagrama']);
    diagrams.close();
    await new Promise((r) => server.close(r));

    fs.rmSync(path.join(dir, 'diagrams'), { recursive: true });
    const legacy = path.join(dir, 'diagram.json');
    fs.writeFileSync(legacy, JSON.stringify({ rev: 3, diagram: { nodes: [{ id: 'n1', text: 'Antigo', x: 1, y: 2 }], edges: [] } }));
    await start({ legacyFile: legacy });
    const list = (await call('GET', '/diagrams')).json;
    expect(list).toMatchObject([{ slug: 'diagrama', name: 'Diagrama', nodes: 1 }]);
    // As rotas antigas, sem prefixo, continuam valendo para o primeiro diagrama.
    expect((await call('GET', '/nodes')).json[0].text).toBe('Antigo');
  });

  it('cada diagrama tem a própria API em /d/:slug', async () => {
    await start();
    await call('POST', '/diagrams', { name: 'Vendas' });
    await call('POST', '/d/vendas/nodes', { text: 'Só aqui' });
    expect((await call('GET', '/d/vendas/nodes')).json).toHaveLength(1);
    expect((await call('GET', '/d/meu-diagrama/nodes')).json).toEqual([]);
    expect((await call('GET', '/d/nada/nodes')).status).toBe(404);
    expect((await call('GET', '/d/..%2F..%2Fetc/nodes')).status).toBe(404);
    expect((await call('GET', '/diagrams')).json.find((d: { slug: string }) => d.slug === 'vendas').nodes).toBe(1);
  });

  it('criar, renomear, duplicar e apagar', async () => {
    await start();
    expect((await call('POST', '/diagrams', { name: 'Fluxo de Vendas' })).json).toMatchObject({ slug: 'fluxo-de-vendas', name: 'Fluxo de Vendas' });
    expect((await call('POST', '/diagrams', { name: 'fluxo de vendas' })).json.slug).toBe('fluxo-de-vendas-2');
    expect((await call('POST', '/diagrams', { name: '  ' })).status).toBe(400);

    const renamed = await call('PATCH', '/diagrams/fluxo-de-vendas-2', { name: 'Onboarding' });
    expect(renamed.json).toMatchObject({ slug: 'onboarding', name: 'Onboarding' });
    expect(fs.existsSync(path.join(dir, 'diagrams', 'onboarding', 'diagram.json'))).toBe(true);

    await call('POST', '/d/onboarding/nodes', { text: 'Boas-vindas' });
    const copy = await call('POST', '/diagrams/onboarding/duplicate');
    expect(copy.json).toMatchObject({ slug: 'onboarding-copia', name: 'Onboarding (cópia)', nodes: 1 });

    expect((await call('DELETE', '/diagrams/onboarding-copia')).status).toBe(204);
    expect(fs.readdirSync(path.join(dir, 'diagrams', '.removidos'))).toHaveLength(1);
    expect((await call('DELETE', '/diagrams/onboarding-copia')).status).toBe(404);

    // Apagar o último cria um novo: nunca fica sem diagrama.
    for (const d of (await call('GET', '/diagrams')).json) await call('DELETE', `/diagrams/${d.slug}`);
    expect((await call('GET', '/diagrams')).json).toHaveLength(1);
  });

  it('exportar e importar (.zip e .mmd)', async () => {
    await start();
    await call('POST', '/d/meu-diagrama/nodes', { text: 'A', x: 10, y: 20 });
    await call('POST', '/d/meu-diagrama/nodes', { text: 'B' });
    await call('POST', '/d/meu-diagrama/edges', { from: 'A', to: 'B', text: 'vai' });

    const zip = await call('GET', '/diagrams/meu-diagrama/export');
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(Object.keys(unzipSync(zip.buf)).sort()).toEqual(['diagram.json', 'diagram.mmd', 'meta.json']);
    const imported = await call('POST', '/diagrams/import?name=Trazido', zip.buf);
    expect(imported.json).toMatchObject({ slug: 'trazido', nodes: 2, edges: 1 });
    expect((await call('GET', '/d/trazido/edges')).json[0]).toMatchObject({ text: 'vai' });

    const mmd = await call('GET', '/diagrams/meu-diagrama/export?format=mmd');
    expect(mmd.text).toContain('-->|"vai"|');
    expect((await call('POST', '/diagrams/import?name=Do código', mmd.text)).json).toMatchObject({ slug: 'do-codigo', nodes: 2 });

    expect((await call('POST', '/diagrams/import', 'isso não é mermaid')).status).toBe(400);
    expect((await call('POST', '/diagrams/import', zipSync({ 'leia-me.txt': strToU8('oi') }))).status).toBe(400);
    // Só diagram.json/diagram.mmd/meta.json são lidos: um caminho malicioso no zip nunca é gravado.
    const evil = zipSync({ '../../fora.txt': strToU8('x'), 'diagram.mmd': strToU8('flowchart LR\n    a("A")') });
    expect((await call('POST', '/diagrams/import', evil)).status).toBe(201);
    expect(fs.existsSync(path.join(dir, 'fora.txt'))).toBe(false);
  });

  it('SSE da lista: snapshot e a lista nova a cada mudança', async () => {
    await start();
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
    expect((await next()).diagrams).toHaveLength(1);
    await call('POST', '/diagrams', { name: 'Novo' });
    expect((await next()).diagrams.map((d: { name: string }) => d.name)).toEqual(['Meu diagrama', 'Novo']);
    ctrl.abort();
  });
});
