import { nextId, type Diagram, type DiagramEdge, type DiagramNode } from './model';

export type Selection = { kind: 'node' | 'edge'; id: string } | null;
export type Mode = 'select' | 'arrow';
/**
 * `view`: só seleção/modo mudou. `canvas`, `code` e `remote`: o diagrama mudou, e de onde veio
 * (`remote` = servidor, por exemplo um curl na API).
 */
export type Change = 'view' | 'canvas' | 'code' | 'remote';

export class Store {
  selection: Selection = null;
  mode: Mode = 'select';
  private listeners: ((change: Change) => void)[] = [];

  constructor(public diagram: Diagram) {}

  subscribe(fn: (change: Change) => void) {
    this.listeners.push(fn);
  }

  emit(change: Change) {
    for (const fn of this.listeners) fn(change);
  }

  node(id: string) {
    return this.diagram.nodes.find((n) => n.id === id);
  }

  edge(id: string) {
    return this.diagram.edges.find((e) => e.id === id);
  }

  setDiagram(d: Diagram, change: Change) {
    const sel = this.selection;
    this.diagram = d;
    // Mudanças remotas não devem tirar a seleção de quem está editando.
    const keep = change === 'remote' && sel && (sel.kind === 'node' ? this.node(sel.id) : this.edge(sel.id));
    this.selection = keep ? sel : null;
    this.emit(change);
  }

  select(selection: Selection) {
    this.selection = selection;
    this.emit('view');
  }

  setMode(mode: Mode) {
    this.mode = mode;
    this.emit('view');
  }

  addNode(x: number, y: number, text = 'Novo'): DiagramNode {
    const n = { id: nextId('n', this.diagram.nodes.map((n) => n.id)), text, x, y };
    this.diagram.nodes.push(n);
    this.selection = { kind: 'node', id: n.id };
    this.emit('canvas');
    return n;
  }

  addEdge(from: string, to: string, text = ''): DiagramEdge | undefined {
    if (from === to) return;
    if (this.diagram.edges.some((e) => e.from === from && e.to === to)) return;
    const e = { id: nextId('e', this.diagram.edges.map((e) => e.id)), from, to, text };
    this.diagram.edges.push(e);
    this.selection = { kind: 'edge', id: e.id };
    this.emit('canvas');
    return e;
  }

  toggleActive(id: string) {
    const n = this.node(id);
    if (!n) return;
    n.active = !n.active;
    this.emit('canvas');
  }

  removeSelected() {
    const sel = this.selection;
    if (!sel) return;
    const d = this.diagram;
    if (sel.kind === 'node') {
      d.nodes = d.nodes.filter((n) => n.id !== sel.id);
      d.edges = d.edges.filter((e) => e.from !== sel.id && e.to !== sel.id);
    } else {
      d.edges = d.edges.filter((e) => e.id !== sel.id);
    }
    this.selection = null;
    this.emit('canvas');
  }
}
