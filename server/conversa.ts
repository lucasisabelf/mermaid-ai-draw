import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Diagram } from '../src/model.ts';
import { OpError } from '../src/ops.ts';
import type { MotorNome, Persona } from './personas.ts';
import { acharPessoa, arestas, delegaveis, lerDelegacoes, mencionada, ordemDaRodada, predecessores, semNos, type Delegacao } from './turnos.ts';

/**
 * Uma conversa entre as personas do diagrama. Ela não sabe falar: a cada vez, monta um pedido
 * (quem fala, o prompt, o contexto) e o entrega ao motor daquela persona (MCP, Ollama ou API), que
 * devolve o texto. Por isso motores diferentes se misturam na mesma conversa.
 *
 *   debate    N rodadas pelas setas: cada persona responde a quem aponta para ela
 *   resposta  o debate e, no fim, a síntese (pela moderadora, ou pela última a falar)
 *   tarefa    a orquestradora delega pelas setas (DELEGAR <persona>: <tarefa>), as delegadas
 *             trabalham em paralelo (e podem delegar adiante) e ela consolida a entrega
 *
 * As personas de saída (saida: true) ficam fora das rodadas e das delegações: no fim, cada uma
 * preenche o seu template com o resultado e gera um .md para baixar.
 */

export type Modo = 'debate' | 'resposta' | 'tarefa';
export const MODOS: Modo[] = ['debate', 'resposta', 'tarefa'];
export type TipoPedido = 'fala' | 'sintese' | 'tarefa' | 'execucao' | 'consolidar' | 'saida';

export interface Pedido {
  /** Id do turno: é por ele que o MCP responde. */
  id: string;
  conversa: string;
  diagrama: string;
  tipo: TipoPedido;
  persona: Persona;
  system: string;
  contexto: string;
  /** Ids de quem esta fala responde ("usuario" quando foi chamada no chat). */
  respondendoA: string[];
  /** Para quem pode delegar (só nas tarefas). */
  delegaveis: { id: string; nome: string }[];
  /** Abortado quando a conversa para. */
  signal: AbortSignal;
}

export interface Uso {
  entrada: number;
  saida: number;
  cache?: number;
  /** Em dólares (zero no Ollama e no MCP). */
  custo: number;
  tokensPorSegundo?: number;
}

export interface Resposta {
  texto: string;
  /** Delegações estruturadas (o MCP manda assim); as linhas DELEGAR do texto também valem. */
  delegacoes?: Delegacao[];
  uso?: Uso;
}

export interface Motor {
  nome: MotorNome;
  disponivel(): Promise<{ ok: boolean; detalhe: string }>;
  atender(pedido: Pedido, delta: (texto: string) => void): Promise<Resposta>;
}

export type TipoMensagem = 'usuario' | 'fala' | 'sintese' | 'tarefa' | 'resultado' | 'saida' | 'erro' | 'sistema';

export interface Mensagem {
  id: string;
  tipo: TipoMensagem;
  nome: string;
  texto: string;
  em: string;
  persona?: string;
  turno?: string;
  motor?: MotorNome;
  modelo?: string;
  respondendoA?: string[];
  /** Na tarefa: a mensagem que originou esta delegação. */
  pai?: string;
  /** Na saída: o nome do .md gerado. */
  arquivo?: string;
  uso?: Uso;
}

export type Status = 'rodando' | 'aguardando' | 'terminada' | 'parada';

/** A vez de uma persona humana: a conversa espera a resposta do usuário. */
export interface Espera {
  turno: string;
  persona: string;
  nome: string;
  tipo: TipoPedido;
  contexto: string;
  /** No debate: onde a rodada parou (para retomar depois de reiniciar o servidor). */
  posicao?: { rodada: number; indice: number };
  em: string;
}

export interface RespostaHumana {
  acao: 'aprovar' | 'mudar' | 'encerrar';
  texto?: string;
}
const ACOES_HUMANAS = ['aprovar', 'mudar', 'encerrar'];

export interface Conversa {
  id: string;
  diagrama: string;
  assunto: string;
  modo: Modo;
  rodadas: number;
  status: Status;
  mensagens: Mensagem[];
  /** A síntese ou a entrega final, quando houver. */
  resposta?: string;
  /** A vez humana em espera (status "aguardando"). */
  espera?: Espera;
  /** Turnos em andamento (só na conversa viva; não é salvo): quem abre a página no meio vê quem está pensando. */
  pendentes?: { turno: string; persona: string; nome: string; tipo: TipoPedido; motor: MotorNome }[];
  criadaEm: string;
  atualizadaEm: string;
}

