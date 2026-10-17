import type { DiagramNode } from './model';
import type { Store } from './store';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const DND_TYPE = 'application/x-mermaid-draw';
export const FONT = '14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const NODE_H = 44;
const NODE_MIN_W = 120;
const NODE_PAD = 20;
const RADIUS = 12;

const measureCtx = document.createElement('canvas').getContext('2d')!;
measureCtx.font = FONT;
const textWidth = (s: string) => Math.ceil(measureCtx.measureText(s).width);

export function nodeSize(n: DiagramNode) {
  return { w: Math.max(NODE_MIN_W, textWidth(n.text) + NODE_PAD * 2), h: NODE_H };
}

type Point = { x: number; y: number };
type Drag =
  | { kind: 'move'; id: string; dx: number; dy: number }
  | { kind: 'connect'; from: string; at: Point; /** iniciada por drop da paleta: termina no próximo clique */ sticky: boolean };

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent?.append(e);
  return e;
}

/** Ponto onde a reta do centro de `n` até `toward` cruza a borda do retângulo. */
function borderPoint(n: DiagramNode, toward: Point): Point {
  const { w, h } = nodeSize(n);
  const dx = toward.x - n.x;
  const dy = toward.y - n.y;
  if (!dx && !dy) return { x: n.x, y: n.y };
  const t = Math.min(dx ? w / 2 / Math.abs(dx) : Infinity, dy ? h / 2 / Math.abs(dy) : Infinity);
  return { x: n.x + dx * t, y: n.y + dy * t };
}

export class Canvas {
  private svg = el('svg', { class: 'canvas-svg' });
  private edgeLayer = el('g');
  private nodeLayer = el('g');
  private overlay = el('g', { class: 'overlay' });
  private drag: Drag | null = null;
  private editor: HTMLInputElement | null = null;
  /** Duplo clique detectado à mão: o render recria os elementos entre os cliques. */
  private lastDown = { key: '', time: 0 };

  constructor(
    private host: HTMLElement,
    private store: Store,
  ) {
    this.svg.style.font = FONT;
    const defs = el('defs', {}, this.svg);
    for (const [id, cls] of [['arrow', 'arrow-head'], ['arrow-sel', 'arrow-head selected']]) {
      const m = el('marker', { id, viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 9, markerHeight: 9, orient: 'auto-start-reverse' }, defs);
      el('path', { d: 'M0 0 L10 5 L0 10 Z', class: cls }, m);
    }
    this.svg.append(this.edgeLayer, this.nodeLayer, this.overlay);
    host.append(this.svg);

    this.svg.addEventListener('pointerdown', this.onDown);
    this.svg.addEventListener('pointermove', this.onMove);
    this.svg.addEventListener('pointerup', this.onUp);
    host.addEventListener('dragover', this.onDragOver);
    host.addEventListener('drop', this.onDrop);

    store.subscribe(() => this.render());
    this.render();
  }

  get connecting() {
    return this.drag?.kind === 'connect';
  }

  cancel() {
    if (this.drag?.kind === 'connect') {
      this.drag = null;
      this.store.emit('view');
    }
  }

