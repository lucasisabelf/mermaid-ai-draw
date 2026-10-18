import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { parseMermaid, toMermaid, type Diagram } from '../src/model.ts';
import * as ops from '../src/ops.ts';
import { OpError } from '../src/ops.ts';
import { createApi } from './api.ts';

/**
 * Vários diagramas, um por pasta, cada um com a própria API (a de api.ts):
 *
 *   diagrams/
 *     fluxo-de-vendas/  meta.json  diagram.json
 *     .removidos/       diagramas apagados
 *
 *   /api/d/:slug/...                    as rotas de um diagrama (nodes, edges, diagram, diagram.json, events)
 *   GET    /api/diagrams                lista [{slug, name, nodes, edges, updatedAt}]
 *   POST   /api/diagrams                cria {name}
 *   PATCH  /api/diagrams/:slug          renomeia {name} (troca o slug e a pasta)
 *   DELETE /api/diagrams/:slug          move para .removidos/
 *   POST   /api/diagrams/:slug/duplicate
 *   GET    /api/diagrams/:slug/export   .zip (meta.json + diagram.json + diagram.mmd); ?format=mmd baixa só o código
 *   POST   /api/diagrams/import?name=   cria a partir de um .zip exportado ou de um .mmd
 *   GET    /api/events                  Server-Sent Events: a lista a cada mudança
 *
 * As rotas antigas sem prefixo (/api/nodes, /api/diagram…) continuam valendo para o primeiro diagrama.
 */

const META = 'meta.json';
const TRASH = '.removidos';
const FIRST_NAME = 'Meu diagrama';
/** Limite do arquivo importado (.zip ou .mmd). */
export const MAX_IMPORT = 10 * 1024 * 1024;

type Meta = { name: string; createdAt: string };
type Api = ReturnType<typeof createApi>;

export interface DiagramItem {
  slug: string;
  name: string;
  nodes: number;
  edges: number;
  createdAt: string;
  updatedAt: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Nome da pasta: minúsculas, sem acento, palavras separadas por hífen. */
export function slugify(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return s || 'diagrama';
}

function fail(status: 400 | 404 | 409, message: string): never {
  throw new OpError(status, message);
}

export interface WorkspaceOptions {
  /** Diagrama de antes dos vários diagramas (um diagram.json solto): vira o primeiro, se ainda não há nenhum. */
  legacyFile?: string;
}

export function createDiagrams(dir: string, options: WorkspaceOptions = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const apis = new Map<string, Api>();
  const clients = new Set<ServerResponse>();

  const folder = (slug: string) => path.join(dir, slug);
  const isDiagram = (slug: string) =>
    SLUG_RE.test(slug) && [META, 'diagram.json', 'diagram.mmd'].some((f) => fs.existsSync(path.join(folder(slug), f)));
  const slugs = () =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isDiagram(e.name))
      .map((e) => e.name);

