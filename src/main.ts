import mermaid from 'mermaid';
import './style.css';
import { Canvas, DND_TYPE, type Tool } from './canvas';
import { ChatPanel, type PersonaLite } from './chat';
import { API, DIAGRAM } from './diagrams';
import { PersonaPanel, type PersonaView } from './personapanel';
import { downloadPng, downloadSvg } from './export';
import { DiagramMenu } from './menu';
import { parseMermaid, toMermaid, type Diagram } from './model';
import { Store } from './store';
import { ServerSync } from './sync';

// Cópia local do código, por diagrama.
const STORAGE_KEY = `mermaid-draw:code:${DIAGRAM}`;

const SAMPLE = `flowchart LR
    n1("Início")
    n2("Meio")
    n3("Fim")
    n1 -->|"processa"| n2
    n2 -->|"finaliza"| n3

%% @pos n1 140 120
%% @pos n2 380 120
%% @pos n3 620 120`;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const codeEl = $<HTMLTextAreaElement>('#code');
const errorsEl = $('#errors');
const previewEl = $('#preview');
const hintEl = $('#hint');

function loadInitial(): Diagram {
  let code = SAMPLE;
  try {
    code = localStorage.getItem(STORAGE_KEY) ?? SAMPLE;
  } catch {}
  return parseMermaid(code).diagram;
}

const store = new Store(loadInitial());
const canvas = new Canvas($('#canvas'), store);

// ---- barra do canvas: selecionar/mão, zoom, ver tudo e zoom no selecionado ----

const toolButtons = document.querySelectorAll<HTMLButtonElement>('[data-canvas-tool]');
const zoomLabel = $('#ct-zoom-reset');
const focusButton = $<HTMLButtonElement>('#ct-focus');
canvas.onView = () => {
  for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.canvasTool === canvas.tool));
  zoomLabel.textContent = `${Math.round(canvas.zoom * 100)}%`;
  focusButton.disabled = !canvas.hasSelection;
};
for (const b of toolButtons) b.addEventListener('click', () => canvas.setTool(b.dataset.canvasTool as Tool));
$('#ct-zoom-out').addEventListener('click', () => canvas.zoomBy(1 / 1.25));
$('#ct-zoom-in').addEventListener('click', () => canvas.zoomBy(1.25));
zoomLabel.addEventListener('click', () => canvas.resetZoom());
$('#ct-fit').addEventListener('click', () => canvas.fitAll());
focusButton.addEventListener('click', () => canvas.zoomToSelection());
canvas.onView();

mermaid.initialize({
  startOnLoad: false,
  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
  flowchart: { htmlLabels: true },
});

let renderSeq = 0;
async function renderPreview(code: string) {
  const seq = ++renderSeq;
  try {
    const { svg } = await mermaid.render(`preview-${seq}`, code);
    if (seq === renderSeq) previewEl.innerHTML = svg;
  } catch (err) {
    if (seq === renderSeq) previewEl.textContent = `Erro no Mermaid: ${(err as Error).message}`;
  }
}

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: number | undefined;
  return (...args: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  };
}

const schedulePreview = debounce(renderPreview, 200);

function save(code: string) {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {}
}

function updateHint() {
  hintEl.textContent = canvas.connecting
    ? 'Clique (ou solte) sobre o retângulo de destino. Esc cancela.'
    : store.mode === 'arrow'
      ? 'Modo seta: arraste de um retângulo até outro. Esc volta ao modo seleção.'
      : store.selection?.kind === 'edge'
        ? 'Seta selecionada: M liga/desliga a animação, P manda uma mensagem por ela, duplo clique edita o texto, Delete remove.'
        : 'Arraste os componentes para o canvas. Duplo clique edita o texto. A bolinha à esquerda (ou a tecla A) ativa/inativa. R define quem cuida da etapa. Delete remove. Arraste o fundo (ou segure Espaço) para mover a vista; Ctrl+roda dá zoom, F mostra tudo e Z dá zoom no selecionado.';
  document.querySelector('[data-tool="arrow"]')!.classList.toggle('active', store.mode === 'arrow');
}

// ---- personas: cada retângulo é uma (cor e selo no canvas, painel à direita) ----

