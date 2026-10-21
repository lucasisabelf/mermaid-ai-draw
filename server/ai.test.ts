import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Motor } from './conversa.ts';
import { createDiagrams } from './diagrams.ts';

const TEMPLATES = path.join(import.meta.dirname, '..', 'templates');

let dir: string;
let server: http.Server;
let ws: ReturnType<typeof createDiagrams>;
let base: string;
let mcpClients: Client[] = [];

/** Motor que responde na hora (para os papéis em Ollama/API nos testes). */
const pronto = (nome: 'ollama' | 'api'): Motor => ({
  nome,
  disponivel: async () => ({ ok: true, detalhe: `${nome} falso` }),
  atender: async (p, delta) => {
    delta('…');
    return { texto: `${p.persona.nome} (${nome})` };
  },
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-'));
  ws = createDiagrams(dir, { templatesDir: TEMPLATES, motores: { ollama: pronto('ollama'), api: pronto('api') } });
  server = http.createServer((req, res) => {
    const fim = () => {
      res.statusCode = 404;
      res.end();
    };
    if (req.url!.startsWith('/mcp')) return ws.mcpHandler(req, res, fim);
    req.url = req.url!.replace(/^\/api/, '') || '/';
    ws.handler(req, res, fim);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of mcpClients) await c.close();
  mcpClients = [];
  ws.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`${base}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
};

/** Cria um diagrama com personas dos templates e as setas dadas ("a>b"). */
async function montar(nome: string, personas: [string, string][], setas: string[]) {
  const slug = (await call('POST', '/diagrams', { name: nome })).json.slug as string;
  const ids: string[] = [];
  for (const [i, [template, motor]] of personas.entries()) {
    const r = await call('POST', `/d/${slug}/templates/${template}`, { motor, x: 100 + i * 220, y: 120 });
    expect(r.status, r.text).toBe(201);
    ids.push(r.json.node.id);
  }
  for (const s of setas) {
    const [a, b] = s.split('>').map(Number);
    await call('POST', `/d/${slug}/edges`, { from: ids[a], to: ids[b] });
  }
  return { slug, ids };
}

async function conectarMcp() {
  const client = new Client({ name: 'teste-claude-code', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  mcpClients.push(client);
  const ferramenta = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
    const text = r.content.map((c) => c.text).join('');
    if (r.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { client, ferramenta };
}

describe('personas e templates pela API', () => {
  it('lista os templates por motor, cria o retângulo com a persona e edita o .md', async () => {
    const t = await call('GET', '/templates');
    expect(t.status).toBe(200);
    expect(t.json.motores.map((m: any) => m.nome)).toEqual(['mcp', 'ollama', 'api']);
    expect(t.json.papeis.map((p: any) => p.nome)).toContain('cetica');

    const slug = (await call('POST', '/diagrams', { name: 'Debate' })).json.slug;
    const r = await call('POST', `/d/${slug}/templates/cetica`, { motor: 'ollama', x: 300, y: 200 });
    expect(r.status).toBe(201);
    expect(r.json.node).toMatchObject({ text: 'Cética', x: 300, y: 200 });
    expect(r.json.persona).toMatchObject({ nome: 'Cética', motor: 'ollama', modelo: 'qwen2.5:3b', papel: 'debatedora' });
    const id = r.json.node.id;
    expect(fs.existsSync(path.join(dir, slug, 'personas', `${id}.md`))).toBe(true);
    expect((await call('POST', `/d/${slug}/templates/nada`, {})).status).toBe(404);
    expect((await call('POST', `/d/${slug}/templates/cetica`, { motor: 'gpt' })).status).toBe(400);

    const get = await call('GET', `/d/${slug}/personas/${id}`);
    expect(get.json.markdown).toContain('motor: ollama');
    const md = get.json.markdown.replace('motor: ollama', 'motor: api').replace('modelo: qwen2.5:3b', 'modelo: claude-sonnet-5-5');
    const put = await call('PUT', `/d/${slug}/personas/${id}`, md);
    expect(put.status, put.text).toBe(200);
    expect(put.json.persona).toMatchObject({ motor: 'api', modelo: 'claude-sonnet-5-5' });
    expect((await call('PUT', `/d/${slug}/personas/${id}`, md.replace('motor: api', 'motor: gpt'))).status).toBe(400);
    expect((await call('GET', `/d/${slug}/personas`)).json.map((p: any) => p.id)).toEqual([id]);

    // Apagar o retângulo guarda a persona em .removidos/; o .zip exportado leva as personas.
    const n2 = (await call('POST', `/d/${slug}/templates/otimista`, { motor: 'mcp' })).json.node.id;
    const zip = await fetch(`${base}/api/diagrams/${slug}/export`).then((x) => x.arrayBuffer());
    const files = unzipSync(new Uint8Array(zip));
    expect(Object.keys(files).sort()).toEqual(['diagram.json', 'diagram.mmd', 'meta.json', `personas/${id}.md`, `personas/${n2}.md`].sort());
    const imp = await fetch(`${base}/api/diagrams/import?name=Copia`, { method: 'POST', body: Buffer.from(zip) }).then((x) => x.json());
    expect(fs.readFileSync(path.join(dir, imp.slug, 'personas', `${id}.md`), 'utf8')).toContain('motor: api');
    await call('DELETE', `/d/${slug}/nodes/${n2}`);
    expect(fs.existsSync(path.join(dir, slug, 'personas', `${n2}.md`))).toBe(false);
    expect(fs.readdirSync(path.join(dir, slug, 'personas', '.removidos'))).toHaveLength(1);
    // Um zip com caminho malicioso nas personas não escreve fora da pasta.
    expect(strFromU8(files[`personas/${id}.md`])).toContain('# ');
  });

  it('persona de saída: template separado, arquivo para baixar no fim, e o zip leva o template', async () => {
    const { slug, ids } = await montar('Saída', [['otimista', 'ollama'], ['redatora', 'ollama']], ['0>1']);
    const [a, s] = ids;
    const md = (await call('GET', `/d/${slug}/personas/${s}`)).json.markdown as string;
    const put = await call('PUT', `/d/${slug}/personas/${s}`, md.replace('```yaml\n', '```yaml\nsaida: true\narquivo: README.md\n'));
    expect(put.json.persona).toMatchObject({ saida: true, arquivo: 'README.md' });

    // O template se lê e grava à parte (texto puro), sem mexer no .md da persona.
    const padrao = await call('GET', `/d/${slug}/personas/${s}/saida`);
    expect(padrao.status).toBe(200);
    expect(padrao.json).toMatchObject({ arquivo: 'README.md', padrao: true });
    expect(padrao.json.template).toContain('#');
    const antes = fs.readFileSync(path.join(dir, slug, 'personas', `${s}.md`), 'utf8');
    expect((await call('PUT', `/d/${slug}/personas/${s}/saida`, '# {{nome do app}}\n\n## Visão\n')).status).toBe(200);
    expect((await call('GET', `/d/${slug}/personas/${s}/saida`)).json).toMatchObject({ template: '# {{nome do app}}\n\n## Visão\n', padrao: false });
    expect(fs.readFileSync(path.join(dir, slug, 'personas', `${s}.md`), 'utf8')).toBe(antes);
    expect((await call('PUT', `/d/${slug}/personas/${s}/saida`, '')).status).toBe(400);

    // A conversa: a Otimista fala, a saída roda no fim e o arquivo fica para baixar.
    const id = (await call('POST', `/d/${slug}/conversas`, { assunto: 'Lançar o app', modo: 'debate', rodadas: 1 })).json.id;
    for (let i = 0; i < 50 && (await call('GET', `/d/${slug}/conversas/${id}`)).json.status !== 'terminada'; i++) await new Promise((x) => setTimeout(x, 20));
    const fim = (await call('GET', `/d/${slug}/conversas/${id}`)).json;
    expect(fim.mensagens.map((m: any) => `${m.nome}:${m.tipo}`)).toEqual(['Você:usuario', 'Otimista:fala', 'Redatora:saida']);
    const arq = await fetch(`${base}/api/d/${slug}/conversas/${id}/saidas/README.md`);
    expect(arq.status).toBe(200);
    expect(arq.headers.get('content-type')).toMatch(/text\/markdown/);
    expect(arq.headers.get('content-disposition')).toContain('README.md');
    expect(await arq.text()).toBe('Redatora (ollama)\n');
    expect(fs.existsSync(path.join(dir, slug, 'saidas', id, 'README.md'))).toBe(true);
    expect((await call('GET', `/d/${slug}/conversas/${id}/saidas/nada.md`)).status).toBe(404);
    expect((await call('GET', `/d/${slug}/conversas/${id}/saidas/..%2Fx.md`)).status).toBe(404);

    // Exportar, importar e duplicar levam o template.
    const zip = await fetch(`${base}/api/diagrams/${slug}/export`).then((x) => x.arrayBuffer());
    const files = unzipSync(new Uint8Array(zip));
    expect(strFromU8(files[`personas/${s}.saida.md`])).toBe('# {{nome do app}}\n\n## Visão\n');
    expect(files[`personas/${a}.saida.md`]).toBeUndefined();
    const imp = await fetch(`${base}/api/diagrams/import?name=Copia`, { method: 'POST', body: Buffer.from(zip) }).then((x) => x.json());
    expect(fs.readFileSync(path.join(dir, imp.slug, 'personas', `${s}.saida.md`), 'utf8')).toBe('# {{nome do app}}\n\n## Visão\n');
    const dup = (await call('POST', `/diagrams/${slug}/duplicate`)).json.slug;
    expect(fs.existsSync(path.join(dir, dup, 'personas', `${s}.saida.md`))).toBe(true);
  });

  it('persona humana: a conversa espera, o MCP não pega a vez e a resposta vem pela API', async () => {
    const { slug, ids } = await montar('Humana', [['otimista', 'ollama'], ['moderadora', 'ollama'], ['cetica', 'ollama']], ['0>1', '1>2']);
    const h = ids[1];
    const md = (await call('GET', `/d/${slug}/personas/${h}`)).json.markdown as string;
    expect((await call('PUT', `/d/${slug}/personas/${h}`, md.replace('```yaml\n', '```yaml\nhumana: true\n'))).json.persona.humana).toBe(true);

    const id = (await call('POST', `/d/${slug}/conversas`, { assunto: 'Lançar?', modo: 'debate', rodadas: 1 })).json.id;
    for (let i = 0; i < 50 && (await call('GET', `/d/${slug}/conversas/${id}`)).json.status !== 'aguardando'; i++) await new Promise((x) => setTimeout(x, 20));
    const parada = (await call('GET', `/d/${slug}/conversas/${id}`)).json;
    expect(parada).toMatchObject({ status: 'aguardando', espera: { persona: h, nome: 'Moderadora' } });
    expect((await call('GET', `/d/${slug}/conversas`)).json[0].status).toBe('aguardando');

    // O Claude Code (MCP) não recebe a vez humana.
    const { ferramenta } = await conectarMcp();
    expect((await ferramenta('proxima_vez', { diagrama: slug, aguardar_s: 0 })).turnos).toEqual([]);
    expect((await ferramenta('ver_personas', { diagrama: slug })).personas.find((p: any) => p.id === h).humana).toBe(true);

    expect((await call('POST', `/d/${slug}/conversas/${id}/humano`, { acao: 'festa' })).status).toBe(400);
    expect((await call('POST', `/d/${slug}/conversas/${id}/humano`, { acao: 'aprovar', texto: 'siga' })).status).toBe(202);
    for (let i = 0; i < 50 && (await call('GET', `/d/${slug}/conversas/${id}`)).json.status !== 'terminada'; i++) await new Promise((x) => setTimeout(x, 20));
    const fim = (await call('GET', `/d/${slug}/conversas/${id}`)).json;
    expect(fim.mensagens.map((m: any) => `${m.nome}:${m.tipo}`)).toEqual(['Você:usuario', 'Otimista:fala', 'Moderadora:fala', 'Cética:fala']);
    expect(fim.mensagens[2].texto).toBe('Aprovado. siga');
    expect((await call('POST', `/d/${slug}/conversas/${id}/humano`, { acao: 'aprovar' })).status).toBe(409);
  });

  it('pós-fluxo: a saída de um diagrama inicia a conversa de outro, com os links entre elas', async () => {
    const destino = await montar('Plano', [['otimista', 'ollama']], []);
    const { slug, ids } = await montar('Discovery', [['otimista', 'ollama'], ['redatora', 'ollama']], ['0>1']);
    const md = (await call('GET', `/d/${slug}/personas/${ids[1]}`)).json.markdown as string;
    const yaml = `saida: true\narquivo: README.md\ndepois:\n  diagrama: ${destino.slug}\n  modo: debate\n  rodadas: 1\n`;
    expect((await call('PUT', `/d/${slug}/personas/${ids[1]}`, md.replace('```yaml\n', '```yaml\n' + yaml))).status).toBe(200);

    const id = (await call('POST', `/d/${slug}/conversas`, { assunto: 'Lançar o app', modo: 'debate', rodadas: 1 })).json.id;
    for (let i = 0; i < 50 && (await call('GET', `/d/${slug}/conversas/${id}`)).json.status !== 'terminada'; i++) await new Promise((x) => setTimeout(x, 20));
    const link = (await call('GET', `/d/${slug}/conversas/${id}`)).json.mensagens.at(-1).link;
    expect(link.diagrama).toBe(destino.slug);

    for (let i = 0; i < 50 && (await call('GET', `/d/${destino.slug}/conversas/${link.conversa}`)).json.status !== 'terminada'; i++) await new Promise((x) => setTimeout(x, 20));
    const outra = (await call('GET', `/d/${destino.slug}/conversas/${link.conversa}`)).json;
    expect(outra.assunto).toBe('Redatora (ollama)');
    expect(outra.origem).toEqual({ diagrama: slug, conversa: id });
    expect(outra.mensagens.map((m: any) => `${m.nome}:${m.tipo}`)).toEqual(['Você:usuario', 'Conversa:sistema', 'Otimista:fala']);
  });

  it('persona de memória: escuta a conversa e grava o memoria.md do diagrama', async () => {
    const { slug, ids } = await montar('Memória', [['otimista', 'ollama'], ['cetica', 'ollama'], ['moderadora', 'ollama']], ['0>1']);
    const md = (await call('GET', `/d/${slug}/personas/${ids[2]}`)).json.markdown as string;
    expect((await call('PUT', `/d/${slug}/personas/${ids[2]}`, md.replace('```yaml\n', '```yaml\nmemoria: true\nescuta: [' + ids[0] + ']\n'))).json.persona).toMatchObject({ memoria: true, escuta: [ids[0]] });
    const id = (await call('POST', `/d/${slug}/conversas`, { assunto: 'Lançar?', modo: 'debate', rodadas: 1 })).json.id;
    for (let i = 0; i < 50 && (await call('GET', `/d/${slug}/conversas/${id}`)).json.status !== 'terminada'; i++) await new Promise((x) => setTimeout(x, 20));
    const fim = (await call('GET', `/d/${slug}/conversas/${id}`)).json;
    expect(fim.mensagens.map((m: any) => `${m.nome}:${m.tipo}`)).toEqual(['Você:usuario', 'Otimista:fala', 'Cética:fala', 'Moderadora:memoria']);
    expect(fs.readFileSync(path.join(dir, slug, 'memoria.md'), 'utf8')).toBe('Moderadora (ollama)\n');

    // O Claude Code consulta a memória pelo MCP (busca por palavras, sem LLM).
    fs.writeFileSync(path.join(dir, slug, 'memoria.md'), '# Memória\n\n## Fatos\n- Aluguel no centro é caro (Cética · c1)\n');
    const { ferramenta } = await conectarMcp();
    expect(await ferramenta('recordar', { diagrama: slug, pergunta: 'aluguel' })).toEqual({ itens: [{ sala: 'Fatos', texto: 'Aluguel no centro é caro (Cética · c1)' }] });
  });

  it('palácio: ler, editar e zerar a memória, histórico, decidir proposta e zip só com ?memoria=1', async () => {
    const { slug, ids } = await montar('Palácio', [['otimista', 'ollama'], ['moderadora', 'ollama']], []);
    const md = (await call('GET', `/d/${slug}/personas/${ids[1]}`)).json.markdown as string;
    await call('PUT', `/d/${slug}/personas/${ids[1]}`, md.replace('```yaml\n', '```yaml\nmemoria: true\ncuradoria: true\n'));

    // Sem memória ainda: o modelo das salas.
    const vazia = (await call('GET', `/d/${slug}/memoria`)).json;
    expect(vazia).toMatchObject({ existe: false, itens: 0 });
    expect(vazia.md).toContain('## Decisões');

    // Editar à mão grava o memoria.md e um snapshot no histórico.
    expect((await call('PUT', `/d/${slug}/memoria`, '# Memória\n\n## Fatos\n- aluguel caro (C · c0)\n')).status).toBe(200);
    expect((await call('GET', `/d/${slug}/memoria`)).json).toMatchObject({ existe: true, itens: 1 });
    const hist = (await call('GET', `/d/${slug}/memoria/historico`)).json;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ conversa: 'manual', itens: 1 });
    expect((await call('GET', `/d/${slug}/memoria/historico/${hist[0].id}`)).text).toContain('aluguel caro');
    expect((await call('GET', `/d/${slug}/memoria/historico/..%2Fx`)).status).toBe(404);
    expect((await call('PUT', `/d/${slug}/memoria`, '   ')).status).toBe(400);

    // Curadoria: a conversa propõe; a rota aceita.
    const id = (await call('POST', `/d/${slug}/conversas`, { assunto: 'x', modo: 'debate', rodadas: 1 })).json.id;
    for (let i = 0; i < 50 && (await call('GET', `/d/${slug}/conversas/${id}`)).json.status !== 'terminada'; i++) await new Promise((x) => setTimeout(x, 20));
    const prop = (await call('GET', `/d/${slug}/conversas/${id}`)).json.mensagens.at(-1);
    expect(prop).toMatchObject({ tipo: 'memoria', proposta: 'Moderadora (ollama)' });
    expect((await call('GET', `/d/${slug}/memoria`)).json.md).toContain('aluguel caro');
    expect((await call('POST', `/d/${slug}/conversas/${id}/memoria`, { mensagem: prop.id, acao: 'aceitar' })).status).toBe(200);
    expect((await call('GET', `/d/${slug}/memoria`)).json.md).toBe('Moderadora (ollama)\n');
    expect((await call('GET', `/d/${slug}/memoria/historico`)).json).toHaveLength(2);
    expect((await call('POST', `/d/${slug}/conversas/${id}/memoria`, { mensagem: prop.id, acao: 'aceitar' })).status).toBe(409);

    // O zip só leva a memória com ?memoria=1; o import lê; duplicar não copia.
    const zipSem = await fetch(`${base}/api/diagrams/${slug}/export`).then((x) => x.arrayBuffer());
    const semMem = unzipSync(new Uint8Array(zipSem));
    expect(semMem['memoria.md']).toBeUndefined();
    const comMem = await fetch(`${base}/api/diagrams/${slug}/export?memoria=1`).then((x) => x.arrayBuffer());
    expect(strFromU8(unzipSync(new Uint8Array(comMem))['memoria.md'])).toBe('Moderadora (ollama)\n');
    const imp = await fetch(`${base}/api/diagrams/import?name=Copia`, { method: 'POST', body: Buffer.from(comMem) }).then((x) => x.json());
    expect((await call('GET', `/d/${imp.slug}/memoria`)).json.md).toBe('Moderadora (ollama)\n');
    const dup = (await call('POST', `/diagrams/${slug}/duplicate`)).json.slug;
    expect((await call('GET', `/d/${dup}/memoria`)).json.existe).toBe(false);

    // Zerar: some (vai para .removidos/).
    expect((await call('DELETE', `/d/${slug}/memoria`)).status).toBe(200);
    expect((await call('GET', `/d/${slug}/memoria`)).json.existe).toBe(false);
  });

  it('paleta: as personas especiais (memória, você, saída) vêm à parte e nascem já configuradas', async () => {
    const t = (await call('GET', '/templates')).json;
    expect(t.especiais.map((e: any) => e.nome).sort()).toEqual(['memoria', 'saida-readme', 'voce']);
    expect(t.papeis.map((p: any) => p.nome)).not.toContain('memoria');
    const slug = (await call('POST', '/diagrams', { name: 'Especiais' })).json.slug;
    const mem = (await call('POST', `/d/${slug}/templates/memoria`, { motor: 'ollama' })).json;
    expect(mem.persona).toMatchObject({ memoria: true, motor: 'ollama', nome: 'Memória' });
    const eu = (await call('POST', `/d/${slug}/templates/voce`, {})).json;
    expect(eu.persona).toMatchObject({ humana: true });
    const rd = (await call('POST', `/d/${slug}/templates/saida-readme`, { motor: 'mcp' })).json;
    expect(rd.persona).toMatchObject({ saida: true, arquivo: 'README.md' });
    const tpl = (await call('GET', `/d/${slug}/personas/${rd.node.id}/saida`)).json;
    expect(tpl.padrao).toBe(false);
    expect(tpl.template).toContain('# {{');
  });

  it('mostra o status dos motores', async () => {
    const r = await call('GET', '/motores');
    expect(r.json.map((m: any) => [m.nome, m.ok])).toEqual([
      ['mcp', false],
      ['ollama', true],
      ['api', true],
    ]);
    expect(r.json[0].detalhe).toMatch(/Claude Code/);
  });
});

describe('conversa pela API, com eventos para o navegador', () => {
  it('debate com personas em Ollama e API, intervenção e lista de conversas', async () => {
    const { slug, ids } = await montar('Debate', [['otimista', 'ollama'], ['cetica', 'api'], ['moderadora', 'api']], ['0>1', '1>2']);
    const eventos: any[] = [];
    const ctrl = new AbortController();
    const sse = fetch(`${base}/api/d/${slug}/events`, { signal: ctrl.signal }).then(async (res) => {
      const reader = res.body!.getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) break;
        buf += new TextDecoder().decode(value);
        for (const bloco of buf.split('\n\n').slice(0, -1)) eventos.push(JSON.parse(bloco.replace(/^data: /, '')));
        buf = buf.split('\n\n').at(-1)!;
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const r = await call('POST', `/d/${slug}/conversas`, { assunto: 'Abrir uma cafeteria?', modo: 'resposta', rodadas: 1 });
    expect(r.status, r.text).toBe(201);
    const id = r.json.id;
    for (let i = 0; i < 50 && (await call('GET', `/d/${slug}/conversas/${id}`)).json.status !== 'terminada'; i++) await new Promise((x) => setTimeout(x, 20));
    const fim = (await call('GET', `/d/${slug}/conversas/${id}`)).json;
    expect(fim.mensagens.map((m: any) => `${m.nome}:${m.tipo}`)).toEqual(['Você:usuario', 'Otimista:fala', 'Cética:fala', 'Moderadora:fala', 'Moderadora:sintese']);
    expect(fim.resposta).toBe('Moderadora (api)');

    // Intervenção depois do fim: a mencionada responde.
    expect((await call('POST', `/d/${slug}/conversas/${id}/mensagens`, { texto: '@Cética, e o aluguel?' })).status).toBe(202);
    for (let i = 0; i < 50 && (await call('GET', `/d/${slug}/conversas/${id}`)).json.mensagens.length < 7; i++) await new Promise((x) => setTimeout(x, 20));
    expect((await call('GET', `/d/${slug}/conversas/${id}`)).json.mensagens.slice(-1)[0]).toMatchObject({ nome: 'Cética', persona: ids[1] });

    expect((await call('GET', `/d/${slug}/conversas`)).json.map((c: any) => c.id)).toEqual([id]);
    expect((await call('POST', `/d/${slug}/conversas`, { assunto: '' })).status).toBe(400);
    expect((await call('POST', `/d/${slug}/conversas`, { assunto: 'x', modo: 'festa' })).status).toBe(400);
    expect((await call('GET', `/d/${slug}/conversas/nada`)).status).toBe(404);

    ctrl.abort();
    await sse;
    const tipos = new Set(eventos.map((e) => e.type));
    for (const t of ['chat.inicio', 'chat.turno', 'chat.delta', 'chat.mensagem', 'chat.fim']) expect(tipos.has(t), t).toBe(true);
  });

  it('diagrama sem retângulos não começa conversa', async () => {
    const slug = (await call('POST', '/diagrams', { name: 'Vazio' })).json.slug;
    const r = await call('POST', `/d/${slug}/conversas`, { assunto: 'x' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/persona/);
  });
});

describe('MCP: o Claude Code dá voz às personas', () => {
  it('lista, inicia o debate daqui, pega cada vez e responde até a síntese', async () => {
    const { slug, ids } = await montar('Cafeteria', [['otimista', 'mcp'], ['cetica', 'mcp'], ['moderadora', 'mcp']], ['0>1', '1>2']);
    const { client, ferramenta } = await conectarMcp();
    const nomes = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(nomes).toEqual(['iniciar_conversa', 'listar_diagramas', 'parar', 'proxima_vez', 'recordar', 'responder', 'sintetizar', 'ver_conversa', 'ver_personas'].sort());

    expect((await ferramenta('listar_diagramas')).map((d: any) => d.slug)).toContain(slug);
    const personas = await ferramenta('ver_personas', { diagrama: slug });
    expect(personas.personas.map((p: any) => [p.nome, p.motor])).toEqual([
      ['Otimista', 'mcp'],
      ['Cética', 'mcp'],
      ['Moderadora', 'mcp'],
    ]);
    expect(personas.setas).toEqual(['Otimista → Cética', 'Cética → Moderadora']);
    // O motor MCP passa a aparecer como conectado.
    expect((await call('GET', '/motores')).json[0]).toMatchObject({ nome: 'mcp', ok: true });

    const c = await ferramenta('iniciar_conversa', { diagrama: slug, assunto: 'Vale abrir uma cafeteria?', modo: 'resposta', rodadas: 1 });
    expect(c.ordem).toEqual(['Otimista', 'Cética', 'Moderadora']);

    const vistos: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { turnos } = await ferramenta('proxima_vez', { diagrama: slug, aguardar_s: 2 });
      expect(turnos).toHaveLength(1);
      const t = turnos[0];
      vistos.push(`${t.persona.nome}:${t.tipo}`);
      expect(t.system).toContain(t.persona.nome);
      expect(t.contexto).toContain('Vale abrir uma cafeteria?');
      expect(t.persona.modelo).toBe('claude-opus-5-5');
      await ferramenta('responder', { turno: t.turno, texto: `${t.persona.nome} diz ${i}` });
    }
    expect(vistos).toEqual(['Otimista:fala', 'Cética:fala', 'Moderadora:fala', 'Moderadora:sintese']);

    const conversa = await ferramenta('ver_conversa', { diagrama: slug, conversa: c.conversa });
    for (let i = 0; i < 20 && conversa.status !== 'terminada'; i++) Object.assign(conversa, await ferramenta('ver_conversa', { diagrama: slug, conversa: c.conversa }));
    expect(conversa.status).toBe('terminada');
    expect(conversa.resposta).toBe('Moderadora diz 3');
    expect(conversa.mensagens.find((m: any) => m.nome === 'Cética').persona).toBe(ids[1]);

    // Nada pendente: proxima_vez espera um pouco e volta vazio.
    const t0 = Date.now();
    expect((await ferramenta('proxima_vez', { aguardar_s: 0.2 })).turnos).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    await expect(ferramenta('responder', { turno: 'nao-existe', texto: 'x' })).rejects.toThrow(/turno/i);
  });

  it('tarefa: delegações em paralelo (MCP e Ollama misturados) e consolidação', async () => {
    const { slug } = await montar('Lançamento', [['orquestradora', 'mcp'], ['pesquisadora', 'mcp'], ['redatora', 'mcp'], ['revisora', 'ollama']], ['0>1', '0>2', '0>3']);
    const { ferramenta } = await conectarMcp();
    const c = await ferramenta('iniciar_conversa', { diagrama: slug, assunto: 'Lançar o app', modo: 'tarefa' });

    const [plano] = (await ferramenta('proxima_vez', { diagrama: slug, aguardar_s: 2 })).turnos;
    expect(plano).toMatchObject({ tipo: 'tarefa', persona: { nome: 'Orquestradora' } });
    expect(plano.delegaveis).toEqual(['Pesquisadora', 'Redatora', 'Revisora']);
    await ferramenta('responder', {
      turno: plano.turno,
      texto: 'Divido em três.',
      delegacoes: [
        { para: 'Pesquisadora', tarefa: 'pesquise o público' },
        { para: 'Redatora', tarefa: 'escreva o anúncio' },
        { para: 'Revisora', tarefa: 'revise o tom' },
      ],
    });

    // As duas delegadas no MCP chegam juntas (dá para atender com subagentes em paralelo);
    // a Revisora roda sozinha no Ollama.
    let pendentes: any[] = [];
    for (let i = 0; i < 20 && pendentes.length < 2; i++) pendentes = (await ferramenta('proxima_vez', { diagrama: slug, aguardar_s: 1 })).turnos;
    expect(pendentes.map((t: any) => `${t.persona.nome}:${t.tipo}`).sort()).toEqual(['Pesquisadora:execucao', 'Redatora:execucao']);
    expect(pendentes[0].contexto).toMatch(/pesquise o público|escreva o anúncio/);
    await Promise.all(pendentes.map((t: any) => ferramenta('responder', { turno: t.turno, texto: `${t.persona.nome} pronto` })));

    const [consolidar] = (await ferramenta('proxima_vez', { diagrama: slug, aguardar_s: 2 })).turnos;
    expect(consolidar).toMatchObject({ tipo: 'consolidar', persona: { nome: 'Orquestradora' } });
    expect(consolidar.contexto).toContain('Revisora (ollama)');
    expect(consolidar.contexto).toContain('Pesquisadora pronto');
    await ferramenta('responder', { turno: consolidar.turno, texto: 'Plano de lançamento final.' });

    let fim: any;
    for (let i = 0; i < 20 && fim?.status !== 'terminada'; i++) fim = await ferramenta('ver_conversa', { diagrama: slug, conversa: c.conversa });
    expect(fim.resposta).toBe('Plano de lançamento final.');
    expect(fim.mensagens.filter((m: any) => m.tipo === 'resultado')).toHaveLength(3);
  });

  it('parar e sintetizar pelo MCP', async () => {
    const { slug } = await montar('Parar', [['otimista', 'mcp'], ['cetica', 'mcp']], ['0>1']);
    const { ferramenta } = await conectarMcp();
    const c = await ferramenta('iniciar_conversa', { diagrama: slug, assunto: 'x', rodadas: 3 });
    const [t] = (await ferramenta('proxima_vez', { diagrama: slug, aguardar_s: 2 })).turnos;
    await ferramenta('sintetizar', { diagrama: slug, conversa: c.conversa });
    await ferramenta('responder', { turno: t.turno, texto: 'primeira' });
    const [s] = (await ferramenta('proxima_vez', { diagrama: slug, aguardar_s: 2 })).turnos;
    expect(s).toMatchObject({ tipo: 'sintese', persona: { nome: 'Otimista' } });
    await ferramenta('parar', { diagrama: slug, conversa: c.conversa });
    // O turno parado sai da fila.
    expect((await ferramenta('proxima_vez', { diagrama: slug, aguardar_s: 0.2 })).turnos).toEqual([]);
    const fim = await ferramenta('ver_conversa', { diagrama: slug, conversa: c.conversa });
    expect(fim.status).toBe('parada');
  });
});
