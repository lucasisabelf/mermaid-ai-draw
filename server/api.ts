import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { parseMermaid, toMermaid, type DiagramNode } from '../src/model';

/**
 * API HTTP do diagrama, servida pelo próprio Vite (dev e preview).
 *
 *   GET  /api/diagram                     código Mermaid atual (204 se ainda não há)
 *   PUT  /api/diagram                     substitui o código (corpo em texto)
 *   GET  /api/nodes                       lista os retângulos
 *   GET  /api/nodes/:ref                  um retângulo
 *   POST /api/nodes/:ref/ativar           ativa
 *   POST /api/nodes/:ref/desativar        desativa
 *   POST /api/nodes/:ref/alternar         inverte
 *   GET  /api/events                      Server-Sent Events com o código a cada mudança
 *
 * `:ref` é o id (`n1`) ou o texto exato do retângulo.
 */
export function diagramApi(file = 'diagram.mmd'): Plugin {
  let filePath = '';
  let code: string | null = null;
  const clients = new Set<ServerResponse>();

  const broadcast = (source: string) => {
    const msg = `data: ${JSON.stringify({ code, source })}\n\n`;
    for (const c of clients) c.write(msg);
  };

  const save = (next: string, source: string) => {
    code = next;
    fs.writeFileSync(filePath, next);
    broadcast(source);
  };

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.statusCode = status;
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

  const publicNode = (n: DiagramNode) => ({ id: n.id, text: n.text, active: Boolean(n.active) });

  const findNode = (nodes: DiagramNode[], ref: string) => {
    const byId = nodes.find((n) => n.id === ref);
    if (byId) return { node: byId };
    const wanted = ref.trim().toLowerCase();
    const byText = nodes.filter((n) => n.text.trim().toLowerCase() === wanted);
    if (byText.length > 1) return { error: `Mais de um retângulo com o texto "${ref}"; use o id.` };
    return byText[0] ? { node: byText[0] } : { error: `Retângulo "${ref}" não encontrado.` };
  };

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? 'GET';

    try {
      if (parts[0] === 'events' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ code, source: 'server' })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (parts[0] === 'diagram' && parts.length === 1) {
        if (method === 'GET') return code === null ? send(res, 204) : send(res, 200, code);
        if (method === 'PUT') {
          const body = await readBody(req);
          const { diagram, errors } = parseMermaid(body);
          if (errors.length) return send(res, 400, { errors });
          save(toMermaid(diagram), String(req.headers['x-client-id'] ?? 'api'));
          return send(res, 204);
        }
      }

      if (parts[0] === 'nodes') {
        const diagram = parseMermaid(code ?? '').diagram;
        if (parts.length === 1 && method === 'GET') return send(res, 200, diagram.nodes.map(publicNode));

        const found = findNode(diagram.nodes, parts[1] ?? '');
        if (!found.node) return send(res, found.error?.startsWith('Mais') ? 409 : 404, { error: found.error });
        const n = found.node;

        if (parts.length === 2 && method === 'GET') return send(res, 200, publicNode(n));

        const action = parts[2];
        if (parts.length === 3 && method === 'POST' && ['ativar', 'desativar', 'alternar'].includes(action)) {
          n.active = action === 'ativar' ? true : action === 'desativar' ? false : !n.active;
          save(toMermaid(diagram), 'api');
          return send(res, 200, publicNode(n));
        }
      }

      if (parts.length) return send(res, 404, { error: `Rota não encontrada: ${method} /api${url.pathname}` });
      next();
    } catch (err) {
      send(res, 500, { error: (err as Error).message });
    }
  };

  return {
    name: 'mermaid-draw-api',
    configResolved(config) {
      filePath = path.resolve(config.root, file);
      try {
        code = fs.readFileSync(filePath, 'utf8');
      } catch {
        code = null;
      }
    },
    configureServer(server) {
      server.middlewares.use('/api', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api', handler);
    },
  };
}
