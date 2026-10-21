import { DIAGRAM, INITIAL_DIAGRAMS, openDiagram, type DiagramItem } from './diagrams';

/**
 * Menu ☰ dos diagramas: busca, criar, importar (.zip ou .mmd) e, em cada diagrama, ⋯ com renomear,
 * duplicar, exportar e apagar. A lista chega ao vivo por /api/events, então outra aba (ou um curl)
 * que cria ou renomeia um diagrama aparece na hora.
 */

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('pt-BR');
};

async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {}
  if (!res.ok) throw new Error((json as { error?: string } | undefined)?.error ?? `${method} ${path}: ${res.status}`);
  return json as T;
}

export class DiagramMenu {
  private list: DiagramItem[] = INITIAL_DIAGRAMS;
  private root = $('#menu');
  private listEl = $('#menu-list');
  private searchEl = $<HTMLInputElement>('#menu-search');
  private fileEl = $<HTMLInputElement>('#menu-file');
  /** Diagrama com o menu ⋯ aberto. */
  private actionsFor = '';

  constructor() {
    $('#btn-menu').addEventListener('click', () => (this.root.hidden ? this.open() : this.close()));
    $('#menu-close').addEventListener('click', () => this.close());
    $('#menu-backdrop').addEventListener('click', () => this.close());
    this.searchEl.addEventListener('input', () => this.render());
    this.searchEl.addEventListener('keydown', (e) => {
      // Enter abre o primeiro resultado da busca.
      const first = this.filtered()[0];
      if (e.key === 'Enter' && first) openDiagram(first.slug);
    });
    $('#menu-new').addEventListener('click', () => void this.create());
    $('#menu-import').addEventListener('click', () => this.fileEl.click());
    this.fileEl.addEventListener('change', () => void this.importFile());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.root.hidden) {
        e.stopPropagation();
        this.close();
      }
    }, true);

    const events = new EventSource('/api/events');
    events.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as { type: string; diagrams: DiagramItem[] };
      if (msg.type !== 'diagrams') return;
      this.list = msg.diagrams;
      // O diagrama aberto foi renomeado ou apagado em outra aba: o menu se abre para escolher outro.
      if (this.list.length && !this.current && this.root.hidden) this.open();
      this.render();
    };
    this.render();
  }

  private get current() {
    return this.list.find((d) => d.slug === DIAGRAM);
  }

  open() {
    this.root.hidden = false;
    $('#menu-backdrop').hidden = false;
    this.searchEl.value = '';
    this.render();
    this.searchEl.focus();
  }

  close() {
    this.root.hidden = true;
    $('#menu-backdrop').hidden = true;
    this.actionsFor = '';
  }

  private filtered() {
    const q = this.searchEl.value.trim().toLowerCase();
    return q ? this.list.filter((d) => d.name.toLowerCase().includes(q) || d.slug.includes(q)) : this.list;
  }

  private render() {
    const name = this.current?.name ?? (this.list.length ? '' : 'Sem servidor');
    $('#diagram-name').textContent = name;
    document.title = name ? `${name} · mermaid-draw` : 'mermaid-draw';

    const items = this.filtered();
    this.listEl.replaceChildren(...items.map((d) => this.item(d)));
    if (!items.length) {
      const empty = this.list.length ? 'Nenhum diagrama com esse nome.' : 'Servidor fora do ar: só o diagrama deste navegador.';
      this.listEl.append(Object.assign(document.createElement('li'), { className: 'menu-empty', textContent: empty }));
    }
  }

  private item(d: DiagramItem) {
    const li = document.createElement('li');
    li.className = `menu-item${d.slug === DIAGRAM ? ' current' : ''}`;

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'menu-open';
    main.title = d.slug === DIAGRAM ? 'Aberto agora' : `Abrir "${d.name}"`;
    main.innerHTML = '<span class="menu-name"></span><span class="menu-meta"></span>';
    main.querySelector('.menu-name')!.textContent = d.name;
    main.querySelector('.menu-meta')!.textContent =
      `${d.nodes} retângulo${d.nodes === 1 ? '' : 's'} · ${d.edges} seta${d.edges === 1 ? '' : 's'} · ${when(d.updatedAt)}`;
    main.addEventListener('click', () => d.slug !== DIAGRAM && openDiagram(d.slug));

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'menu-more';
    more.textContent = '⋯';
    more.title = 'Renomear, duplicar, exportar, apagar';
    more.setAttribute('aria-expanded', String(this.actionsFor === d.slug));
    more.addEventListener('click', () => {
      this.actionsFor = this.actionsFor === d.slug ? '' : d.slug;
      this.render();
    });

    li.append(main, more);
    if (this.actionsFor === d.slug) {
      const actions = document.createElement('div');
      actions.className = 'menu-actions';
      const enc = encodeURIComponent(d.slug);
      for (const [label, fn, cls] of [
        ['Renomear', () => this.rename(d), ''],
        ['Duplicar', () => this.duplicate(d), ''],
        ['Exportar .zip', () => this.download(`/api/diagrams/${enc}/export`), ''],
        ['Exportar .zip com memória', () => this.download(`/api/diagrams/${enc}/export?memoria=1`), ''],
        ['Exportar .mmd', () => this.download(`/api/diagrams/${enc}/export?format=mmd`), ''],
        ['Apagar', () => this.remove(d), 'danger'],
      ] as const) {
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label, className: cls });
        b.addEventListener('click', () => void fn());
        actions.append(b);
      }
      li.append(actions);
    }
    return li;
  }

  // ---- ações ----------------------------------------------------------------

  private async create() {
    const name = prompt('Nome do novo diagrama:')?.trim();
    if (!name) return;
    try {
      openDiagram((await request<DiagramItem>('POST', '/api/diagrams', { name })).slug);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  private async importFile() {
    const file = this.fileEl.files?.[0];
    this.fileEl.value = '';
    if (!file) return;
    try {
      const name = file.name.replace(/\.(zip|mmd)$/i, '');
      const res = await fetch(`/api/diagrams/import?name=${encodeURIComponent(name)}`, { method: 'POST', body: file });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `importar: ${res.status}`);
      openDiagram((body as DiagramItem).slug);
    } catch (err) {
      alert(`Não foi possível importar: ${(err as Error).message}`);
    }
  }

  private async rename(d: DiagramItem) {
    const name = prompt(`Novo nome para "${d.name}":`, d.name)?.trim();
    if (!name || name === d.name) return;
    try {
      const it = await request<DiagramItem>('PATCH', `/api/diagrams/${encodeURIComponent(d.slug)}`, { name });
      this.actionsFor = '';
      // Renomear muda a pasta (o slug): o aberto precisa da URL nova.
      if (d.slug === DIAGRAM && it.slug !== DIAGRAM) openDiagram(it.slug);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  private async duplicate(d: DiagramItem) {
    try {
      await request('POST', `/api/diagrams/${encodeURIComponent(d.slug)}/duplicate`);
      this.actionsFor = '';
      this.render();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  private download(href: string) {
    const a = Object.assign(document.createElement('a'), { href, download: '' });
    document.body.append(a);
    a.click();
    a.remove();
  }

  private async remove(d: DiagramItem) {
    if (!confirm(`Apagar "${d.name}"? Ele vai para a pasta .removidos/ (dá para recuperar de lá).`)) return;
    try {
      await request('DELETE', `/api/diagrams/${encodeURIComponent(d.slug)}`);
      if (d.slug === DIAGRAM) {
        const next = (await request<DiagramItem[]>('GET', '/api/diagrams'))[0];
        if (next) openDiagram(next.slug);
      }
    } catch (err) {
      alert((err as Error).message);
    }
  }
}
