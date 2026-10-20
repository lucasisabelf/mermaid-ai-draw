import type { Diagram } from '../src/model.ts';

/**
 * As setas dizem quem responde a quem: A → B faz B falar depois de A, respondendo a ele. No modo
 * tarefa, a mesma seta quer dizer "A pode delegar para B". Tudo aqui é função pura do diagrama.
 */

const outras = (d: Diagram) => d.edges.filter((e) => e.from !== e.to);

/** Quem abre a rodada: os retângulos sem seta chegando; num ciclo puro, o primeiro retângulo. */
export function raizes(d: Diagram): string[] {
  const comEntrada = new Set(outras(d).map((e) => e.to));
  const r = d.nodes.filter((n) => !comEntrada.has(n.id)).map((n) => n.id);
  return r.length || !d.nodes.length ? r : [d.nodes[0].id];
}

/**
 * A ordem de uma rodada: a partir dos blocos de início (`inicios`; sem nenhum, das raízes), em
 * largura e na ordem das setas, cada retângulo uma vez. Quem não foi alcançado entra depois, a
 * partir do primeiro retângulo que sobrou.
 */
export function ordemDaRodada(d: Diagram, inicios: string[] = []): string[] {
  const vistos = new Set<string>();
  const ordem: string[] = [];
  const percorrer = (inicio: string[]) => {
    const fila = inicio.filter((id) => !vistos.has(id));
    for (const id of fila) vistos.add(id);
    while (fila.length) {
      const id = fila.shift()!;
      ordem.push(id);
      for (const e of outras(d)) {
        if (e.from === id && !vistos.has(e.to)) {
          vistos.add(e.to);
          fila.push(e.to);
        }
      }
    }
  };
  const marcados = d.nodes.filter((n) => inicios.includes(n.id)).map((n) => n.id);
  percorrer(marcados.length ? marcados : raizes(d));
  for (const n of d.nodes) if (!vistos.has(n.id)) percorrer([n.id]);
  return ordem;
}

/** A quem `id` responde: as origens das setas que chegam nele. */
export function predecessores(d: Diagram, id: string): string[] {
  return [...new Set(outras(d).filter((e) => e.to === id).map((e) => e.from))];
}

/** Para quem `id` pode delegar: os destinos das setas que saem dele. */
export function delegaveis(d: Diagram, id: string): string[] {
  return [...new Set(outras(d).filter((e) => e.from === id).map((e) => e.to))];
}

/** Ids das setas de `de` para `para` (para a "mensagem" percorrer no canvas). */
export function arestas(d: Diagram, de: string[], para: string): string[] {
  return d.edges.filter((e) => e.to === para && de.includes(e.from)).map((e) => e.id);
}

/** Minúsculas e sem acento, para comparar nomes. */
export const normalizar = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();

type Pessoa = { id: string; nome: string };

/** Acha a pessoa pelo nome (ou id), sem diferenciar acento e maiúsculas, aceitando um @ na frente. */
export function acharPessoa(nome: string, pessoas: Pessoa[]): Pessoa | undefined {
  const n = normalizar(nome.replace(/^@/, ''));
  return pessoas.find((p) => normalizar(p.nome) === n || p.id.toLowerCase() === n);
}

/** A persona mencionada com @ no texto (o nome mais longo que casar, para "Moderadora Geral"). */
export function mencionada(texto: string, pessoas: Pessoa[]): string | undefined {
  const t = normalizar(texto);
  const candidatas = [...pessoas].sort((a, b) => b.nome.length - a.nome.length);
  for (const p of candidatas) {
    for (const alvo of [normalizar(p.nome), p.id.toLowerCase()]) {
      const i = t.indexOf(`@${alvo}`);
      const depois = t[i + alvo.length + 1];
      if (i >= 0 && (depois === undefined || !/[\p{L}\p{N}]/u.test(depois))) return p.id;
    }
  }
  return undefined;
}

export interface Delegacao {
  para: string;
  tarefa: string;
}

const DELEGAR_RE = /^\s*delegar\s+@?([^:]+?)\s*:\s*(.+)$/i;

/**
 * Lê as linhas `DELEGAR <persona>: <tarefa>` de uma resposta. Só valem as `permitidas` (alcançáveis
 * pelas setas); as outras voltam em `recusadas`. `resto` é o texto sem essas linhas.
 */
export function lerDelegacoes(texto: string, permitidas: Pessoa[]) {
  const delegacoes: Delegacao[] = [];
  const recusadas: string[] = [];
  const resto: string[] = [];
  for (const linha of texto.split('\n')) {
    const m = DELEGAR_RE.exec(linha);
    if (!m) {
      resto.push(linha);
      continue;
    }
    const p = acharPessoa(m[1], permitidas);
    if (p) delegacoes.push({ para: p.id, tarefa: m[2].trim() });
    else recusadas.push(m[1].trim());
  }
  return { delegacoes, recusadas, resto: resto.join('\n').trim() };
}