const personas = new Map<string, PersonaView>();
const MOTOR_CURTO: Record<string, string> = { mcp: 'MCP', ollama: 'Ollama', api: 'API' };
/** "claude-opus-5-5" → "opus 5.5"; "qwen2.5:3b" fica como está. */
const modeloCurto = (m: string) => m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1');
canvas.personaDe = (id) => {
  const p = personas.get(id);
  return p && { cor: p.cor, selo: `${MOTOR_CURTO[p.motor]} · ${modeloCurto(p.modelo)}` };
};
const atualizarPersona = (p: PersonaView) => {
  personas.set(p.id, p);
  canvas.redesenhar(p.id);
  personaPanel.atualizada(p);
};
async function carregarPersonas() {
  try {
    const lista = (await fetch(`${API}/personas`).then((r) => r.json())) as PersonaView[];
    personas.clear();
    for (const p of lista) personas.set(p.id, p);
    canvas.renderAll();
  } catch {}
}
const personaPanel = new PersonaPanel(API, store, (p) => atualizarPersona(p));
// Retângulo novo (de outra aba, do código ou da paleta): busca a persona dele.
store.subscribe((change) => {
  if (change.source !== 'view' && change.event && ['node.added', 'diagram.replaced'].includes(change.event.type)) void carregarPersonasLogo();
});
const carregarPersonasLogo = debounce(() => void carregarPersonas(), 250);

const chat = new ChatPanel({
  api: API,
  personas: () => store.diagram.nodes.map((n): PersonaLite => {
    const p = personas.get(n.id);
    return { id: n.id, nome: n.text, cor: p?.cor ?? '#64748b', motor: p?.motor ?? 'mcp', modelo: p?.modelo ?? '' };
  }),
  falando: (id, on) => canvas.setFalando(id, on),
  pulso: (aresta, rotulo) => canvas.pulseEdge(aresta, rotulo),
});

// ---- sincronização com o servidor (API em server/api.ts) -------------------

const sync = new ServerSync(
  store,
  (msg) => canvas.pulseEdge(msg.id, msg.label),
  (msg) => {
    if (msg.type === 'persona.atualizada') atualizarPersona(msg.persona as PersonaView);
    else chat.receber(msg);
  },
);
void carregarPersonas();
new DiagramMenu();

/** Atualiza o que depende do diagrama inteiro: painel de código, preview e cópia local. */
function refreshDerived(fromCode: boolean) {
  const code = toMermaid(store.diagram);
  if (!fromCode) {
    codeEl.value = code;
    errorsEl.replaceChildren();
  }
  save(code);
  schedulePreview(code);
}

// Sem nada desenhado não há o que exportar.
function updateExportButtons() {
  for (const id of ['#btn-svg', '#btn-png']) $<HTMLButtonElement>(id).disabled = !store.diagram.nodes.length;
}

store.subscribe((change) => {
  updateHint();
  if (change.source !== 'view') {
    refreshDerived(change.source === 'code');
    updateExportButtons();
  }
});

// ---- código → canvas -----------------------------------------------------

codeEl.addEventListener(
  'input',
  debounce(() => {
    const { diagram, errors } = parseMermaid(codeEl.value, store.diagram);
    errorsEl.replaceChildren(
      ...errors.map((msg) => Object.assign(document.createElement('div'), { textContent: msg })),
    );
    if (!errors.length) store.replace(diagram, 'code');
  }, 300),
);

// ---- paleta ----------------------------------------------------------------

for (const tool of document.querySelectorAll<HTMLElement>('[data-tool]')) {
  const kind = tool.dataset.tool!;
  tool.addEventListener('dragstart', (e) => {
    e.dataTransfer!.setData(DND_TYPE, kind);
    e.dataTransfer!.effectAllowed = 'copy';
  });
  const activate = () => {
    if (kind === 'arrow') {
      store.setMode(store.mode === 'arrow' ? 'select' : 'arrow');
    } else {
      const r = $('#canvas').getBoundingClientRect();
      const n = store.addNode(r.width / 2 + (Math.random() - 0.5) * 80, r.height / 2 + (Math.random() - 0.5) * 80);
      canvas.edit('node', n.id);
    }
  };
  tool.addEventListener('click', activate);
  tool.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  });
}

// ---- abas da esquerda: Chat | Componentes -----------------------------------

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-left-tab]')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll<HTMLButtonElement>('[data-left-tab]')) x.classList.toggle('active', x === b);
    for (const pane of document.querySelectorAll<HTMLElement>('[data-pane]')) pane.hidden = pane.dataset.pane !== b.dataset.leftTab;
  });
}

// ---- personas da paleta: o mesmo papel em cada motor ----------------------------

