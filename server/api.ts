import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect } from 'vite';
import { parseMermaid, toMermaid, type Diagram } from '../src/model.ts';
import * as ops from '../src/ops.ts';
import { OpError, type DiagramEvent } from '../src/ops.ts';

/**
 * API HTTP do diagrama. Cada retângulo e cada seta é um recurso próprio: um POST/PATCH/DELETE
 * mexe só naquele elemento, e os navegadores recebem só o evento daquela mudança.
 * O código Mermaid é gerado na hora a partir do estado; a fonte de verdade é o JSON.
 *
 *   GET    /api/nodes                        lista os retângulos
 *   POST   /api/nodes                        cria  {text, x?, y?, active?, owner?, id?}
 *   GET    /api/nodes/:ref                   um retângulo (:ref = id ou texto)
 *   PATCH  /api/nodes/:ref                   altera {text?, x?, y?, active?, owner?}  (owner "" ou null remove)
 *   DELETE /api/nodes/:ref                   remove (e as setas ligadas a ele)
 *   POST   /api/nodes/:ref/ativar|desativar|alternar
 *   GET    /api/edges                        lista as setas
 *   POST   /api/edges                        cria  {from, to, text?, animated?, id?}  (from/to = id ou texto)
 *   GET    /api/edges/:id                    uma seta
 *   PATCH  /api/edges/:id                    altera {text?, from?, to?, animated?}
 *   DELETE /api/edges/:id                    remove
 *   POST   /api/edges/:id/pulse              manda uma "mensagem" pela seta {label?}: só o evento edge.pulse,
 *                                            sem salvar nem mudar o rev
 *   GET    /api/diagram                      código Mermaid (204 se ainda não há diagrama)
 *   PUT    /api/diagram                      substitui tudo a partir de código Mermaid
 *   GET    /api/diagram.json                 {rev, diagram}
 *   PUT    /api/diagram.json                 substitui tudo a partir de {nodes, edges}
 *   GET    /api/events                       Server-Sent Events: snapshot e depois um evento por mudança
 *
 * Toda resposta de mudança traz o cabeçalho `X-Rev`; todo evento traz `rev` e `source`.
 */

type Stored = { rev: number; diagram: Diagram | null };

export interface ApiOptions {
  /** Chamado depois de cada mudança no diagrama (ex.: para o menu de diagramas atualizar a lista). */
  onChange?: () => void;
}

