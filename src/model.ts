export interface DiagramNode {
  id: string;
  text: string;
  /** Centro do retângulo, em pixels do canvas. */
  x: number;
  y: number;
  /** Retângulos ativos ganham a borda verde (classe Mermaid `ativo`). */
  active?: boolean;
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  text: string;
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface ParseResult {
  diagram: Diagram;
  errors: string[];
}

const ID = '[A-Za-z_][\\w-]*';
const HEADER_RE = /^(flowchart|graph)(\s+(TB|TD|BT|LR|RL))?$/;
const NODE_RE = new RegExp(`^(${ID})\\((?:"([^"]*)"|([^()"]*))\\)$`);
const EDGE_RE = new RegExp(`^(${ID})\\s*-->\\s*(?:\\|(?:"([^"]*)"|([^|"]*))\\|\\s*)?(${ID})$`);
const CLASS_RE = new RegExp(`^class\\s+(${ID}(?:\\s*,\\s*${ID})*)\\s+(${ID})$`);
const POS_RE = new RegExp(`^%%\\s*@pos\\s+(${ID})\\s+(-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)$`);

const escape = (s: string) => s.replace(/"/g, '#quot;');
const unescape = (s: string) => s.replace(/#quot;/g, '"');

export const ACTIVE_CLASS = 'ativo';
export const ACTIVE_COLOR = '#1f9d55';

/**
 * Gera o código Mermaid. As posições do canvas vão em comentários `%% @pos`,
 * que o Mermaid ignora, para que o código sozinho reconstrua o desenho.
 */
export function toMermaid(d: Diagram): string {
  const lines = ['flowchart LR'];
  for (const n of d.nodes) lines.push(`    ${n.id}("${escape(n.text)}")`);
  for (const e of d.edges) {
    lines.push(e.text ? `    ${e.from} -->|"${escape(e.text)}"| ${e.to}` : `    ${e.from} --> ${e.to}`);
  }
  const active = d.nodes.filter((n) => n.active).map((n) => n.id);
  if (active.length) {
    lines.push(`    classDef ${ACTIVE_CLASS} stroke:${ACTIVE_COLOR},stroke-width:3px`);
    lines.push(`    class ${active.join(',')} ${ACTIVE_CLASS}`);
  }
  if (d.nodes.length) lines.push('');
  for (const n of d.nodes) lines.push(`%% @pos ${n.id} ${Math.round(n.x)} ${Math.round(n.y)}`);
  return lines.join('\n');
}

/**
 * Lê o subconjunto suportado: retângulos arredondados `A(texto)` e setas `A -->|texto| B`.
 * Nós sem `%% @pos` reaproveitam a posição de `previous` ou recebem uma posição em grade.
 */
export function parseMermaid(code: string, previous?: Diagram): ParseResult {
  const errors: string[] = [];
  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  const positions = new Map<string, { x: number; y: number }>();
  const activeIds = new Set<string>();

  const ensureNode = (id: string) => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, text: id, x: NaN, y: NaN };
      nodes.set(id, n);
    }
    return n;
  };

  code.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim().replace(/;$/, '');
    if (!line) return;

    const pos = POS_RE.exec(line);
    if (pos) {
      positions.set(pos[1], { x: Number(pos[2]), y: Number(pos[3]) });
      return;
    }
    if (line.startsWith('%%') || line.startsWith('classDef ') || HEADER_RE.test(line)) return;

    const cls = CLASS_RE.exec(line);
    if (cls) {
      if (cls[2] === ACTIVE_CLASS) for (const id of cls[1].split(',')) activeIds.add(id.trim());
      return;
    }

    const node = NODE_RE.exec(line);
    if (node) {
      ensureNode(node[1]).text = unescape(node[2] ?? node[3] ?? '');
      return;
    }

    const edge = EDGE_RE.exec(line);
    if (edge) {
      const [, from, quoted, plain, to] = edge;
      ensureNode(from);
      ensureNode(to);
      edges.push({ id: `e${edges.length + 1}`, from, to, text: unescape(quoted ?? plain ?? '').trim() });
      return;
    }

    errors.push(`Linha ${i + 1}: não reconhecida — "${line}"`);
  });

  for (const id of activeIds) {
    const n = nodes.get(id);
    if (n) n.active = true;
  }

  const prev = new Map(previous?.nodes.map((n) => [n.id, n]));
  const unplaced: DiagramNode[] = [];
  for (const n of nodes.values()) {
    const p = positions.get(n.id) ?? prev.get(n.id);
    if (p) {
      n.x = p.x;
      n.y = p.y;
    } else {
      unplaced.push(n);
    }
  }
  // Nós sem posição vão para a primeira vaga livre de uma grade.
  const taken = [...nodes.values()].filter((n) => !unplaced.includes(n));
  let slot = 0;
  for (const n of unplaced) {
    do {
      n.x = 140 + (slot % 4) * 220;
      n.y = 80 + Math.floor(slot / 4) * 110;
      slot++;
    } while (taken.some((t) => Math.abs(t.x - n.x) < 180 && Math.abs(t.y - n.y) < 70));
    taken.push(n);
  }

  return { diagram: { nodes: [...nodes.values()], edges }, errors };
}

export function nextId(prefix: string, ids: string[]): string {
  let max = 0;
  for (const id of ids) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}