export interface OpcoesConversas {
  /** Pasta onde cada conversa é salva (<id>.json). */
  dir: string;
  diagrama: string;
  ler: () => Diagram;
  persona: (id: string, nome: string) => Persona;
  motores: Record<MotorNome, Motor>;
  emitir: (ev: Record<string, unknown>) => void;
  /** Turnos no máximo por conversa (padrão 40): protege de um ciclo que não acabaria. */
  limiteTurnos?: number;
  /** O template de saída da persona (personas/<id>.saida.md). */
  template?: (id: string) => string;
  /** Grava o .md que a persona de saída gerou. */
  gravarSaida?: (conversa: string, arquivo: string, texto: string) => void;
}

interface Viva {
  dados: Conversa;
  parar: AbortController;
  /** Quem fala antes da próxima vez: chamadas com @ no chat (respondendo ao usuário) ou de volta por um pedido de mudança. */
  chamadas: { id: string; a: string[] }[];
  /** Respostas que a persona humana em espera aguarda (turno → resolver). */
  esperas: Map<string, (r: RespostaHumana & { venceu?: boolean }) => void>;
  /** No debate: a rodada e a vez atuais. */
  posicao?: { rodada: number; indice: number };
  sintetizarJa: boolean;
  turnos: number;
  execucao: Promise<void>;
  emAndamento: Map<string, NonNullable<Conversa['pendentes']>[number]>;
}

class Parada extends Error {}
/** O usuário (ou o prazo dele) encerrou a conversa na vez humana. */
class Encerrada extends Error {}

const agora = () => new Date().toISOString();

