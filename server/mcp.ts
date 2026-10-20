import type { Connect } from 'vite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Diagram } from '../src/model.ts';
import type { Pedido, createConversas } from './conversa.ts';
import type { MotorMcp } from './motores/mcp.ts';
import type { Persona } from './personas.ts';
import { ordemDaRodada } from './turnos.ts';

/**
 * O servidor MCP em /mcp: é por ele que o Claude Code (ou outro cliente MCP) dá voz às personas de
 * motor "mcp". O cliente lista os diagramas, começa a conversa, pega cada vez (`proxima_vez`) e
 * responde como a persona (`responder`). Personas de outros motores (Ollama, API) falam sozinhas.
 */

export interface DiagramaParaMcp {
  diagrama: Diagram;
  personas: Persona[];
  conversas: ReturnType<typeof createConversas>;
}

export interface DepsMcp {
  mcp: MotorMcp;
  listar(): { slug: string; name: string; nodes: number }[];
  abrir(slug: string): DiagramaParaMcp;
}

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

/** Subagente sugerido para o Claude Code, pelo modelo da persona. */
const subagente = (modelo: string) => (modelo.includes('haiku') ? 'haiku' : modelo.includes('sonnet') ? 'sonnet' : modelo.includes('fable') ? 'fable' : 'opus');

const COMO: Record<Pedido['tipo'], string> = {
  fala: 'Escreva a fala desta persona (só ela, em primeira pessoa, sem o nome na frente) e chame responder(turno, texto).',
  sintese: 'Escreva a síntese final pedida no contexto (a resposta polida) e chame responder(turno, texto).',
  tarefa:
    'Decida como fazer a tarefa. Para delegar, chame responder com `delegacoes: [{para, tarefa}]` (só para as delegáveis) e um texto curto com o plano; as delegadas viram novos turnos (em paralelo: dá para usar um subagente por turno) e depois vem um turno "consolidar". Se fizer sozinha, responda com o resultado direto, sem delegações.',
  execucao: 'Faça a tarefa delegada e chame responder(turno, texto) com o resultado completo.',
  consolidar: 'Junte os resultados do contexto numa entrega final única e chame responder(turno, texto).',
};

function turnoParaCliente(p: Pedido) {
  return {
    turno: p.id,
    diagrama: p.diagrama,
    conversa: p.conversa,
    tipo: p.tipo,
    persona: { id: p.persona.id, nome: p.persona.nome, papel: p.persona.papel, modelo: p.persona.modelo, subagente_sugerido: subagente(p.persona.modelo) },
    system: p.system,
    contexto: p.contexto,
    delegaveis: p.delegaveis.map((d) => d.nome),
    como_responder: COMO[p.tipo],
  };
}