  const readMeta = (slug: string): Meta => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(folder(slug), META), 'utf8')) as Meta;
      if (meta.name) return meta;
    } catch {}
    const name = slug.replace(/-/g, ' ');
    return { name: name.charAt(0).toUpperCase() + name.slice(1), createdAt: fs.statSync(folder(slug)).birthtime.toISOString() };
  };
  const writeMeta = (slug: string, meta: Meta) => fs.writeFileSync(path.join(folder(slug), META), `${JSON.stringify(meta, null, 2)}\n`);

  /** Pasta livre para `name` (ignorando `except`, ao renomear). */
  const uniqueSlug = (name: string, except = '') => {
    const base = slugify(name);
    for (let i = 1; ; i++) {
      const slug = i === 1 ? base : `${base}-${i}`;
      if (slug === except || !fs.existsSync(folder(slug))) return slug;
    }
  };

  const writeDiagram = (slug: string, d: Diagram | null) =>
    fs.writeFileSync(path.join(folder(slug), 'diagram.json'), `${JSON.stringify({ rev: 0, diagram: d }, null, 2)}\n`);

  // ---- lista e avisos -------------------------------------------------------

  let notifyTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    const msg = `data: ${JSON.stringify({ type: 'diagrams', diagrams: list() })}\n\n`;
    for (const c of clients) c.write(msg);
  };
  /** Mudanças seguidas (ex.: arrastar um retângulo) viram um aviso só. */
  const notifySoon = () => {
    notifyTimer ??= setTimeout(() => {
      notifyTimer = undefined;
      notify();
    }, 300);
  };

  const api = (slug: string): Api => {
    let a = apis.get(slug);
    if (!a) {
      if (!isDiagram(slug)) fail(404, `Diagrama "${slug}" não encontrado.`);
      a = createApi(path.join(folder(slug), 'diagram.json'), { onChange: notifySoon });
      apis.set(slug, a);
    }
    return a;
  };

  const close = (slug: string) => {
    apis.get(slug)?.close();
    apis.delete(slug);
  };

  const list = (): DiagramItem[] =>
    slugs()
      .map((slug) => {
        const meta = readMeta(slug);
        let counts = { nodes: 0, edges: 0 };
        const loaded = apis.get(slug);
        if (loaded) counts = loaded.info();
        else {
          try {
            const d = JSON.parse(fs.readFileSync(path.join(folder(slug), 'diagram.json'), 'utf8')).diagram as Diagram | null;
            counts = { nodes: d?.nodes.length ?? 0, edges: d?.edges.length ?? 0 };
          } catch {}
        }
        let updatedAt = meta.createdAt;
        try {
          updatedAt = fs.statSync(path.join(folder(slug), 'diagram.json')).mtime.toISOString();
        } catch {}
        return { slug, name: meta.name, ...counts, createdAt: meta.createdAt, updatedAt };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));

  // ---- ações ----------------------------------------------------------------

  const create = (name: string, diagram: Diagram | null = { nodes: [], edges: [] }): DiagramItem => {
    name = name?.trim?.() ?? '';
    if (!name) fail(400, '"name" não pode ser vazio.');
    const slug = uniqueSlug(name);
    fs.mkdirSync(folder(slug), { recursive: true });
    writeMeta(slug, { name, createdAt: new Date().toISOString() });
    writeDiagram(slug, diagram);
    notify();
    return list().find((d) => d.slug === slug)!;
  };

  const rename = (slug: string, name: string): DiagramItem => {
    name = name?.trim?.() ?? '';
    if (!isDiagram(slug)) fail(404, `Diagrama "${slug}" não encontrado.`);
    if (!name) fail(400, '"name" não pode ser vazio.');
    const meta = readMeta(slug);
    const next = uniqueSlug(name, slug);
    if (next !== slug) {
      // As abas abertas no slug antigo são desconectadas e voltam pelo menu.
      close(slug);
      fs.renameSync(folder(slug), folder(next));
    }
    writeMeta(next, { ...meta, name });
    notify();
    return list().find((d) => d.slug === next)!;
  };

  const remove = (slug: string) => {
    if (!isDiagram(slug)) fail(404, `Diagrama "${slug}" não encontrado.`);
    close(slug);
    const trash = path.join(dir, TRASH);
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(folder(slug), path.join(trash, `${slug}-${Date.now()}`));
    // Nunca fica sem diagrama nenhum.
    if (!slugs().length) create(FIRST_NAME);
    notify();
  };

  /** O diagrama atual (da API, se aberto; senão do arquivo). */
  const current = (slug: string): Diagram => {
    if (!isDiagram(slug)) fail(404, `Diagrama "${slug}" não encontrado.`);
    const raw = JSON.parse(fs.readFileSync(path.join(folder(slug), 'diagram.json'), 'utf8'));
    return raw.diagram ? ops.buildDiagram(raw.diagram) : { nodes: [], edges: [] };
  };

  const duplicate = (slug: string) => create(`${readMeta(slug).name} (cópia)`, current(slug));

  const exportZip = (slug: string) => {
    const d = current(slug);
    const meta = readMeta(slug);
    return {
      name: meta.name,
      zip: zipSync({
        [META]: strToU8(`${JSON.stringify(meta, null, 2)}\n`),
        'diagram.json': strToU8(`${JSON.stringify({ rev: 0, diagram: d }, null, 2)}\n`),
        'diagram.mmd': strToU8(`${toMermaid(d)}\n`),
      }),
    };
  };

  /** Importa um .zip exportado (só meta.json, diagram.json e diagram.mmd são lidos) ou um .mmd. */
  const importFile = (name: string, data: Buffer): DiagramItem => {
    if (data.length > MAX_IMPORT) fail(400, `O arquivo passa do limite de ${MAX_IMPORT / 1024 / 1024} MB.`);
    const isZip = data[0] === 0x50 && data[1] === 0x4b;
    if (!isZip) {
      const { diagram, errors } = parseMermaid(data.toString('utf8'));
      if (errors.length) fail(400, `Código Mermaid inválido: ${errors.slice(0, 3).join(' · ')}`);
      return create(name || 'Importado', diagram);
    }

    let files: Record<string, Uint8Array>;
    try {
      // Só os arquivos que interessam são descompactados: nada do zip é gravado com o nome que traz.
      files = unzipSync(new Uint8Array(data), {
        filter: (f) => [META, 'diagram.json', 'diagram.mmd'].includes(path.posix.basename(f.name)) && f.originalSize <= MAX_IMPORT,
      });
    } catch (err) {
      fail(400, `Arquivo não é um .zip válido: ${(err as Error).message}`);
    }
    const pick = (base: string) => {
      const key = Object.keys(files).filter((k) => path.posix.basename(k) === base).sort((a, b) => a.length - b.length)[0];
      return key ? strFromU8(files[key]) : undefined;
    };
    let diagram: Diagram | undefined;
    const json = pick('diagram.json');
    const mmd = pick('diagram.mmd');
    if (json) {
      try {
        const raw = JSON.parse(json);
        diagram = ops.buildDiagram(raw.diagram ?? raw);
      } catch (err) {
        fail(400, `diagram.json inválido: ${(err as Error).message}`);
      }
    } else if (mmd) {
      const parsed = parseMermaid(mmd);
      if (parsed.errors.length) fail(400, `diagram.mmd inválido: ${parsed.errors.slice(0, 3).join(' · ')}`);
      diagram = parsed.diagram;
    } else {
      fail(400, 'O .zip precisa de um diagram.json ou diagram.mmd (exportado pelo menu ☰).');
    }
    let meta: Partial<Meta> = {};
    try {
      meta = JSON.parse(pick(META) ?? '{}');
    } catch {}
    return create(name || meta.name || 'Importado', diagram);
  };

  // Primeira vez: o diagrama solto de antes vira o primeiro; sem nada, um diagrama vazio.
  if (!slugs().length) {
    const legacy = options.legacyFile;
    const legacyMmd = legacy?.replace(/\.json$/, '') + '.mmd';
    if (legacy && (fs.existsSync(legacy) || fs.existsSync(legacyMmd))) {
      const slug = uniqueSlug('Diagrama');
      fs.mkdirSync(folder(slug), { recursive: true });
      writeMeta(slug, { name: 'Diagrama', createdAt: new Date().toISOString() });
      if (fs.existsSync(legacy)) fs.copyFileSync(legacy, path.join(folder(slug), 'diagram.json'));
      else fs.copyFileSync(legacyMmd, path.join(folder(slug), 'diagram.mmd'));
    } else {
      create(FIRST_NAME);
    }
  }

  // ---- HTTP -----------------------------------------------------------------

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.statusCode = status;
    if (body === undefined) return res.end();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(`${JSON.stringify(body, null, 2)}\n`);
  };

  const readBody = (req: IncomingMessage, limit: number) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          reject(new OpError(400, `O arquivo passa do limite de ${limit / 1024 / 1024} MB.`));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const readName = async (req: IncomingMessage) => {
    const raw = (await readBody(req, 1024 * 1024)).toString('utf8');
    if (!raw.trim()) return '';
    try {
      return String(JSON.parse(raw).name ?? '');
    } catch {
      fail(400, 'Corpo não é um JSON válido.');
    }
  };

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? 'GET';
    const [resource, slug, action] = parts;

    try {
      if (resource === 'd' && slug) {
        const a = api(slug);
        // A API do diagrama recebe o caminho sem o prefixo /d/:slug.
        req.url = url.pathname.replace(/^\/d\/[^/]+/, '') + url.search || '/';
        return a.handler(req, res, next);
      }

      if (resource === 'events' && parts.length === 1 && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'diagrams', diagrams: list() })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (resource === 'diagrams') {
        if (parts.length === 1 && method === 'GET') return send(res, 200, list());
        if (parts.length === 1 && method === 'POST') return send(res, 201, create(await readName(req)));
        if (parts.length === 2 && slug === 'import' && method === 'POST') {
          return send(res, 201, importFile(url.searchParams.get('name')?.trim() ?? '', await readBody(req, MAX_IMPORT)));
        }
        if (parts.length === 2 && method === 'PATCH') return send(res, 200, rename(slug, await readName(req)));
        if (parts.length === 2 && method === 'DELETE') {
          remove(slug);
          return send(res, 204);
        }
        if (parts.length === 3 && action === 'duplicate' && method === 'POST') return send(res, 201, duplicate(slug));
        if (parts.length === 3 && action === 'export' && method === 'GET') {
          const file = slugify(readMeta(slug).name);
          if (url.searchParams.get('format') === 'mmd') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${file}.mmd"`);
            return res.end(`${toMermaid(current(slug))}\n`);
          }
          const { zip } = exportZip(slug);
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Disposition', `attachment; filename="${file}.zip"`);
          return res.end(Buffer.from(zip));
        }
        return send(res, 404, { error: `Rota não encontrada: ${method} /api${url.pathname}` });
      }

      // Rotas antigas, sem prefixo: o primeiro diagrama da lista.
      if (['nodes', 'edges', 'diagram', 'diagram.json'].includes(resource)) return api(list()[0].slug).handler(req, res, next);

      if (parts.length) return send(res, 404, { error: `Rota não encontrada: ${method} /api${url.pathname}` });
      next();
    } catch (err) {
      if (err instanceof OpError) return send(res, err.status, { error: err.message });
      send(res, 500, { error: (err as Error).message });
    }
  };

  return {
    handler,
    list,
    close() {
      clearTimeout(notifyTimer);
      for (const a of apis.values()) a.close();
      apis.clear();
      for (const c of clients) c.end();
      clients.clear();
    },
  };
}

/**
 * Plugin do Vite: a API em /api, nos servidores de `npm run dev` e `npm run preview`.
 * `dir` é a pasta dos diagramas; `legacyFile`, o diagram.json de antes (migrado na primeira vez).
 */
export function diagramApi(dir = 'diagrams', legacyFile = 'diagram.json'): Plugin {
  let root = '';
  // A pasta só é aberta quando um servidor sobe (não ao carregar a config, ex.: no vitest).
  let diagrams: ReturnType<typeof createDiagrams> | undefined;
  const handler: Connect.NextHandleFunction = (req, res, next) =>
    (diagrams ??= createDiagrams(path.resolve(root, dir), { legacyFile: path.resolve(root, legacyFile) })).handler(req, res, next);
  return {
    name: 'mermaid-draw-api',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use('/api', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api', handler);
    },
  };
}
