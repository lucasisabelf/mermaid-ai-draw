/**
 * Qual diagrama está aberto: `?d=<slug>` na URL ou, sem ele, o último aberto neste navegador ou o
 * primeiro da lista. Toda a API do diagrama fica em `API` (/api/d/<slug>). Trocar de diagrama
 * recarrega a página com outro `?d=`: Store, SSE e painéis começam do zero.
 */

const LAST_KEY = 'mermaid-draw:diagram';

export interface DiagramItem {
  slug: string;
  name: string;
  nodes: number;
  edges: number;
  createdAt: string;
  updatedAt: string;
}

function remembered(): string {
  try {
    return localStorage.getItem(LAST_KEY) ?? '';
  } catch {
    return '';
  }
}

async function resolve(): Promise<{ slug: string; list: DiagramItem[] }> {
  const wanted = new URLSearchParams(location.search).get('d') ?? '';
  let list: DiagramItem[] = [];
  try {
    const res = await fetch('/api/diagrams');
    if (res.ok) list = await res.json();
  } catch {
    // Sem servidor: o editor funciona sozinho, com a cópia do navegador.
  }
  const has = (s: string) => Boolean(s) && list.some((d) => d.slug === s);
  const slug = has(wanted) ? wanted : has(remembered()) ? remembered() : (list[0]?.slug ?? (wanted || 'local'));
  try {
    localStorage.setItem(LAST_KEY, slug);
  } catch {}
  if (list.length && slug !== wanted) {
    const url = new URL(location.href);
    url.searchParams.set('d', slug);
    history.replaceState(null, '', url);
  }
  return { slug, list };
}

const resolved = await resolve();

export const DIAGRAM = resolved.slug;
export const API = `/api/d/${encodeURIComponent(DIAGRAM)}`;
/** A lista como estava ao abrir (o menu se atualiza depois por /api/events). */
export const INITIAL_DIAGRAMS = resolved.list;

export function openDiagram(slug: string) {
  const url = new URL(location.href);
  url.searchParams.set('d', slug);
  location.href = url.toString();
}
