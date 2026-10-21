import { aplicar, formatarCusto, inicial, sugerirMencoes, urlDaSaida, type ChatState, type Espera, type MensagemView } from './chatstate';

/**
 * O chat da lateral esquerda: começa uma conversa entre as personas (debate, resposta ou tarefa),
 * mostra as falas chegando (com a cor de cada persona), deixa o usuário intervir com @nome e mostra
 * o status de cada motor. Os eventos vêm do SSE do diagrama, via ServerSync.
 */

export interface PersonaLite {
  id: string;
  nome: string;
  cor: string;
  motor: string;
  modelo: string;
}

export interface ChatDeps {
  api: string;
  personas: () => PersonaLite[];
  /** A persona com a vez brilha no canvas. */
  falando: (id: string, on: boolean) => void;
  /** Uma "mensagem" percorre a seta (de quem ela responde, ou da delegação). */
  pulso: (aresta: string, rotulo?: string) => void;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const ROTULO: Record<string, string> = { sintese: 'síntese', tarefa: 'plano', resultado: 'resultado', saida: 'saída', erro: 'erro', sistema: '' };

const escapar = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Um markdown pequeno e seguro (o texto é escapado antes): títulos, negrito e código. */
export function formatar(texto: string) {
  return escapar(texto)
    .replace(/^#{1,6}\s+(.+)$/gm, '<strong class="md-h">$1</strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

const tokens = (n?: number) => (n === undefined ? '' : n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')}k` : String(n));

export class ChatPanel {
  private estado: ChatState = inicial();
  private listaEl = $('#chat-mensagens');
  private novoEl = $<HTMLFormElement>('#chat-novo');
  private intervirEl = $<HTMLFormElement>('#chat-intervir');
  private textoEl = $<HTMLTextAreaElement>('#chat-texto');
  private sugestoesEl = $('#chat-sugestoes');
  private historicoEl = $<HTMLSelectElement>('#chat-historico');
  private custoEl = $('#chat-custo');
  private motoresEl = $('#chat-motores');
  private falandoAgora = new Set<string>();
  private esperaEl = $<HTMLFormElement>('#chat-espera');
  private esperaTexto = $<HTMLTextAreaElement>('#ce-texto');
  private esperaTurno?: string;
  private tituloOriginal = document.title;
  private piscar?: number;

  constructor(private deps: ChatDeps) {
    this.novoEl.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.comecar();
    });
    this.intervirEl.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.intervir();
    });
    for (const el of [$<HTMLTextAreaElement>('#chat-assunto'), this.textoEl]) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          (el.form as HTMLFormElement).requestSubmit();
        }
      });
    }
    this.textoEl.addEventListener('input', () => this.sugerir());
    // A vez humana: Aprovar (Enter), Pedir mudança ou Encerrar.
    this.esperaEl.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.responderHumano('aprovar');
    });
    for (const b of this.esperaEl.querySelectorAll<HTMLButtonElement>('button[type="button"][data-acao]')) {
      b.addEventListener('click', () => void this.responderHumano(b.dataset.acao as 'mudar' | 'encerrar'));
    }
    this.esperaTexto.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.esperaEl.requestSubmit();
      }
    });
    window.addEventListener('focus', () => this.pararDeAvisar());
    $('#chat-parar').addEventListener('click', () => void this.acao('parar'));
    $('#chat-sintetizar').addEventListener('click', () => void this.acao('sintetizar'));
    $('#chat-nova').addEventListener('click', () => this.mostrar(inicial()));
    this.historicoEl.addEventListener('change', () => void this.abrir(this.historicoEl.value));
    void this.atualizarMotores();
    window.setInterval(() => void this.atualizarMotores(), 10_000);
    void this.atualizarHistorico(true);
    this.render();
  }

  /** Eventos chat.* do servidor. */
  receber(ev: { type: string; [k: string]: any }) {
    if (ev.type === 'chat.turno') {
      const on = ev.status === 'pensando';
      if (on) this.falandoAgora.add(ev.persona);
      else this.falandoAgora.delete(ev.persona);
      this.deps.falando(ev.persona, on);
      if (on) for (const a of ev.arestas ?? []) this.deps.pulso(a);
      if (ev.status === 'erro') void this.atualizarMotores();
    }
    if (ev.type === 'chat.delegacao') for (const a of ev.arestas ?? []) this.deps.pulso(a, 'tarefa');
    if (ev.type === 'chat.fim') {
      for (const id of this.falandoAgora) this.deps.falando(id, false);
      this.falandoAgora.clear();
    }
    if (ev.type === 'chat.inicio' || ev.type === 'chat.fim') void this.atualizarHistorico(false);
    const antes = this.estado;
    this.estado = aplicar(this.estado, ev);
    if (this.estado !== antes) this.render();
  }

  // ---- ações ---------------------------------------------------------------------

  private async post(rota: string, body?: unknown) {
    const res = await fetch(`${this.deps.api}${rota}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Erro ${res.status}`);
    return json;
  }

  private async responderHumano(acao: 'aprovar' | 'mudar' | 'encerrar') {
    if (!this.estado.conversa || !this.estado.espera) return;
    if (acao === 'mudar' && !this.esperaTexto.value.trim()) {
      this.esperaTexto.focus();
      this.esperaTexto.placeholder = 'Diga o que mudar…';
      return;
    }
    try {
      await this.post(`/conversas/${this.estado.conversa}/humano`, { acao, texto: this.esperaTexto.value });
      this.esperaTexto.value = '';
      this.pararDeAvisar();
    } catch (err) {
      this.aviso((err as Error).message);
    }
  }

  /** Mostra (ou esconde) o bloco "Sua vez" e avisa quando a vez acabou de chegar. */
  private mostrarEspera(e: Espera | undefined) {
    this.esperaEl.hidden = !e;
    if (!e) {
      this.esperaTurno = undefined;
      return this.pararDeAvisar();
    }
    if (e.turno === this.esperaTurno) return;
    this.esperaTurno = e.turno;
    $('#ce-titulo').textContent = `Sua vez como ${e.nome}`;
    // O pedido: a tarefa delegada (no começo do contexto) ou o "Sua vez: …" (no fim).
    const partes = e.contexto.split('\n\n');
    const pedido = e.tipo === 'execucao' ? partes[0] : partes.at(-1)!;
    $('#ce-pedido').innerHTML = formatar(pedido);
    this.esperaTexto.placeholder = 'Sua resposta (opcional ao aprovar)…';
    this.esperaTexto.focus();
    this.avisar(`Sua vez como ${e.nome}`, pedido);
  }

  private avisar(titulo: string, corpo: string) {
    clearInterval(this.piscar);
    let ligado = false;
    this.piscar = window.setInterval(() => {
      ligado = !ligado;
      document.title = ligado ? `● ${titulo}` : this.tituloOriginal;
    }, 1000);
    if ('Notification' in window && Notification.permission === 'granted' && !document.hasFocus()) {
      new Notification(titulo, { body: corpo.slice(0, 200) });
    }
  }

  private pararDeAvisar() {
    clearInterval(this.piscar);
    this.piscar = undefined;
    document.title = this.tituloOriginal;
  }

  private async comecar() {
    // Pede (uma vez) para avisar quando a vez de uma persona humana chegar com a aba em segundo plano.
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    const assunto = $<HTMLTextAreaElement>('#chat-assunto');
    try {
      const c = await this.post('/conversas', {
        assunto: assunto.value,
        modo: $<HTMLSelectElement>('#chat-modo').value,
        rodadas: Number($<HTMLInputElement>('#chat-rodadas').value),
      });
      assunto.value = '';
      // Os eventos já podem ter chegado pelo SSE; se não, mostra a conversa recém-criada.
      if (this.estado.conversa !== c.id) this.mostrar(aplicar(inicial(), { type: 'carregar', conversa: c }));
    } catch (err) {
      this.aviso((err as Error).message);
    }
  }

  private async intervir() {
    if (!this.estado.conversa || !this.textoEl.value.trim()) return;
    try {
      await this.post(`/conversas/${this.estado.conversa}/mensagens`, { texto: this.textoEl.value });
      this.textoEl.value = '';
      this.sugestoesEl.hidden = true;
    } catch (err) {
      this.aviso((err as Error).message);
    }
  }

  private async acao(qual: 'parar' | 'sintetizar') {
    if (!this.estado.conversa) return;
    try {
      await this.post(`/conversas/${this.estado.conversa}/${qual}`);
    } catch (err) {
      this.aviso((err as Error).message);
    }
  }

  private async abrir(id: string) {
    if (!id) return;
    const res = await fetch(`${this.deps.api}/conversas/${encodeURIComponent(id)}`);
    if (res.ok) this.mostrar(aplicar(inicial(), { type: 'carregar', conversa: await res.json() }));
  }

  private mostrar(s: ChatState) {
    // Quem tem a vez na conversa mostrada brilha no canvas (inclusive ao abrir a página no meio).
    for (const id of this.falandoAgora) this.deps.falando(id, false);
    this.falandoAgora = new Set(s.pendentes.map((p) => p.persona));
    for (const id of this.falandoAgora) this.deps.falando(id, true);
    this.estado = s;
    this.render();
  }

  private sugerir() {
    const ate = this.textoEl.value.slice(0, this.textoEl.selectionStart);
    const lista = sugerirMencoes(ate, this.deps.personas());
    this.sugestoesEl.hidden = !lista.length;
    this.sugestoesEl.replaceChildren(
      ...lista.map((p) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: `@${p.nome}` });
        b.style.setProperty('--cor', p.cor);
        b.addEventListener('click', () => {
          const resto = this.textoEl.value.slice(ate.length);
          this.textoEl.value = `${ate.replace(/@[\p{L}\p{N} ]*$/u, `@${p.nome} `)}${resto}`;
          this.sugestoesEl.hidden = true;
          this.textoEl.focus();
        });
        return b;
      }),
    );
  }

  // ---- motores e histórico --------------------------------------------------------

  private async atualizarMotores() {
    try {
      const lista = (await fetch('/api/motores').then((r) => r.json())) as { nome: string; titulo: string; ok: boolean; detalhe: string; modelos: string[] }[];
      this.motoresEl.replaceChildren(
        ...lista.map((m) => {
          const chip = Object.assign(document.createElement('span'), { className: `motor ${m.ok ? 'ok' : 'off'}`, textContent: m.titulo, title: m.detalhe });
          return chip;
        }),
      );
      document.dispatchEvent(new CustomEvent('motores', { detail: lista }));
    } catch {}
  }

  private async atualizarHistorico(abrirUltima: boolean) {
    try {
      const lista = (await fetch(`${this.deps.api}/conversas`).then((r) => r.json())) as { id: string; assunto: string; status: string; criadaEm: string }[];
      const atual = this.estado.conversa ?? '';
      this.historicoEl.replaceChildren(
        new Option(lista.length ? `Conversas (${lista.length})` : 'Nenhuma conversa ainda', ''),
        ...lista.map((c) => new Option(`${c.assunto.slice(0, 48)}${c.assunto.length > 48 ? '…' : ''} · ${c.status}`, c.id)),
      );
      this.historicoEl.value = lista.some((c) => c.id === atual) ? atual : '';
      if (abrirUltima && !this.estado.conversa && lista[0]) await this.abrir(lista[0].id);
    } catch {}
  }

  private aviso(texto: string) {
    const el = Object.assign(document.createElement('div'), { className: 'msg tipo-erro', textContent: texto });
    this.listaEl.append(el);
    this.listaEl.scrollTop = this.listaEl.scrollHeight;
  }

  // ---- desenho ---------------------------------------------------------------------

  private bolha(m: { nome: string; tipo: string; texto: string; persona?: string; motor?: string; modelo?: string; arquivo?: string; uso?: MensagemView['uso'] }, profundidade: number, pendente = false) {
    const cor = this.deps.personas().find((p) => p.id === m.persona)?.cor;
    const el = document.createElement('div');
    el.className = `msg tipo-${m.tipo}${pendente ? ' pendente' : ''}`;
    if (cor) el.style.setProperty('--cor', cor);
    if (profundidade) el.style.marginLeft = `${Math.min(profundidade, 4) * 14}px`;
    const head = document.createElement('div');
    head.className = 'msg-head';
    head.append(Object.assign(document.createElement('span'), { className: 'msg-nome', textContent: m.nome }));
    const rotulo = ROTULO[m.tipo];
    if (rotulo) head.append(Object.assign(document.createElement('span'), { className: 'msg-tipo', textContent: rotulo }));
    const meta = [m.motor, m.modelo, m.uso?.saida !== undefined ? `${tokens(m.uso.saida)} tok` : '', m.uso?.tokensPorSegundo ? `${m.uso.tokensPorSegundo} tok/s` : '', m.uso?.custo ? formatarCusto(m.uso.custo) : '']
      .filter(Boolean)
      .join(' · ');
    if (meta) head.append(Object.assign(document.createElement('span'), { className: 'msg-meta', textContent: meta }));
    const corpo = document.createElement('div');
    corpo.className = 'msg-texto';
    if (pendente && !m.texto) corpo.innerHTML = `<span class="pensando">${m.motor === 'mcp' ? 'pensando no Claude Code' : 'pensando'}<i>.</i><i>.</i><i>.</i></span>`;
    else corpo.innerHTML = formatar(m.texto);
    el.append(head, corpo);
    if (m.tipo === 'saida' && m.arquivo && this.estado.conversa && !pendente) el.append(this.acoesDaSaida(this.estado.conversa, m.arquivo, m.texto));
    return el;
  }

  /** O .md gerado pela persona de saída: baixar ou copiar. */
  private acoesDaSaida(conversa: string, arquivo: string, texto: string) {
    const barra = Object.assign(document.createElement('div'), { className: 'msg-arquivo' });
    barra.append(Object.assign(document.createElement('span'), { className: 'msg-arquivo-nome', textContent: `📄 ${arquivo}` }));
    const baixar = Object.assign(document.createElement('a'), { className: 'msg-arquivo-acao', textContent: 'Baixar', href: urlDaSaida(this.deps.api, conversa, arquivo), download: arquivo });
    const copiar = Object.assign(document.createElement('button'), { type: 'button', className: 'msg-arquivo-acao', textContent: 'Copiar' });
    copiar.addEventListener('click', () => {
      void navigator.clipboard?.writeText(texto).then(() => {
        copiar.textContent = 'Copiado';
        setTimeout(() => (copiar.textContent = 'Copiar'), 1500);
      });
    });
    barra.append(baixar, copiar);
    return barra;
  }

  private render() {
    const s = this.estado;
    const temConversa = Boolean(s.conversa);
    const viva = s.status === 'rodando' || s.status === 'aguardando';
    this.novoEl.hidden = temConversa && viva;
    this.mostrarEspera(s.espera);
    this.intervirEl.hidden = !temConversa;
    $<HTMLButtonElement>('#chat-parar').disabled = !viva;
    $<HTMLButtonElement>('#chat-sintetizar').disabled = !temConversa;
    if (temConversa && !viva) this.novoEl.hidden = true;
    this.custoEl.textContent = s.custo ? formatarCusto(s.custo) : '';
    if (this.historicoEl.value !== (s.conversa ?? '') && [...this.historicoEl.options].some((o) => o.value === s.conversa)) this.historicoEl.value = s.conversa!;

    const perto = this.listaEl.scrollHeight - this.listaEl.scrollTop - this.listaEl.clientHeight < 80;
    const porId = new Map(s.mensagens.map((m) => [m.id, m]));
    const profundidade = (m: MensagemView) => {
      let n = 0;
      for (let p = m.pai; p && porId.has(p); p = porId.get(p)!.pai) n++;
      return n;
    };
    const filhos: HTMLElement[] = [];
    if (!temConversa) {
      filhos.push(
        Object.assign(document.createElement('div'), {
          className: 'chat-vazio',
          innerHTML:
            '<strong>Cada retângulo é uma persona.</strong> As setas dizem quem responde a quem (e, numa tarefa, quem delega para quem). Escreva um assunto abaixo e escolha o modo; ou, no Claude Code, peça para começar a conversa pelo MCP.',
        }),
      );
    }
    for (const m of s.mensagens) filhos.push(this.bolha(m, profundidade(m)));
    for (const p of s.pendentes) filhos.push(this.bolha({ ...p, tipo: p.tipo === 'sintese' || p.tipo === 'saida' ? p.tipo : 'fala' }, 0, true));
    if (s.status === 'terminada' && s.resposta) {
      const fim = Object.assign(document.createElement('div'), { className: 'chat-fim', textContent: 'Conversa terminada. Escreva para continuar, ou peça uma nova.' });
      filhos.push(fim);
    }
    this.listaEl.replaceChildren(...filhos);
    if (perto) this.listaEl.scrollTop = this.listaEl.scrollHeight;
  }
}
