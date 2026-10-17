import { cleanOwner, OWNER_MAX, type DiagramNode } from './model';
import type { Change, Selection, Store } from './store';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const DND_TYPE = 'application/x-mermaid-draw';
export const FONT = '14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const OWNER_FONT = FONT.replace('14px', '12px');
const NODE_H = 44;
/** Altura quando há responsável: uma segunda linha, menor, abaixo do texto. */
const NODE_H_OWNER = 58;
const NODE_MIN_W = 120;
const NODE_PAD = 20;
const RADIUS = 12;

const measureCtx = document.createElement('canvas').getContext('2d')!;
measureCtx.font = FONT;
const textWidth = (s: string, font = FONT) => {
  measureCtx.font = font;
  return Math.ceil(measureCtx.measureText(s).width);
};

export function nodeSize(n: DiagramNode) {
  const content = Math.max(textWidth(n.text), n.owner ? textWidth(n.owner, OWNER_FONT) + 16 : 0);
  return { w: Math.max(NODE_MIN_W, content + NODE_PAD * 2), h: n.owner ? NODE_H_OWNER : NODE_H };
}

type Point = { x: number; y: number };
type Drag =
  | { kind: 'move'; id: string; dx: number; dy: number }
  | {
      kind: 'connect';
      from: string;
      at: Point;
      /** iniciada por drop da paleta: termina no próximo clique */
      sticky: boolean;
      /** o ponteiro chegou a se mover; um clique parado no próprio retângulo não vira ciclo */
      moved: boolean;
    };

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

const LOOP_SPREAD = 18;
const LOOP_HEIGHT = 60;