  private point(e: { clientX: number; clientY: number }): Point {
    const r = this.svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private nodeAt(clientX: number, clientY: number): string | undefined {
    const hit = document.elementFromPoint(clientX, clientY)?.closest<SVGElement>('[data-node]');
    return hit?.dataset.node;
  }

  // ---- interação -------------------------------------------------------

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const p = this.point(e);
    const target = e.target as Element;

    if (this.drag?.kind === 'connect' && this.drag.sticky) {
      this.finishConnect(e);
      return;
    }

    const toggle = target.closest<SVGElement>('[data-toggle]');
    if (toggle) {
      this.lastDown = { key: '', time: 0 };
      this.store.selection = { kind: 'node', id: toggle.dataset.toggle! };
      this.store.toggleActive(toggle.dataset.toggle!);
      return;
    }

    const handle = target.closest<SVGElement>('[data-handle]');
    const nodeEl = target.closest<SVGElement>('[data-node]');
    const edgeEl = target.closest<SVGElement>('[data-edge]');

    const key = handle ? '' : nodeEl ? `n:${nodeEl.dataset.node}` : edgeEl ? `e:${edgeEl.dataset.edge}` : 'bg';
    const isDouble = key !== '' && key === this.lastDown.key && e.timeStamp - this.lastDown.time < 350;
    this.lastDown = isDouble ? { key: '', time: 0 } : { key, time: e.timeStamp };
    if (isDouble) {
      e.preventDefault();
      this.onDoubleClick(p, nodeEl?.dataset.node, edgeEl?.dataset.edge);
      return;
    }

    if (handle || (nodeEl && this.store.mode === 'arrow')) {
      const from = (handle?.dataset.handle ?? nodeEl!.dataset.node)!;
      this.drag = { kind: 'connect', from, at: p, sticky: false };
      this.svg.setPointerCapture(e.pointerId);
      this.store.emit('view');
      return;
    }
    if (nodeEl) {
      const n = this.store.node(nodeEl.dataset.node!)!;
      this.drag = { kind: 'move', id: n.id, dx: p.x - n.x, dy: p.y - n.y };
      this.svg.setPointerCapture(e.pointerId);
      this.store.select({ kind: 'node', id: n.id });
      return;
    }
    if (edgeEl) {
      this.store.select({ kind: 'edge', id: edgeEl.dataset.edge! });
      return;
    }
    this.store.select(null);
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    const p = this.point(e);
    if (d.kind === 'move') {
      const n = this.store.node(d.id);
      if (!n) return;
      n.x = p.x - d.dx;
      n.y = p.y - d.dy;
      this.store.emit('canvas');
    } else {
      d.at = p;
      this.render();
    }
  };

  private onUp = (e: PointerEvent) => {
    if (this.drag?.kind === 'connect' && !this.drag.sticky) this.finishConnect(e);
    else if (this.drag?.kind === 'move') this.drag = null;
  };

  private finishConnect(e: PointerEvent) {
    const from = this.drag?.kind === 'connect' ? this.drag.from : undefined;
    this.drag = null;
    const to = this.nodeAt(e.clientX, e.clientY);
    const edge = from && to ? this.store.addEdge(from, to) : undefined;
    if (edge) this.edit('edge', edge.id);
    else this.store.emit('view');
  }

  private onDoubleClick(p: Point, nodeId?: string, edgeId?: string) {
    this.drag = null;
    if (nodeId) this.edit('node', nodeId);
    else if (edgeId) this.edit('edge', edgeId);
    else this.edit('node', this.store.addNode(p.x, p.y).id);
  }

  private onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DND_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  private onDrop = (e: DragEvent) => {
    const tool = e.dataTransfer?.getData(DND_TYPE);
    if (!tool) return;
    e.preventDefault();
    const p = this.point(e);
    if (tool === 'rect') {
      this.edit('node', this.store.addNode(p.x, p.y).id);
    } else if (tool === 'arrow') {
      // Soltar a seta sobre um retângulo define a origem; o próximo clique define o destino.
      const from = this.nodeAt(e.clientX, e.clientY);
      if (!from) return;
      this.drag = { kind: 'connect', from, at: p, sticky: true };
      this.store.select({ kind: 'node', id: from });
    }
  };

  // ---- edição de texto -------------------------------------------------

