/**
 * O palácio da memória no navegador: os itens do memoria.md com a sala, a origem (persona ·
 * conversa) e o status, a busca, e a edição de um item sem mexer no resto do arquivo.
 */

export interface ItemDoPalacio {
  sala: string;
  /** A posição do item dentro da sala (para editar e remover). */
  indice: number;
  texto: string;
  persona?: string;
  conversa?: string;
  status: 'valido' | 'superado' | 'contestado';
}

const ITEM_RE = /^\s*[-*]\s+(.+?)\s*$/;
const SALA_RE = /^##\s+(.+?)\s*$/;
/** A origem no fim do item: "(Cética · c-1)". */
const ORIGEM_RE = /\(([^()·]+?)\s*·\s*([^()·]+?)\)\s*$/;

export function itensDoPalacio(md: string): ItemDoPalacio[] {
  const itens: ItemDoPalacio[] = [];
  let sala = '';
  let indice = 0;
  for (const linha of md.split('\n')) {
    const s = SALA_RE.exec(linha);
    if (s) {
      sala = s[1];
      indice = 0;
      continue;
    }
    const m = ITEM_RE.exec(linha);
    if (!m || !sala) continue;
    const origem = ORIGEM_RE.exec(m[1]);
    const status = /\(superado\)/i.test(m[1]) ? 'superado' : /\(contestado\)/i.test(m[1]) ? 'contestado' : 'valido';
    itens.push({ sala, indice: indice++, texto: m[1], persona: origem?.[1].trim(), conversa: origem?.[2].trim(), status });
  }
  return itens;
}

const normalizar = (t: string) =>
  t
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

export function filtrar(itens: ItemDoPalacio[], f: { busca?: string; persona?: string; conversa?: string }) {
  const busca = normalizar(f.busca?.trim() ?? '');
  return itens.filter((i) => (!busca || normalizar(i.texto).includes(busca)) && (!f.persona || i.persona === f.persona) && (!f.conversa || i.conversa === f.conversa));
}

/** A linha do item `indice` da `sala` no .md (ou -1). */
function linhaDoItem(linhas: string[], sala: string, indice: number) {
  let atual = '';
  let n = 0;
  for (const [i, linha] of linhas.entries()) {
    const s = SALA_RE.exec(linha);
    if (s) {
      atual = s[1];
      n = 0;
      continue;
    }
    if (atual === sala && ITEM_RE.test(linha) && n++ === indice) return i;
  }
  return -1;
}

export function editarItem(md: string, sala: string, indice: number, texto: string) {
  const linhas = md.split('\n');
  const i = linhaDoItem(linhas, sala, indice);
  if (i >= 0) linhas[i] = `- ${texto.trim()}`;
  return linhas.join('\n');
}

export function removerItem(md: string, sala: string, indice: number) {
  const linhas = md.split('\n');
  const i = linhaDoItem(linhas, sala, indice);
  if (i >= 0) linhas.splice(i, 1);
  return linhas.join('\n');
}