async function criarDoTemplate(motor: string, papel: string, at?: { x: number; y: number }) {
  const r = $('#canvas').getBoundingClientRect();
  const pos = at ?? { x: r.width / 2 + (Math.random() - 0.5) * 120, y: r.height / 2 + (Math.random() - 0.5) * 120 };
  const res = await fetch(`${API}/templates/${encodeURIComponent(papel)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': sync.clientId },
    body: JSON.stringify({ motor, x: Math.round(pos.x), y: Math.round(pos.y) }),
  });
  const json = await res.json();
  if (!res.ok) return void (hintEl.textContent = json.error ?? 'Não consegui criar a persona.');
  personas.set(json.persona.id, json.persona);
  // O retângulo chega pelo SSE; quando chegar, fica selecionado.
  const id = json.node.id as string;
  const selecionar = () => (store.node(id) ? store.select({ kind: 'node', id }) : setTimeout(selecionar, 50));
  selecionar();
}
canvas.onTemplate = (motor, papel, at) => void criarDoTemplate(motor, papel, at);

fetch('/api/templates')
  .then((r) => r.json())
  .then((t: { motores: { nome: string; titulo: string; descricao: string }[]; papeis: { nome: string; titulo: string; descricao: string; cor: string; modelos: Record<string, string> }[] }) => {
    const host = $('#templates');
    for (const m of t.motores) {
      const grupo = Object.assign(document.createElement('details'), { className: 'tpl-grupo', open: m.nome === 'mcp' });
      grupo.append(Object.assign(document.createElement('summary'), { textContent: m.titulo, title: m.descricao }));
      for (const papel of t.papeis) {
        const tool = Object.assign(document.createElement('div'), {
          className: 'tool template',
          role: 'button',
          tabIndex: 0,
          draggable: true,
          title: `${papel.descricao}\n${m.titulo} · ${papel.modelos[m.nome]}`,
        });
        tool.style.setProperty('--cor', papel.cor);
        tool.innerHTML = '<span class="tpl-cor"></span><span class="tool-label"></span>';
        tool.querySelector('.tool-label')!.textContent = papel.titulo;
        tool.addEventListener('dragstart', (e) => {
          e.dataTransfer!.setData(DND_TYPE, `tpl:${m.nome}:${papel.nome}`);
          e.dataTransfer!.effectAllowed = 'copy';
        });
        tool.addEventListener('click', () => void criarDoTemplate(m.nome, papel.nome));
        tool.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void criarDoTemplate(m.nome, papel.nome);
          }
        });
        grupo.append(tool);
      }
      host.append(grupo);
    }
  })
  .catch(() => ($('#templates').textContent = 'Templates indisponíveis (servidor fora do ar).'));

// ---- teclado e barra superior ----------------------------------------------

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.matches('input, textarea, select')) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    store.removeSelected();
  } else if (e.key.toLowerCase() === 'm' && store.selection?.kind === 'edge' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    store.toggleAnimated(store.selection.id);
  } else if (e.key.toLowerCase() === 'p' && store.selection?.kind === 'edge' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // O pulso passa pelo servidor: todas as abas abertas veem a mensagem.
    if (!sync.pulse(store.selection.id)) canvas.pulseEdge(store.selection.id);
  } else if (e.key.toLowerCase() === 'a' && store.selection?.kind === 'node' && !e.ctrlKey && !e.metaKey) {
    store.toggleActive(store.selection.id);
  } else if (e.key.toLowerCase() === 'r' && store.selection?.kind === 'node' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault(); // senão a letra cairia no campo que acabou de abrir
    canvas.edit('owner', store.selection.id);
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && ['v', 'h', 'f', 'z', '+', '=', '-'].includes(e.key.toLowerCase())) {
    // Câmera: V seleciona, H mão, F ver tudo, Z zoom no selecionado, + e − zoom.
    const k = e.key.toLowerCase();
    if (k === 'v') canvas.setTool('select');
    else if (k === 'h') canvas.setTool('pan');
    else if (k === 'f') canvas.fitAll();
    else if (k === 'z') canvas.zoomToSelection();
    else canvas.zoomBy(k === '-' ? 1 / 1.25 : 1.25);
  } else if (e.key === 'Escape') {
    if (canvas.connecting) canvas.cancel();
    else if (store.mode === 'arrow') store.setMode('select');
    else store.select(null);
  }
});

$('#btn-copy').addEventListener('click', async () => {
  const btn = $('#btn-copy');
  try {
    await navigator.clipboard.writeText(codeEl.value);
    btn.textContent = 'Copiado!';
  } catch {
    codeEl.select();
    btn.textContent = 'Selecionado — Ctrl+C';
  }
  setTimeout(() => (btn.textContent = 'Copiar código'), 1500);
});

$('#btn-svg').addEventListener('click', () => {
  const out = canvas.exportSvg();
  if (out) downloadSvg(out.svg);
});

$('#btn-png').addEventListener('click', async () => {
  const out = canvas.exportSvg();
  if (!out) return;
  try {
    await downloadPng(out.svg, out.width, out.height);
  } catch (err) {
    alert(`Não foi possível exportar o PNG: ${(err as Error).message}`);
  }
});

$('#btn-clear').addEventListener('click', () => {
  if (store.diagram.nodes.length && !confirm('Apagar todo o diagrama?')) return;
  store.replace({ nodes: [], edges: [] }, 'local');
});

updateHint();
updateExportButtons();
refreshDerived(false);