  edit(kind: 'node' | 'edge', id: string) {
    this.editor?.blur();
    let anchor: Point;
    let value: string;
    if (kind === 'node') {
      const n = this.store.node(id);
      if (!n) return;
      anchor = n;
      value = n.text;
    } else {
      const e = this.store.edge(id);
      const a = e && this.store.node(e.from);
      const b = e && this.store.node(e.to);
      if (!e || !a || !b) return;
      anchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      value = e.text;
    }

    const input = document.createElement('input');
    input.className = 'inline-editor';
    input.value = value;
    input.placeholder = kind === 'node' ? 'Texto do retângulo' : 'Texto da seta';
    input.style.left = `${anchor.x}px`;
    input.style.top = `${anchor.y}px`;
    this.host.append(input);
    this.editor = input;
    input.focus();
    input.select();

    let done = false;
    const close = (commit: boolean) => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      input.remove();
      if (this.editor === input) this.editor = null;
      if (!commit) return;
      if (kind === 'node') {
        const n = this.store.node(id);
        if (n && text) n.text = text;
      } else {
        const e = this.store.edge(id);
        if (e) e.text = text;
      }
      this.store.emit('canvas');
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') close(true);
      if (ev.key === 'Escape') close(false);
    });
    input.addEventListener('blur', () => close(true));
  }

  // ---- render ----------------------------------------------------------

  render() {
    const { diagram, selection, mode } = this.store;
    const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
    this.svg.classList.toggle('mode-arrow', mode === 'arrow' || this.connecting);
    this.edgeLayer.replaceChildren();
    this.nodeLayer.replaceChildren();
    this.overlay.replaceChildren();

    for (const e of diagram.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const selected = selection?.kind === 'edge' && selection.id === e.id;
      const g = el('g', { class: `edge${selected ? ' selected' : ''}`, 'data-edge': e.id }, this.edgeLayer);
      const p1 = borderPoint(a, b);
      const p2 = borderPoint(b, a);
      const line = { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
      el('line', { ...line, class: 'edge-hit' }, g);
      el('line', { ...line, class: 'edge-line', 'marker-end': `url(#${selected ? 'arrow-sel' : 'arrow'})` }, g);
      if (e.text) {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const w = textWidth(e.text) + 12;
        el('rect', { x: mx - w / 2, y: my - 11, width: w, height: 22, rx: 6, class: 'edge-label-bg' }, g);
        el('text', { x: mx, y: my, class: 'edge-label' }, g).textContent = e.text;
      }
    }

    for (const n of diagram.nodes) {
      const { w, h } = nodeSize(n);
      const selected = selection?.kind === 'node' && selection.id === n.id;
      const g = el(
        'g',
        { class: `node${selected ? ' selected' : ''}${n.active ? ' active' : ''}`, 'data-node': n.id, transform: `translate(${n.x - w / 2} ${n.y - h / 2})` },
        this.nodeLayer,
      );
      if (selected) el('rect', { x: -4, y: -4, width: w + 8, height: h + 8, rx: RADIUS + 4, class: 'node-halo' }, g);
      el('rect', { width: w, height: h, rx: RADIUS, class: 'node-rect' }, g);
      el('text', { x: w / 2, y: h / 2, class: 'node-label' }, g).textContent = n.text;
      el('circle', { cx: w, cy: h / 2, r: 6, class: 'handle', 'data-handle': n.id }, g);
      const toggle = el('g', { class: 'status', 'data-toggle': n.id }, g);
      el('title', {}, toggle).textContent = n.active ? 'Ativo — clique para inativar' : 'Inativo — clique para ativar';
      el('circle', { cx: 11, cy: h / 2, r: 9, class: 'status-hit' }, toggle);
      el('circle', { cx: 11, cy: h / 2, r: 4, class: 'status-dot' }, toggle);
    }

    if (this.drag?.kind === 'connect') {
      const from = byId.get(this.drag.from);
      if (from) {
        const p1 = borderPoint(from, this.drag.at);
        el('line', { x1: p1.x, y1: p1.y, x2: this.drag.at.x, y2: this.drag.at.y, class: 'edge-pending', 'marker-end': 'url(#arrow-sel)' }, this.overlay);
      }
    }
  }
}
