/**
 * O memoria.md do diagrama visto como o "palácio": salas (## título) com itens (- texto). Funções
 * puras: o resumo que as personas recebem no início e a busca do RECORDAR (sem LLM, por palavras).
 */

export interface Sala {
  titulo: string;
  itens: string[];
}

export interface Achado {
  sala: string;
  texto: string;
}

const ITEM_RE = /^\s*[-*]\s+(.+?)\s*$/;

export function lerSalas(md: string): Sala[] {
  const salas: Sala[] = [];
  for (const linha of md.split('\n')) {
    const titulo = /^##\s+(.+?)\s*$/.exec(linha);
    if (titulo) {
      salas.push({ titulo: titulo[1], itens: [] });
      continue;
    }
    const item = ITEM_RE.exec(linha);
    if (item && salas.length) salas.at(-1)!.itens.push(item[1]);
  }
  return salas;
}

/** As salas pedidas, em texto curto ("Decisões:\n- …"), cortado em itens inteiros até `limite` caracteres. */
export function resumo(md: string, salas: string[], limite: number): string {
  let texto = '';
  for (const s of lerSalas(md).filter((x) => salas.includes(x.titulo) && x.itens.length)) {
    for (const [i, item] of s.itens.entries()) {
      const pedaco = `${i === 0 ? `${texto ? '\n' : ''}${s.titulo}:\n` : ''}- ${item}\n`;
      if ((texto + pedaco).trimEnd().length > limite) return texto.trimEnd();
      texto += pedaco;
    }
  }
  return texto.trimEnd();
}

const normalizar = (t: string) =>
  t
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
const palavras = (t: string) => new Set(normalizar(t).split(/[^\p{L}\p{N}]+/u).filter((p) => p.length >= 3));

/** Os `n` itens com mais palavras da pergunta (sem acento, palavra inteira); nada se nenhum casar. */
export function buscar(md: string, pergunta: string, n: number): Achado[] {
  const procuradas = palavras(pergunta);
  const achados: (Achado & { pontos: number; ordem: number })[] = [];
  for (const s of lerSalas(md)) {
    for (const texto of s.itens) {
      const doItem = palavras(texto);
      const pontos = [...procuradas].filter((p) => doItem.has(p)).length;
      if (pontos) achados.push({ sala: s.titulo, texto, pontos, ordem: achados.length });
    }
  }
  return achados
    .sort((a, b) => b.pontos - a.pontos || a.ordem - b.ordem)
    .slice(0, n)
    .map(({ sala, texto }) => ({ sala, texto }));
}