export function createConversas(opts: OpcoesConversas) {
  const vivas = new Map<string, Viva>();
  const limite = opts.limiteTurnos ?? 40;
  const arquivo = (id: string) => path.join(opts.dir, `${id}.json`);

  const salvar = (c: Conversa) => {
    c.atualizadaEm = agora();
    fs.mkdirSync(opts.dir, { recursive: true });
    fs.writeFileSync(arquivo(c.id), `${JSON.stringify(c, null, 2)}\n`);
  };

  const carregar = (id: string): Conversa => {
    const v = vivas.get(id);
    if (v) return v.dados;
    if (!/^[\w-]+$/.test(id)) throw new OpError(404, `Conversa "${id}" não encontrada.`);
    try {
      return JSON.parse(fs.readFileSync(arquivo(id), 'utf8')) as Conversa;
    } catch {
      throw new OpError(404, `Conversa "${id}" não encontrada.`);
    }
  };

  /** A conversa em memória (carregando do disco uma que já terminou). */
  const viva = (id: string): Viva => {
    let v = vivas.get(id);
    if (!v) {
      v = { dados: carregar(id), parar: new AbortController(), chamadas: [], esperas: new Map(), sintetizarJa: false, turnos: 0, execucao: Promise.resolve(), emAndamento: new Map() };
      vivas.set(id, v);
    }
    return v;
  };

  const emitir = (c: Conversa, ev: Record<string, unknown>) => opts.emitir({ ...ev, conversa: c.id });

  /** As personas de saída: rodam só no fim. */
  const saidas = (d: Diagram) => d.nodes.filter((n) => opts.persona(n.id, n.text).saida).map((n) => n.id);
  /** O desenho das rodadas e das delegações: sem as personas de saída. */
  const rodada = (d: Diagram) => semNos(d, saidas(d));

  /** A ordem da rodada, começando pelos blocos de início marcados nas personas. */
  const ordem = (d: Diagram) => {
    const r = rodada(d);
    return ordemDaRodada(
      r,
      r.nodes.filter((n) => opts.persona(n.id, n.text).inicio).map((n) => n.id),
    );
  };

  const registrar = (v: Viva, m: Omit<Mensagem, 'id' | 'em'>): Mensagem => {
    const msg: Mensagem = { id: `m-${randomUUID().slice(0, 8)}`, em: agora(), ...m };
    v.dados.mensagens.push(msg);
    salvar(v.dados);
    emitir(v.dados, { type: 'chat.mensagem', mensagem: msg });
    return msg;
  };

  const sistema = (v: Viva, texto: string) => registrar(v, { tipo: 'sistema', nome: 'Conversa', texto });

  // ---- prompts -----------------------------------------------------------------

  const nomeDe = (d: Diagram, id: string) => (id === 'usuario' ? 'o usuário' : (d.nodes.find((n) => n.id === id)?.text ?? id));

  const transcricao = (c: Conversa) =>
    c.mensagens
      .filter((m) => m.tipo !== 'sistema' && m.tipo !== 'erro')
      .map((m) => `${m.tipo === 'usuario' ? 'Usuário' : m.nome}: ${m.texto}`)
      .join('\n\n');

  const montarSystem = (p: Persona, d: Diagram) => {
    const outras = d.nodes.filter((n) => n.id !== p.id).map((n) => n.text);
    if (p.saida) {
      return [
        p.prompt.trim(),
        '---',
        `Você é ${p.nome}, a persona de saída de uma conversa em grupo${outras.length ? ` (entre: ${outras.join(', ')})` : ''}.`,
        `Sua tarefa é preencher o template de saída (o arquivo ${p.arquivo}) com o resultado da conversa.`,
        'Regras: responda em português do Brasil; mantenha os títulos e a ordem do template; troque cada',
        '{{marcação}} pelo conteúdo; não invente o que não está na conversa (escreva "a definir");',
        'devolva só o markdown preenchido, sem comentários antes ou depois.',
      ].join('\n');
    }
    return [
      p.prompt.trim(),
      '---',
      `Você é ${p.nome}, uma das personas de uma conversa em grupo${outras.length ? ` (as outras: ${outras.join(', ')})` : ''}.`,
      'Regras: responda em português do Brasil; fale só por você (nunca escreva as falas das outras personas);',
      'não comece com o seu nome; não repita o que já foi dito; seja direta, com 1 a 3 parágrafos curtos,',
      'a menos que peçam uma entrega maior (síntese, tarefa ou resultado).',
    ].join('\n');
  };

  const conversaAteAgora = (c: Conversa) => {
    const t = transcricao(c);
    return t ? `\n\nConversa até agora:\n${t}` : '';
  };

  // ---- um turno ---------------------------------------------------------------------

  interface Turno {
    id: string;
    tipo: TipoPedido;
    contexto: string;
    respondendoA?: string[];
    delegaveis?: string[];
  }

  /** Um turno de `id`: monta o pedido, chama o motor da persona e devolve a resposta (ou nada, se falhou). */
  const turno = async (v: Viva, personaId: string, t: Omit<Turno, 'id'>): Promise<{ resposta: Resposta; persona: Persona; turno: string } | undefined> => {
    if (v.parar.signal.aborted) throw new Parada();
    const d = opts.ler();
    const no = d.nodes.find((n) => n.id === personaId);
    if (!no) return undefined;
    const persona = opts.persona(personaId, no.text);
    const turnoId = `t-${randomUUID().slice(0, 8)}`;
    const respondendoA = t.respondendoA ?? [];
    const pedido: Pedido = {
      id: turnoId,
      conversa: v.dados.id,
      diagrama: opts.diagrama,
      tipo: t.tipo,
      persona,
      system: montarSystem(persona, d),
      contexto: t.contexto,
      respondendoA,
      delegaveis: (t.delegaveis ?? []).map((id) => ({ id, nome: nomeDe(d, id) })),
      signal: v.parar.signal,
    };
    if (persona.humana) return vezHumana(v, persona, turnoId, t, respondendoA, d);
    const base = { turno: turnoId, persona: personaId, nome: persona.nome, tipo: t.tipo, motor: persona.motor };
    emitir(v.dados, { type: 'chat.turno', ...base, status: 'pensando', respondendoA, arestas: arestas(d, respondendoA, personaId) });
    v.turnos++;
    v.emAndamento.set(turnoId, { turno: turnoId, persona: personaId, nome: persona.nome, tipo: t.tipo, motor: persona.motor });
    try {
      // Parar não espera o motor: um motor que ignore o sinal não prende a conversa.
      const resposta = await Promise.race([
        opts.motores[persona.motor].atender(pedido, (texto) => emitir(v.dados, { type: 'chat.delta', turno: turnoId, persona: personaId, texto })),
        cancelado(v.parar.signal),
      ]);
      emitir(v.dados, { type: 'chat.turno', ...base, status: 'fim' });
      return { resposta, persona, turno: turnoId };
    } catch (err) {
      emitir(v.dados, { type: 'chat.turno', ...base, status: 'erro' });
      if (v.parar.signal.aborted) throw new Parada();
      registrar(v, {
        tipo: 'erro',
        nome: persona.nome,
        persona: personaId,
        turno: turnoId,
        motor: persona.motor,
        texto: `Não consegui a vez de ${persona.nome} (motor ${persona.motor}): ${(err as Error).message}`,
      });
      return undefined;
    } finally {
      v.emAndamento.delete(turnoId);
    }
  };

  /** O texto que entra na conversa pela resposta do usuário na vez humana. */
  const textoHumano = (r: RespostaHumana & { venceu?: boolean }) => {
    const t = r.texto?.trim() ?? '';
    if (r.venceu) return '(sem resposta no prazo: a conversa seguiu)';
    if (r.acao === 'mudar') return `Pedido de mudança: ${t || 'refaça'}`;
    if (r.acao === 'encerrar') return t || 'Encerrar a conversa.';
    return t ? `Aprovado. ${t}` : 'Aprovado.';
  };

  /** A vez de uma persona humana: a conversa para e espera a resposta (ou o prazo). */
  const vezHumana = async (v: Viva, persona: Persona, turnoId: string, t: Omit<Turno, 'id'>, respondendoA: string[], d: Diagram) => {
    const espera: Espera = { turno: turnoId, persona: persona.id, nome: persona.nome, tipo: t.tipo, contexto: t.contexto, ...(v.posicao ? { posicao: { ...v.posicao } } : {}), em: agora() };
    v.dados.status = 'aguardando';
    v.dados.espera = espera;
    salvar(v.dados);
    const base = { turno: turnoId, persona: persona.id, nome: persona.nome, tipo: t.tipo };
    emitir(v.dados, { type: 'chat.turno', ...base, status: 'aguardando', respondendoA, arestas: arestas(d, respondendoA, persona.id), espera });
    v.turnos++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let r: RespostaHumana & { venceu?: boolean };
    try {
      r = await Promise.race([
        new Promise<RespostaHumana & { venceu?: boolean }>((resolve) => {
          v.esperas.set(turnoId, resolve);
          if (persona.prazo) {
            timer = setTimeout(() => resolve({ acao: persona.aoVencer === 'encerrar' ? 'encerrar' : 'aprovar', venceu: true }), persona.prazo * 60_000);
          }
        }),
        cancelado(v.parar.signal),
      ]);
    } finally {
      clearTimeout(timer);
      v.esperas.delete(turnoId);
      v.dados.espera = undefined;
      if (v.dados.status === 'aguardando') v.dados.status = 'rodando';
    }
    emitir(v.dados, { type: 'chat.turno', ...base, status: 'fim' });
    if (r.acao === 'encerrar') {
      if (!r.venceu) registrar(v, { tipo: t.tipo === 'execucao' ? 'resultado' : 'fala', nome: persona.nome, persona: persona.id, turno: turnoId, texto: textoHumano(r) });
      throw new Encerrada(r.venceu ? `O prazo de ${persona.nome} venceu e a conversa foi encerrada.` : `Conversa encerrada por ${persona.nome}.`);
    }
    // Pedir mudança: quem falou antes responde de novo, ao pedido.
    if (r.acao === 'mudar') for (const p of respondendoA.filter((x) => x !== 'usuario')) v.chamadas.push({ id: p, a: [persona.id] });
    return { resposta: { texto: textoHumano(r) } as Resposta, persona, turno: turnoId };
  };

  const mensagemDe = (r: { resposta: Resposta; persona: Persona; turno: string }, tipo: TipoMensagem, extra: Partial<Mensagem> = {}) => ({
    tipo,
    nome: r.persona.nome,
    persona: r.persona.id,
    turno: r.turno,
    ...(r.persona.humana ? {} : { motor: r.persona.motor, modelo: r.persona.modelo }),
    texto: r.resposta.texto.trim(),
    uso: r.resposta.uso,
    ...extra,
  });

  // ---- debate e resposta ---------------------------------------------------------

  /** Quem já falou (para saber a quem cada uma responde). */
  const falaram = (c: Conversa) => new Set(c.mensagens.filter((m) => m.tipo === 'fala' && m.persona).map((m) => m.persona!));

  const fala = async (v: Viva, id: string, respondendoA?: string[]) => {
    if (v.turnos >= limite) throw new LimiteAtingido();
    const d = opts.ler();
    const ja = falaram(v.dados);
    const responde = respondendoA ?? predecessores(rodada(d), id).filter((p) => ja.has(p));
    const pedido = responde.length
      ? `Sua vez: responda a ${responde.map((r) => nomeDe(d, r)).join(' e ')}${responde.includes('usuario') ? ', que falou diretamente com você' : ''}.`
      : 'Sua vez: abra a conversa com a sua visão sobre o assunto.';
    const r = await turno(v, id, { tipo: 'fala', respondendoA: responde, contexto: `Assunto: ${v.dados.assunto}${conversaAteAgora(v.dados)}\n\n${pedido}` });
    if (r) registrar(v, mensagemDe(r, 'fala', { respondendoA: responde }));
    return r;
  };

  const sintese = async (v: Viva) => {
    const d = opts.ler();
    const seq = ordem(d);
    const moderadora = seq.find((id) => opts.persona(id, nomeDe(d, id)).papel === 'moderadora');
    const ultima = [...v.dados.mensagens].reverse().find((m) => m.tipo === 'fala' && m.persona)?.persona;
    const quem = moderadora ?? ultima ?? seq[0];
    if (!quem) return;
    const r = await turno(v, quem, {
      tipo: 'sintese',
      contexto: `Assunto: ${v.dados.assunto}${conversaAteAgora(v.dados)}\n\nAgora escreva a síntese final: a resposta polida ao assunto, clara e bem estruturada, com a recomendação, os principais argumentos de cada lado e os próximos passos. Pode usar títulos e listas.`,
    });
    if (r) {
      registrar(v, mensagemDe(r, 'sintese'));
      v.dados.resposta = r.resposta.texto.trim();
    }
  };

  /** As personas chamadas (com @, ou de volta por um pedido de mudança) falam antes da próxima vez. */
  const atenderChamadas = async (v: Viva) => {
    while (v.chamadas.length) {
      const c = v.chamadas.shift()!;
      await fala(v, c.id, c.a);
    }
  };

  /** As rodadas, a partir de `desde` (para retomar depois de reiniciar, na vez seguinte à humana). */
  const debate = async (v: Viva, desde = { rodada: 0, indice: 0 }) => {
    rodadas: for (let r = desde.rodada; r < v.dados.rodadas; r++) {
      const seq = ordem(opts.ler());
      for (let i = r === desde.rodada ? desde.indice : 0; i < seq.length; i++) {
        v.posicao = { rodada: r, indice: i };
        await atenderChamadas(v);
        if (v.sintetizarJa) break rodadas;
        await fala(v, seq[i]);
        if (v.sintetizarJa) break rodadas;
      }
    }
    v.posicao = undefined;
    await atenderChamadas(v);
    if (v.dados.modo === 'resposta' || v.sintetizarJa) {
      v.sintetizarJa = false;
      await sintese(v);
    }
  };

  // ---- tarefa ---------------------------------------------------------------------

  const tarefaDe = async (v: Viva, id: string, tarefa: string, pai: string | undefined, topo: boolean, quemPediu?: string): Promise<string | undefined> => {
    const d = opts.ler();
    const alcance = delegaveis(rodada(d), id);
    const objetivo = topo ? '' : `\n\nObjetivo geral do grupo: ${v.dados.assunto}`;

    // Sem para quem delegar (e não sendo a orquestradora): executa e entrega.
    if (!alcance.length && !topo) {
      const r = await turno(v, id, {
        tipo: 'execucao',
        contexto: `Tarefa delegada por ${quemPediu ?? 'a orquestradora'}: ${tarefa}${objetivo}\n\nEntregue o resultado completo, pronto para usar.`,
      });
      if (!r) return undefined;
      registrar(v, mensagemDe(r, 'resultado', { pai }));
      return r.resposta.texto.trim();
    }

    const nomes = alcance.map((a) => nomeDe(d, a));
    const r = await turno(v, id, {
      tipo: 'tarefa',
      delegaveis: alcance,
      contexto: [
        `Tarefa${quemPediu ? ` delegada por ${quemPediu}` : ''}: ${tarefa}${objetivo}`,
        alcance.length
          ? `Você pode delegar partes para: ${nomes.join(', ')}. Para delegar, escreva uma linha por parte, exatamente assim:\nDELEGAR <nome>: <o que essa persona deve fazer>\nAs delegadas trabalham em paralelo e você recebe os resultados para consolidar. Se der para fazer sozinha, entregue o resultado direto, sem linhas DELEGAR.`
          : 'Entregue o resultado completo.',
      ].join('\n\n'),
    });
    if (!r) return undefined;

    const pessoas = alcance.map((a) => ({ id: a, nome: nomeDe(d, a) }));
    const lidas = lerDelegacoes(r.resposta.texto, pessoas);
    const recusadas = [...lidas.recusadas];
    const delegacoes: Delegacao[] = [];
    for (const dl of [...(r.resposta.delegacoes ?? []), ...lidas.delegacoes]) {
      const p = acharPessoa(dl.para, pessoas);
      if (!p) recusadas.push(dl.para);
      else if (!delegacoes.some((x) => x.para === p.id)) delegacoes.push({ para: p.id, tarefa: dl.tarefa });
    }
    for (const nome of recusadas) sistema(v, `${r.persona.nome} tentou delegar para ${nome}, que não está ao alcance das setas dela: delegação ignorada.`);

    if (!delegacoes.length) {
      const texto = r.resposta.texto.trim();
      registrar(v, mensagemDe(r, topo ? 'sintese' : 'resultado', { pai }));
      return texto;
    }

    const plano = registrar(v, mensagemDe(r, 'tarefa', { pai, texto: lidas.resto || r.resposta.texto.trim() }));
    for (const dl of delegacoes) {
      emitir(v.dados, { type: 'chat.delegacao', de: id, deNome: r.persona.nome, para: dl.para, paraNome: nomeDe(d, dl.para), tarefa: dl.tarefa, pai: plano.id, arestas: arestas(d, [id], dl.para) });
    }
    // Em paralelo: cada delegada no seu motor.
    const resultados = await Promise.all(delegacoes.map((dl) => tarefaDe(v, dl.para, dl.tarefa, plano.id, false, r.persona.nome)));
    const juntos = delegacoes
      .map((dl, i) => `### ${nomeDe(d, dl.para)} (tarefa: ${dl.tarefa})\n${resultados[i] ?? '(não entregou: veja o erro no chat)'}`)
      .join('\n\n');
    const c = await turno(v, id, {
      tipo: 'consolidar',
      contexto: `Tarefa: ${tarefa}${objetivo}\n\nResultados das delegações:\n\n${juntos}\n\nJunte tudo numa entrega final única, coerente e completa, resolvendo contradições entre os resultados.`,
    });
    if (!c) return undefined;
    registrar(v, mensagemDe(c, topo ? 'sintese' : 'resultado', { pai }));
    return c.resposta.texto.trim();
  };

  const tarefa = async (v: Viva) => {
    const d = opts.ler();
    const seq = ordem(d);
    const orq = seq.find((id) => opts.persona(id, nomeDe(d, id)).papel === 'orquestradora') ?? seq[0];
    const entrega = await tarefaDe(v, orq, v.dados.assunto, undefined, true);
    if (entrega !== undefined) v.dados.resposta = entrega;
  };

  // ---- saída ---------------------------------------------------------------------------

  /** No fim: cada persona de saída preenche o seu template com o resultado da conversa. */
  const gerarSaidas = async (v: Viva) => {
    const d = opts.ler();
    for (const id of saidas(d)) {
      const template = opts.template?.(id) ?? '';
      const final = v.dados.resposta ? `\n\nResposta final:\n${v.dados.resposta}` : '';
      const r = await turno(v, id, {
        tipo: 'saida',
        respondendoA: predecessores(d, id),
        contexto: `Assunto: ${v.dados.assunto}${conversaAteAgora(v.dados)}${final}\n\nTemplate de saída:\n\n${template}\n\nAgora preencha o template com o resultado da conversa e devolva só o markdown.`,
      });
      if (!r) continue;
      const texto = semCerca(r.resposta.texto);
      registrar(v, mensagemDe(r, 'saida', { arquivo: r.persona.arquivo, texto }));
      opts.gravarSaida?.(v.dados.id, r.persona.arquivo, texto);
    }
  };

  // ---- ciclo de vida ------------------------------------------------------------------

  /** Roda `fn` como a execução da conversa, cuidando de parar, limite e fim. */
  const executar = (v: Viva, fn: () => Promise<void>) => {
    v.dados.status = 'rodando';
    v.execucao = (async () => {
      try {
        await fn();
        // @menções feitas durante a última vez (ex.: a síntese) ainda são respondidas.
        await atenderChamadas(v);
        v.dados.status = 'terminada';
      } catch (err) {
        if (err instanceof Parada) return;
        if (err instanceof Encerrada) {
          sistema(v, err.message);
          v.dados.status = 'terminada';
        } else if (err instanceof LimiteAtingido) {
          sistema(v, `A conversa atingiu o limite de ${limite} turnos e foi encerrada.`);
          v.dados.status = 'terminada';
        } else {
          sistema(v, `Erro na conversa: ${(err as Error).message}`);
          v.dados.status = 'terminada';
        }
      }
      salvar(v.dados);
      emitir(v.dados, { type: 'chat.fim', status: v.dados.status, resposta: v.dados.resposta });
    })();
  };

  const resumo = (c: Conversa) => ({
    id: c.id,
    assunto: c.assunto,
    modo: c.modo,
    status: c.status,
    mensagens: c.mensagens.length,
    criadaEm: c.criadaEm,
    atualizadaEm: c.atualizadaEm,
  });

  return {
    iniciar(entrada: { assunto?: unknown; modo?: unknown; rodadas?: unknown }): Conversa {
      const assunto = typeof entrada.assunto === 'string' ? entrada.assunto.trim() : '';
      if (!assunto) throw new OpError(400, 'Escreva o assunto da conversa.');
      const modo = (entrada.modo ?? 'debate') as Modo;
      if (!MODOS.includes(modo)) throw new OpError(400, `"modo" deve ser ${MODOS.join(', ')}.`);
      const rodadas = entrada.rodadas === undefined ? 2 : Number(entrada.rodadas);
      if (!Number.isInteger(rodadas) || rodadas < 1 || rodadas > 10) throw new OpError(400, '"rodadas" deve ser de 1 a 10.');
      const d = opts.ler();
      if (!d.nodes.length) throw new OpError(400, 'O diagrama não tem nenhuma persona: arraste um template para o canvas.');

      const dados: Conversa = { id: `c-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`, diagrama: opts.diagrama, assunto, modo, rodadas, status: 'rodando', mensagens: [], criadaEm: agora(), atualizadaEm: agora() };
      const v: Viva = { dados, parar: new AbortController(), chamadas: [], esperas: new Map(), sintetizarJa: false, turnos: 0, execucao: Promise.resolve(), emAndamento: new Map() };
      vivas.set(dados.id, v);
      emitir(dados, { type: 'chat.inicio', assunto, modo, rodadas, ordem: ordem(d).map((id) => nomeDe(d, id)) });
      registrar(v, { tipo: 'usuario', nome: 'Você', texto: assunto });
      executar(v, async () => {
        await (modo === 'tarefa' ? tarefa(v) : debate(v));
        await gerarSaidas(v);
      });
      return structuredClone(dados);
    },

    /** O usuário fala no chat. Com @persona, ela responde a seguir; depois do fim, alguém responde. */
    intervir(id: string, texto: unknown): Mensagem {
      const v = viva(id);
      const t = typeof texto === 'string' ? texto.trim() : '';
      if (!t) throw new OpError(400, 'Mensagem vazia.');
      const d = opts.ler();
      const alvo = mencionada(t, d.nodes.map((n) => ({ id: n.id, nome: n.text })));
      const msg = registrar(v, { tipo: 'usuario', nome: 'Você', texto: t });
      if (v.dados.status === 'rodando' || v.dados.status === 'aguardando') {
        if (alvo) v.chamadas.push({ id: alvo, a: ['usuario'] });
      } else {
        // Conversa encerrada: responde a mencionada, a moderadora ou a última que falou.
        const seq = ordem(d);
        const quem =
          alvo ??
          seq.find((p) => opts.persona(p, nomeDe(d, p)).papel === 'moderadora') ??
          [...v.dados.mensagens].reverse().find((m) => m.persona && seq.includes(m.persona))?.persona ??
          seq[0];
        v.parar = new AbortController();
        v.turnos = 0;
        executar(v, async () => {
          if (quem) await fala(v, quem, ['usuario']);
        });
      }
      return msg;
    },

    /** Pede a resposta polida agora: depois da vez em andamento (ou já, se a conversa acabou). */
    sintetizar(id: string) {
      const v = viva(id);
      if (v.dados.status === 'rodando' || v.dados.status === 'aguardando') v.sintetizarJa = true;
      else {
        v.parar = new AbortController();
        v.turnos = 0;
        executar(v, () => sintese(v));
      }
    },

    parar(id: string) {
      const v = viva(id);
      if (v.dados.status !== 'rodando' && v.dados.status !== 'aguardando') return;
      v.dados.status = 'parada';
      v.dados.espera = undefined;
      v.parar.abort();
      sistema(v, 'Conversa parada.');
    },

    /** A resposta do usuário na vez da persona humana (aprovar, pedir mudança ou encerrar). */
    responderHumano(id: string, r: RespostaHumana) {
      const v = viva(id);
      const e = v.dados.espera;
      if (v.dados.status !== 'aguardando' || !e) throw new OpError(409, 'A conversa não está esperando a sua resposta.');
      if (!ACOES_HUMANAS.includes(r?.acao)) throw new OpError(400, `"acao" deve ser ${ACOES_HUMANAS.join(', ')}.`);
      const resolver = v.esperas.get(e.turno);
      if (resolver) return resolver(r);
      // O servidor reiniciou durante a espera: registra a resposta e retoma do ponto salvo.
      v.dados.espera = undefined;
      v.parar = new AbortController();
      v.turnos = 0;
      executar(v, async () => {
        const d = opts.ler();
        const persona = opts.persona(e.persona, nomeDe(d, e.persona));
        registrar(v, { tipo: e.tipo === 'execucao' ? 'resultado' : 'fala', nome: persona.nome, persona: e.persona, turno: e.turno, texto: textoHumano(r) });
        if (r.acao === 'encerrar') throw new Encerrada(`Conversa encerrada por ${persona.nome}.`);
        if (v.dados.modo === 'tarefa') {
          sistema(v, 'A tarefa não pode continuar depois que o servidor reiniciou: a sua resposta ficou registrada.');
          return;
        }
        if (r.acao === 'mudar') for (const p of predecessores(rodada(d), e.persona)) v.chamadas.push({ id: p, a: [e.persona] });
        const pos = e.posicao ?? { rodada: v.dados.rodadas, indice: 0 };
        await debate(v, { rodada: pos.rodada, indice: pos.indice + 1 });
        await gerarSaidas(v);
      });
    },

    obter(id: string): Conversa {
      const c = structuredClone(carregar(id));
      return { ...c, pendentes: [...(vivas.get(id)?.emAndamento.values() ?? [])] };
    },

    listar() {
      const ids = new Set(vivas.keys());
      try {
        for (const f of fs.readdirSync(opts.dir)) if (f.endsWith('.json')) ids.add(f.slice(0, -5));
      } catch {}
      return [...ids]
        .map((id) => {
          try {
            return resumo(carregar(id));
          } catch {
            return undefined;
          }
        })
        .filter((c) => c !== undefined)
        .sort((a, b) => b.criadaEm.localeCompare(a.criadaEm));
    },

    /** Espera a execução atual da conversa terminar (testes e MCP). */
    async esperar(id: string): Promise<Conversa> {
      const v = viva(id);
      let atual: Promise<void>;
      do {
        atual = v.execucao;
        await atual;
      } while (atual !== v.execucao);
      return structuredClone(v.dados);
    },

    /** Para tudo (ao fechar o diagrama). */
    fechar() {
      for (const v of vivas.values()) if (v.dados.status === 'rodando') v.parar.abort();
    },
  };
}

class LimiteAtingido extends Error {}

/** Tira a cerca de código (```markdown … ```) que o modelo às vezes põe em volta do documento. */
function semCerca(texto: string) {
  const t = texto.trim();
  const m = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t);
  return (m ? m[1] : t).trim();
}

/** Uma promessa que só rejeita, quando o sinal é abortado. */
function cancelado(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Parada());
    signal.addEventListener('abort', () => reject(new Parada()), { once: true });
  });
}