function servidor(deps: DepsMcp) {
  const s = new McpServer({ name: 'mermaid-ai-draw', version: '0.1.0' });
  const tocar = <A, R>(fn: (a: A) => Promise<R> | R) => async (a: A) => {
    deps.mcp.tocar();
    return fn(a);
  };

  s.registerTool(
    'listar_diagramas',
    { description: 'Lista os diagramas (cada um é um grupo de personas de IA).' },
    tocar(() => json(deps.listar().map((d) => ({ slug: d.slug, nome: d.name, personas: d.nodes })))),
  );

  s.registerTool(
    'ver_personas',
    { description: 'As personas de um diagrama (nome, motor, modelo, papel) e as setas (quem responde a quem / quem delega para quem).', inputSchema: { diagrama: z.string().describe('slug do diagrama') } },
    tocar(({ diagrama }) => {
      const { diagrama: d, personas } = deps.abrir(diagrama);
      const nome = (id: string) => d.nodes.find((n) => n.id === id)?.text ?? id;
      return json({
        personas: personas.map((p) => ({ id: p.id, nome: p.nome, motor: p.motor, modelo: p.modelo, papel: p.papel, inicio: p.inicio })),
        setas: d.edges.filter((e) => e.from !== e.to).map((e) => `${nome(e.from)} → ${nome(e.to)}`),
      });
    }),
  );

  s.registerTool(
    'iniciar_conversa',
    {
      description:
        'Começa uma conversa entre as personas do diagrama. modo: "debate" (rodadas pelas setas), "resposta" (debate + síntese polida no fim) ou "tarefa" (a orquestradora delega pelas setas e consolida). Depois, chame proxima_vez para dar voz às personas de motor mcp.',
      inputSchema: {
        diagrama: z.string(),
        assunto: z.string().describe('o assunto, a pergunta ou a tarefa'),
        modo: z.enum(['debate', 'resposta', 'tarefa']).optional(),
        rodadas: z.number().int().min(1).max(10).optional(),
      },
    },
    tocar(({ diagrama, assunto, modo, rodadas }) => {
      const { diagrama: d, personas, conversas } = deps.abrir(diagrama);
      const c = conversas.iniciar({ assunto, modo, rodadas });
      const inicios = personas.filter((p) => p.inicio).map((p) => p.id);
      return json({ conversa: c.id, modo: c.modo, rodadas: c.rodadas, ordem: ordemDaRodada(d, inicios).map((id) => d.nodes.find((n) => n.id === id)!.text) });
    }),
  );

  s.registerTool(
    'proxima_vez',
    {
      description:
        'Os turnos pendentes das personas de motor mcp (de um diagrama, ou de todos). Sem nenhum, espera até `aguardar_s` segundos por um novo (por exemplo, quando o usuário escreve no chat do navegador). Responda cada turno com responder.',
      inputSchema: { diagrama: z.string().optional(), aguardar_s: z.number().min(0).max(120).optional() },
    },
    tocar(async ({ diagrama, aguardar_s }) => {
      const turnos = await deps.mcp.aguardar(diagrama, (aguardar_s ?? 25) * 1000);
      return json({ turnos: turnos.map(turnoParaCliente) });
    }),
  );

  s.registerTool(
    'responder',
    {
      description: 'Entrega a fala (ou o resultado) de um turno pendente. Em turnos de tarefa, `delegacoes` divide o trabalho entre as personas delegáveis.',
      inputSchema: {
        turno: z.string(),
        texto: z.string(),
        delegacoes: z.array(z.object({ para: z.string().describe('nome da persona delegável'), tarefa: z.string() })).optional(),
      },
    },
    tocar(({ turno, texto, delegacoes }) => {
      deps.mcp.responder(turno, texto, delegacoes);
      return json({ ok: true });
    }),
  );

  s.registerTool(
    'ver_conversa',
    { description: 'A conversa (a última do diagrama, se não disser qual): status, mensagens e a resposta final.', inputSchema: { diagrama: z.string(), conversa: z.string().optional() } },
    tocar(({ diagrama, conversa }) => {
      const { conversas } = deps.abrir(diagrama);
      const id = conversa ?? conversas.listar()[0]?.id;
      if (!id) throw new Error('Este diagrama ainda não tem conversas.');
      const c = conversas.obter(id);
      return json({ id: c.id, assunto: c.assunto, modo: c.modo, status: c.status, resposta: c.resposta, mensagens: c.mensagens.map((m) => ({ nome: m.nome, tipo: m.tipo, persona: m.persona, texto: m.texto })) });
    }),
  );

  s.registerTool(
    'sintetizar',
    { description: 'Pede a resposta final polida agora (depois da vez em andamento).', inputSchema: { diagrama: z.string(), conversa: z.string() } },
    tocar(({ diagrama, conversa }) => {
      deps.abrir(diagrama).conversas.sintetizar(conversa);
      return json({ ok: true });
    }),
  );

  s.registerTool(
    'parar',
    { description: 'Para a conversa (os turnos pendentes são cancelados).', inputSchema: { diagrama: z.string(), conversa: z.string() } },
    tocar(({ diagrama, conversa }) => {
      deps.abrir(diagrama).conversas.parar(conversa);
      return json({ ok: true });
    }),
  );

  return s;
}

/** Handler HTTP do /mcp (Streamable HTTP, sem sessão: um servidor por requisição). */
export function criarHandlerMcp(deps: DepsMcp): Connect.NextHandleFunction {
  return async (req, res) => {
    const s = servidor(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void s.close();
    });
    try {
      await s.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    }
  };
}