/** Caminho da seta e posição do texto. `a === b` é um ciclo: um laço por cima do retângulo. */
function edgeGeometry(a: DiagramNode, b: DiagramNode): { d: string; label: Point } {
  if (a === b) {
    const top = a.y - nodeSize(a).h / 2;
    const x1 = a.x - LOOP_SPREAD;
    const x2 = a.x + LOOP_SPREAD;
    return {
      d: `M ${x1} ${top} C ${x1 - 36} ${top - LOOP_HEIGHT}, ${x2 + 36} ${top - LOOP_HEIGHT}, ${x2} ${top}`,
      label: { x: a.x, y: top - LOOP_HEIGHT * 0.75 - 16 },
    };
  }
  const p1 = borderPoint(a, b);
  const p2 = borderPoint(b, a);
  return { d: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`, label: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

export class Canvas {
  private svg = el('svg', { class: 'canvas-svg' });
  private edgeLayer = el('g');
  private nodeLayer = el('g');
  private overlay = el('g', { class: 'overlay' });
  private drag: Drag | null = null;
  private editor: HTMLInputElement | null = null;
  /** Elementos SVG por id: cada mudança redesenha só o retângulo/seta afetado. */
  private nodeEls = new Map<string, SVGGElement>();
  private edgeEls = new Map<string, SVGGElement>();
  /** Posição e largura já desenhadas de cada retângulo: as setas só mudam se isso mudar. */
  private nodeGeometry = new Map<string, string>();
  /** Seleção já desenhada, para redesenhar só o que entrou e saiu dela. */
  private shownSelection: Selection = null;
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

    store.subscribe(this.onChange);
    this.renderAll();
  }

  get connecting() {
    return this.drag?.kind === 'connect';
  }

  cancel() {
    if (this.drag?.kind === 'connect') {
      this.drag = null;
      this.store.emit({ source: 'view' });
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
      this.store.select({ kind: 'node', id: toggle.dataset.toggle! });
      this.store.toggleActive(toggle.dataset.toggle!);
      return;
    }

    const addOwner = target.closest<SVGElement>('[data-add-owner]');
    if (addOwner) {
      e.preventDefault();
      this.lastDown = { key: '', time: 0 };
      this.store.select({ kind: 'node', id: addOwner.dataset.addOwner! });
      this.edit('owner', addOwner.dataset.addOwner!);
      return;
    }

    const handle = target.closest<SVGElement>('[data-handle]');
    const nodeEl = target.closest<SVGElement>('[data-node]');
    const edgeEl = target.closest<SVGElement>('[data-edge]');
    const ownerEl = target.closest<SVGElement>('[data-owner]');

    const key = handle ? '' : ownerEl ? `o:${nodeEl?.dataset.node}` : nodeEl ? `n:${nodeEl.dataset.node}` : edgeEl ? `e:${edgeEl.dataset.edge}` : 'bg';
    const isDouble = key !== '' && key === this.lastDown.key && e.timeStamp - this.lastDown.time < 350;
    this.lastDown = isDouble ? { key: '', time: 0 } : { key, time: e.timeStamp };
    if (isDouble) {
      e.preventDefault();
      this.onDoubleClick(p, nodeEl?.dataset.node, edgeEl?.dataset.edge, Boolean(ownerEl));
      return;
    }

    if (handle || (nodeEl && this.store.mode === 'arrow')) {
      const from = (handle?.dataset.handle ?? nodeEl!.dataset.node)!;
      this.drag = { kind: 'connect', from, at: p, sticky: false, moved: false };
      this.svg.setPointerCapture(e.pointerId);
      this.store.emit({ source: 'view' });
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
      if (this.store.node(d.id)) this.store.updateNode(d.id, { x: p.x - d.dx, y: p.y - d.dy });
    } else {
      if (Math.hypot(p.x - d.at.x, p.y - d.at.y) > 4) d.moved = true;
      d.at = p;
      this.renderOverlay();
    }
  };

  private onUp = (e: PointerEvent) => {
    if (this.drag?.kind === 'connect' && !this.drag.sticky) this.finishConnect(e);
    else if (this.drag?.kind === 'move') this.drag = null;
  };

  private finishConnect(e: PointerEvent) {
    const d = this.drag?.kind === 'connect' ? this.drag : undefined;
    this.drag = null;
    const from = d?.from;
    const to = this.nodeAt(e.clientX, e.clientY);
    if (to === from && !d?.moved) return this.store.emit({ source: 'view' });
    const edge = from && to ? this.store.addEdge(from, to) : undefined;
    if (edge) this.edit('edge', edge.id);
    else this.store.emit({ source: 'view' });
  }

  private onDoubleClick(p: Point, nodeId?: string, edgeId?: string, owner = false) {
    this.drag = null;
    if (nodeId) this.edit(owner ? 'owner' : 'node', nodeId);
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
      this.drag = { kind: 'connect', from, at: p, sticky: true, moved: true };
      this.store.select({ kind: 'node', id: from });
    }
  };

  // ---- edição de texto -------------------------------------------------

  edit(kind: 'node' | 'edge' | 'owner', id: string) {
    this.editor?.blur();
    let anchor: Point;
    let value: string;
    if (kind === 'edge') {
      const e = this.store.edge(id);
      const a = e && this.store.node(e.from);
      const b = e && this.store.node(e.to);
      if (!e || !a || !b) return;
      anchor = edgeGeometry(a, b).label;
      value = e.text;
    } else {
      const n = this.store.node(id);
      if (!n) return;
      anchor = n;
      value = kind === 'owner' ? (n.owner ?? '') : n.text;
    }

    const input = document.createElement('input');
    input.className = 'inline-editor';
    input.value = value;
    input.placeholder = { node: 'Texto do retângulo', edge: 'Texto da seta', owner: 'Quem cuida desta etapa?' }[kind];
    if (kind === 'owner') input.maxLength = OWNER_MAX;
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
      const text = kind === 'owner' ? cleanOwner(input.value) : input.value.trim();
      input.remove();
      if (this.editor === input) this.editor = null;
      if (!commit) return;
      if (kind === 'edge') {
        const e = this.store.edge(id);
        if (e && text !== e.text) this.store.updateEdge(id, { text });
        return;
      }
      const n = this.store.node(id);
      if (!n) return;
      // Esvaziar o responsável remove-o; o texto do retângulo, ao contrário, não pode ficar vazio.
      if (kind === 'owner') {
        if (text !== (n.owner ?? '')) this.store.updateNode(id, { owner: text });
      } else if (text && text !== n.text) {
        this.store.updateNode(id, { text });
      }
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') close(true);
      if (ev.key === 'Escape') close(false);
    });
    input.addEventListener('blur', () => close(true));
  }

  // ---- render ----------------------------------------------------------

  private onChange = (change: Change) => {
    if (change.source !== 'view') {
      const ev = change.event;
      switch (ev.type) {
        case 'node.added':
        case 'node.updated':
          this.renderNode(ev.node.id);
          break;
        case 'node.removed':
          this.renderNode(ev.id);
          for (const id of ev.edges) this.renderEdge(id);
          break;
        case 'edge.added':
        case 'edge.updated':
        case 'edge.removed':
          this.renderEdge(ev.type === 'edge.removed' ? ev.id : ev.edge.id);
          break;
        case 'diagram.replaced':
          this.renderAll();
          break;
      }
    }
    this.renderView();
  };

  private isSelected(kind: 'node' | 'edge', id: string) {
    const sel = this.store.selection;
    return sel?.kind === kind && sel.id === id;
  }

  /** Modo, seleção e linha provisória: redesenha só os elementos que entraram ou saíram da seleção. */
  private renderView() {
    this.svg.classList.toggle('mode-arrow', this.store.mode === 'arrow' || this.connecting);
    const before = this.shownSelection;
    const now = this.store.selection;
    if (before?.kind !== now?.kind || before?.id !== now?.id) {
      this.shownSelection = now;
      for (const sel of [before, now]) {
        if (sel?.kind === 'node') this.renderNode(sel.id, false);
        if (sel?.kind === 'edge') this.renderEdge(sel.id);
      }
    }
    this.renderOverlay();
  }

  renderAll() {
    this.edgeLayer.replaceChildren();
    this.nodeLayer.replaceChildren();
    this.nodeEls.clear();
    this.edgeEls.clear();
    this.nodeGeometry.clear();
    for (const e of this.store.diagram.edges) this.renderEdge(e.id);
    for (const n of this.store.diagram.nodes) this.renderNode(n.id, false);
    this.renderView();
  }

  /** Coloca `g` no lugar do elemento antigo de mesmo id (ou no fim da camada), ou remove se `g` for null. */
  private swap(map: Map<string, SVGGElement>, layer: SVGGElement, id: string, g: SVGGElement | null) {
    const old = map.get(id);
    if (g) {
      if (old) old.replaceWith(g);
      else layer.append(g);
      map.set(id, g);
    } else {
      old?.remove();
      map.delete(id);
    }
  }

  /** Redesenha um retângulo e, se a posição ou a largura mudou, as setas ligadas a ele. */
  private renderNode(id: string, withEdges = true) {
    const n = this.store.node(id);
    this.swap(this.nodeEls, this.nodeLayer, id, n ? this.buildNode(n) : null);
    const geometry = n ? `${n.x},${n.y},${nodeSize(n).w},${nodeSize(n).h}` : '';
    const moved = this.nodeGeometry.get(id) !== geometry;
    if (n) this.nodeGeometry.set(id, geometry);
    else this.nodeGeometry.delete(id);
    if (!withEdges || !moved) return;
    for (const e of this.store.diagram.edges) if (e.from === id || e.to === id) this.renderEdge(e.id);
  }

  private renderEdge(id: string) {
    const e = this.store.edge(id);
    const a = e && this.store.node(e.from);
    const b = e && this.store.node(e.to);
    this.swap(this.edgeEls, this.edgeLayer, id, e && a && b ? this.buildEdge(e.id, e.text, a, b) : null);
  }

  private buildEdge(id: string, text: string, a: DiagramNode, b: DiagramNode) {
    const selected = this.isSelected('edge', id);
    const g = el('g', { class: `edge${selected ? ' selected' : ''}`, 'data-edge': id });
    const { d, label } = edgeGeometry(a, b);
    el('path', { d, class: 'edge-hit' }, g);
    el('path', { d, class: 'edge-line', 'marker-end': `url(#${selected ? 'arrow-sel' : 'arrow'})` }, g);
    if (text) {
      const w = textWidth(text) + 12;
      el('rect', { x: label.x - w / 2, y: label.y - 11, width: w, height: 22, rx: 6, class: 'edge-label-bg' }, g);
      el('text', { x: label.x, y: label.y, class: 'edge-label' }, g).textContent = text;
    }
    return g;
  }

  private buildNode(n: DiagramNode) {
    const { w, h } = nodeSize(n);
    const selected = this.isSelected('node', n.id);
    const g = el('g', {
      class: `node${selected ? ' selected' : ''}${n.active ? ' active' : ''}`,
      'data-node': n.id,
      transform: `translate(${n.x - w / 2} ${n.y - h / 2})`,
    });
    if (selected) el('rect', { x: -4, y: -4, width: w + 8, height: h + 8, rx: RADIUS + 4, class: 'node-halo' }, g);
    el('rect', { width: w, height: h, rx: RADIUS, class: 'node-rect' }, g);
    el('text', { x: w / 2, y: n.owner ? 21 : h / 2, class: 'node-label' }, g).textContent = n.text;
    // Responsável: segunda linha dentro do retângulo (duplo clique edita) ou, no selecionado sem ninguém, um botão.
    // Vem antes da bolinha e do status, que ficam por cima da área clicável.
    if (n.owner) {
      const og = el('g', { class: 'node-owner', 'data-owner': n.id }, g);
      el('title', {}, og).textContent = `Responsável: ${n.owner} — duplo clique para editar`;
      el('rect', { x: 0, y: 32, width: w, height: h - 32, class: 'owner-hit' }, og);
      const x0 = w / 2 - (textWidth(n.owner, OWNER_FONT) + 15) / 2;
      el('circle', { cx: x0 + 4, cy: 39.5, r: 2.6, class: 'owner-icon' }, og);
      el('path', { d: `M ${x0 - 1} 47 a 5 4 0 0 1 10 0 z`, class: 'owner-icon' }, og);
      el('text', { x: x0 + 14, y: 43, class: 'owner-label' }, og).textContent = n.owner;
    } else if (selected) {
      const label = '+ responsável';
      const pw = textWidth(label, OWNER_FONT) + 18;
      const pg = el('g', { class: 'add-owner', 'data-add-owner': n.id }, g);
      el('rect', { x: w / 2 - pw / 2, y: h + 8, width: pw, height: 20, rx: 10, class: 'add-owner-bg' }, pg);
      el('text', { x: w / 2, y: h + 18.5, class: 'add-owner-label' }, pg).textContent = label;
    }
    el('circle', { cx: w, cy: h / 2, r: 6, class: 'handle', 'data-handle': n.id }, g);
    const toggle = el('g', { class: 'status', 'data-toggle': n.id }, g);
    el('title', {}, toggle).textContent = n.active ? 'Ativo — clique para inativar' : 'Inativo — clique para ativar';
    el('circle', { cx: 11, cy: h / 2, r: 9, class: 'status-hit' }, toggle);
    el('circle', { cx: 11, cy: h / 2, r: 4, class: 'status-dot' }, toggle);
    return g;
  }

  private renderOverlay() {
    this.overlay.replaceChildren();
    if (this.drag?.kind !== 'connect') return;
    const from = this.store.node(this.drag.from);
    if (!from) return;
    const p1 = borderPoint(from, this.drag.at);
    el('line', { x1: p1.x, y1: p1.y, x2: this.drag.at.x, y2: this.drag.at.y, class: 'edge-pending', 'marker-end': 'url(#arrow-sel)' }, this.overlay);
  }
}
