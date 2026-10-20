import type { Motor, Pedido, Resposta } from '../conversa.ts';
import type { Delegacao } from '../turnos.ts';

/**
 * Motor MCP: quem dá voz à persona é um cliente MCP, como o Claude Code, conectado ao /mcp. Cada vez
 * desta persona vira um turno pendente; o cliente busca os pendentes (`proxima_vez`), escreve como a
 * persona e devolve (`responder`). Turnos pendentes de vários diagramas e conversas convivem, e
 * delegações em paralelo aparecem juntas, para o cliente atender com subagentes.
 */

/** Sem contato do cliente MCP por este tempo, ele conta como desconectado. */
const CONECTADO_MS = 5 * 60_000;

interface Pendente {
  pedido: Pedido;
  resolver: (r: Resposta) => void;
  rejeitar: (e: Error) => void;
}

export function criarMotorMcp() {
  const pendentes = new Map<string, Pendente>();
  const esperando = new Set<() => void>();
  let ultimoContato = 0;

  const acordar = () => {
    for (const fn of [...esperando]) fn();
  };
  const conectado = () => Date.now() - ultimoContato < CONECTADO_MS;
  const daqui = (diagrama?: string) => [...pendentes.values()].map((p) => p.pedido).filter((p) => !diagrama || p.diagrama === diagrama);

  const motor: Motor = {
    nome: 'mcp',
    async disponivel() {
      return conectado()
        ? { ok: true, detalhe: 'Claude Code conectado ao /mcp' }
        : { ok: false, detalhe: 'nenhum Claude Code conectado ao /mcp: abra o Claude Code na pasta do projeto (o .mcp.json já aponta para cá) e peça para começar a conversa' };
    },
    atender(p) {
      return new Promise<Resposta>((resolver, rejeitar) => {
        if (p.signal.aborted) return rejeitar(new Error('conversa parada'));
        pendentes.set(p.id, { pedido: p, resolver, rejeitar });
        p.signal.addEventListener('abort', () => {
          if (pendentes.delete(p.id)) rejeitar(new Error('conversa parada'));
        });
        acordar();
      });
    },
  };

  return {
    motor,
    /** O cliente MCP fez contato (para o status "conectado"). */
    tocar() {
      ultimoContato = Date.now();
    },
    conectado,
    pendentes: daqui,
    /** Os turnos pendentes; sem nenhum, espera até `ms` por um novo. */
    async aguardar(diagrama: string | undefined, ms: number): Promise<Pedido[]> {
      const fim = Date.now() + ms;
      for (;;) {
        const lista = daqui(diagrama);
        const resta = fim - Date.now();
        if (lista.length || resta <= 0) return lista;
        await new Promise<void>((resolve) => {
          const acorda = () => {
            esperando.delete(acorda);
            clearTimeout(t);
            // Deixa a rodada terminar de criar os turnos (delegações paralelas chegam juntas).
            setImmediate(resolve);
          };
          const t = setTimeout(acorda, resta);
          esperando.add(acorda);
        });
      }
    },
    responder(turno: string, texto: string, delegacoes?: Delegacao[]) {
      const p = pendentes.get(turno);
      if (!p) throw new Error(`O turno "${turno}" não está pendente (já respondido, parado ou inexistente). Chame proxima_vez para ver os pendentes.`);
      pendentes.delete(turno);
      p.resolver({ texto, delegacoes });
    },
  };
}

export type MotorMcp = ReturnType<typeof criarMotorMcp>;