export function createApi(filePath: string, options: ApiOptions = {}) {
  let state: Stored = load(filePath);
  const clients = new Set<ServerResponse>();

  const persist = () => fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);

  const broadcast = (payload: object) => {
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of clients) c.write(msg);
  };

  /** Executa uma operação sobre o diagrama, salva e avisa os navegadores. */
  const commit = (source: string, op: (d: Diagram) => DiagramEvent): DiagramEvent => {
    const d = state.diagram ?? { nodes: [], edges: [] };
    const ev = op(d);
    state = { rev: state.rev + 1, diagram: ev.type === 'diagram.replaced' ? ev.diagram : d };
    persist();
    broadcast({ ...ev, rev: state.rev, source });
    options.onChange?.();
    return ev;
  };

  const diagram = () => state.diagram ?? { nodes: [], edges: [] };

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.statusCode = status;
    res.setHeader('X-Rev', String(state.rev));
    if (body === undefined) return res.end();
    if (typeof body === 'string') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(body.endsWith('\n') ? body : `${body}\n`);
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(`${JSON.stringify(body, null, 2)}\n`);
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });

  const readJson = async (req: IncomingMessage) => {
    const raw = await readBody(req);
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new OpError(400, 'Corpo não é um JSON válido.');
    }
  };

  const nodeOut = (n: { id: string; text: string; x: number; y: number; active?: boolean; owner?: string }) => ({
    id: n.id,
    text: n.text,
    active: Boolean(n.active),
    owner: n.owner ?? null,
    x: Math.round(n.x),
    y: Math.round(n.y),
  });

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? 'GET';
    const source = String(req.headers['x-client-id'] ?? 'api');
    const [resource, ref, action] = parts;

    try {
      if (resource === 'events' && parts.length === 1 && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'snapshot', rev: state.rev, diagram: state.diagram, source: 'server' })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (resource === 'diagram' && parts.length === 1) {
        if (method === 'GET') return state.diagram ? send(res, 200, toMermaid(state.diagram)) : send(res, 204);
        if (method === 'PUT') {
          const { diagram: parsed, errors } = parseMermaid(await readBody(req), state.diagram ?? undefined);
          if (errors.length) return send(res, 400, { errors });
          commit(source, () => ({ type: 'diagram.replaced', diagram: parsed }));
          return send(res, 204);
        }
      }

      if (resource === 'diagram.json' && parts.length === 1) {
        if (method === 'GET') return send(res, 200, state);
        if (method === 'PUT') {
          const built = ops.buildDiagram(await readJson(req));
          commit(source, () => ({ type: 'diagram.replaced', diagram: built }));
          return send(res, 204);
        }
      }

      if (resource === 'nodes') {
        if (parts.length === 1) {
          if (method === 'GET') return send(res, 200, diagram().nodes.map(nodeOut));
          if (method === 'POST') {
            const body = await readJson(req);
            const ev = commit(source, (d) => ops.addNode(d, body));
            return send(res, 201, ev.type === 'node.added' && nodeOut(ev.node));
          }
        }
        const id = parts.length > 1 ? ops.resolveNode(diagram(), ref).id : '';
        if (parts.length === 2) {
          if (method === 'GET') return send(res, 200, nodeOut(ops.getNode(diagram(), id)));
          if (method === 'PATCH') {
            const body = await readJson(req);
            commit(source, (d) => ops.updateNode(d, id, body));
            return send(res, 200, nodeOut(ops.getNode(diagram(), id)));
          }
          if (method === 'DELETE') {
            const ev = commit(source, (d) => ops.removeNode(d, id));
            return send(res, 200, ev);
          }
        }
        if (parts.length === 3 && method === 'POST' && ['ativar', 'desativar', 'alternar'].includes(action)) {
          const current = Boolean(ops.getNode(diagram(), id).active);
          const active = action === 'ativar' ? true : action === 'desativar' ? false : !current;
          commit(source, (d) => ops.updateNode(d, id, { active }));
          return send(res, 200, nodeOut(ops.getNode(diagram(), id)));
        }
      }

      if (resource === 'edges') {
        // Nas setas, from/to aceitam id ou texto do retângulo, como :ref em /nodes.
        const ends = (body: Record<string, unknown>) => {
          for (const k of ['from', 'to'] as const) {
            if (typeof body[k] === 'string') body[k] = ops.resolveNode(diagram(), body[k] as string).id;
          }
          return body;
        };
        if (parts.length === 1) {
          if (method === 'GET') return send(res, 200, diagram().edges);
          if (method === 'POST') {
            const body = ends(await readJson(req));
            const ev = commit(source, (d) => ops.addEdge(d, body as ops.NewEdge));
            return send(res, 201, ev.type === 'edge.added' && ev.edge);
          }
        }
        if (parts.length === 2) {
          if (method === 'GET') return send(res, 200, ops.getEdge(diagram(), ref));
          if (method === 'PATCH') {
            const body = ends(await readJson(req));
            const ev = commit(source, (d) => ops.updateEdge(d, ref, body));
            return send(res, 200, ev.type === 'edge.updated' && ev.edge);
          }
          if (method === 'DELETE') {
            commit(source, (d) => ops.removeEdge(d, ref));
            return send(res, 204);
          }
        }
        if (parts.length === 3 && action === 'pulse' && method === 'POST') {
          ops.getEdge(diagram(), ref);
          const body = await readJson(req);
          if (body.label !== undefined && typeof body.label !== 'string') throw new OpError(400, '"label" deve ser um texto.');
          // Efêmero: não entra no estado, não sobe o rev. Quem estiver olhando vê a mensagem passar.
          broadcast({ type: 'edge.pulse', id: ref, label: body.label?.trim() || undefined, source });
          return send(res, 204);
        }
      }

      if (parts.length) return send(res, 404, { error: `Rota não encontrada: ${method} /api${url.pathname}` });
      next();
    } catch (err) {
      if (err instanceof OpError) return send(res, err.status, { error: err.message });
      send(res, 500, { error: (err as Error).message });
    }
  };

  return {
    handler,
    /** Resumo para a lista de diagramas. */
    info() {
      return { nodes: diagram().nodes.length, edges: diagram().edges.length, rev: state.rev };
    },
    close() {
      for (const c of clients) c.end();
      clients.clear();
    },
  };
}

/** Lê o estado salvo. Sem JSON, migra o `.mmd` de mesmo nome (formato antigo), se existir. */
function load(filePath: string): Stored {
  try {
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Stored;
    return { rev: stored.rev ?? 0, diagram: stored.diagram ? ops.buildDiagram(stored.diagram) : null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const legacy = filePath.replace(/\.json$/, '') + '.mmd';
  if (legacy !== filePath && fs.existsSync(legacy)) {
    const stored: Stored = { rev: 0, diagram: parseMermaid(fs.readFileSync(legacy, 'utf8')).diagram };
    fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`);
    return stored;
  }
  return { rev: 0, diagram: null };
}
