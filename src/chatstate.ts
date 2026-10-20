/**
 * Estado do chat a partir dos eventos do servidor (chat.inicio, chat.turno, chat.delta,
 * chat.mensagem, chat.fim) ou de uma conversa salva. Funções puras: o painel só desenha o resultado.
 */

export type TipoMensagem = 'usuario' | 'fala' | 'sintese' | 'tarefa' | 'resultado' | 'erro' | 'sistema';

export interface MensagemView {
  id: string;
  tipo: TipoMensagem;
  nome: string;
  texto: string;
  em?: string;
  persona?: string;
  turno?: string;
  motor?: string;
  modelo?: string;
  pai?: string;
  respondendoA?: string[];
  uso?: { entrada?: number; saida?: number; custo?: number; tokensPorSegundo?: number };
}

/** Uma persona com a vez: o texto vai chegando (no Ollama e na API) ou fica "pensando…" (no MCP). */
export interface Pendente {
  turno: string;
  persona: string;
  nome: string;
  tipo: string;
  motor: string;
  texto: string;
}

export interface ChatState {
  conversa?: string;
  assunto?: string;
  modo?: string;
  status: 'vazio' | 'rodando' | 'terminada' | 'parada';
  mensagens: MensagemView[];
  pendentes: Pendente[];
  resposta?: string;
  custo: number;
}

export const inicial = (): ChatState => ({ status: 'vazio', mensagens: [], pendentes: [], custo: 0 });

const somaCusto = (ms: MensagemView[]) => ms.reduce((t, m) => t + (m.uso?.custo ?? 0), 0);

export function aplicar(s: ChatState, ev: any): ChatState {
  if (ev.type === 'carregar') {
    const c = ev.conversa;
    const pendentes: Pendente[] = (c.pendentes ?? []).map((p: Omit<Pendente, 'texto'>) => ({ ...p, texto: '' }));
    return { conversa: c.id, assunto: c.assunto, modo: c.modo, status: c.status, mensagens: [...c.mensagens], pendentes, resposta: c.resposta, custo: somaCusto(c.mensagens) };
  }
  if (ev.type === 'chat.inicio') {
    return { ...inicial(), conversa: ev.conversa, assunto: ev.assunto, modo: ev.modo, status: 'rodando' };
  }
  // Eventos de outra conversa (outra aba, ou a do MCP) não mexem nesta.
  if (!s.conversa || ev.conversa !== s.conversa) return s;
  switch (ev.type) {
    case 'chat.turno': {
      const sem = s.pendentes.filter((p) => p.turno !== ev.turno);
      if (ev.status !== 'pensando') return { ...s, pendentes: sem };
      return { ...s, status: 'rodando', pendentes: [...sem, { turno: ev.turno, persona: ev.persona, nome: ev.nome, tipo: ev.tipo, motor: ev.motor, texto: '' }] };
    }
    case 'chat.delta':
      return { ...s, pendentes: s.pendentes.map((p) => (p.turno === ev.turno ? { ...p, texto: p.texto + ev.texto } : p)) };
    case 'chat.mensagem': {
      const m = ev.mensagem as MensagemView;
      if (s.mensagens.some((x) => x.id === m.id)) return s;
      const mensagens = [...s.mensagens, m];
      const status = m.tipo === 'usuario' && s.status !== 'rodando' ? 'rodando' : s.status;
      return { ...s, status, mensagens, pendentes: s.pendentes.filter((p) => p.turno !== m.turno), custo: somaCusto(mensagens) };
    }
    case 'chat.fim':
      return { ...s, status: ev.status, resposta: ev.resposta ?? s.resposta, pendentes: [] };
  }
  return s;
}

const normalizar = (t: string) =>
  t
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/** As personas que completam a @menção sendo digitada no fim do texto. */
export function sugerirMencoes<T extends { id: string; nome: string }>(texto: string, pessoas: T[]): T[] {
  const m = /@([\p{L}\p{N} ]*)$/u.exec(texto);
  if (!m) return [];
  const parcial = normalizar(m[1]);
  // "@Cética já completa " → a menção acabou.
  if (pessoas.some((p) => parcial.startsWith(`${normalizar(p.nome)} `))) return [];
  return pessoas.filter((p) => normalizar(p.nome).startsWith(parcial.trimEnd()));
}

export function formatarCusto(dolares: number) {
  const casas = dolares > 0 && dolares < 0.01 ? 4 : 2;
  return `US$ ${dolares.toFixed(casas).replace('.', ',')}`;
}
