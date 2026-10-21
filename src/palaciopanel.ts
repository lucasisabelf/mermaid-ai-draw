import { editarItem, filtrar, itensDoPalacio, removerItem, type ItemDoPalacio } from './palacio';

/**
 * O palácio da memória: as salas do memoria.md como cartões (com busca e filtros), editar e apagar
 * um item, o histórico das versões e o markdown bruto. Toda mudança regrava o memoria.md.
 */

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const escapar = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class PalacioDialog {
  private dialog = $<HTMLDialogElement>('#palacio-dialog');
  private md = '';
  private existe = false;

  constructor(
    private api: string,
    /** Avisa a tela (o selo da memória no canvas) quantos itens ela tem agora. */
    private mudou: (itens: number) => void,
  ) {
    $('#pa-fechar').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('click', (e) => e.target === this.dialog && this.dialog.close());
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-pa-aba]')) {
      b.addEventListener('click', () => this.aba(b.dataset.paAba!));
    }
    for (const sel of ['#pa-busca', '#pa-persona', '#pa-conversa']) $(sel).addEventListener('input', () => this.desenharSalas());
    $('#pa-salvar').addEventListener('click', () => void this.gravar($<HTMLTextAreaElement>('#pa-md').value));
    $('#pa-zerar').addEventListener('click', () => void this.zerar());
  }

  async abrir() {
    await this.carregar();
    this.aba('salas');
    this.dialog.showModal();
  }

  private async carregar() {
    const res = await fetch(`${this.api}/memoria`);
    const json = await res.json();
    this.md = json.md;
    this.existe = json.existe;
    $<HTMLTextAreaElement>('#pa-md').value = this.md;
    const itens = itensDoPalacio(this.md);
    const opcoes = (sel: string, valores: (string | undefined)[], todos: string) => {
      const el = $<HTMLSelectElement>(sel);
      const atual = el.value;
      el.replaceChildren(new Option(todos, ''), ...[...new Set(valores.filter(Boolean))].sort().map((v) => new Option(v!, v!)));
      el.value = atual;
    };
    opcoes('#pa-persona', itens.map((i) => i.persona), 'todas as personas');
    opcoes('#pa-conversa', itens.map((i) => i.conversa), 'todas as conversas');
    this.status(this.existe ? `${itens.length} ${itens.length === 1 ? 'item' : 'itens'}` : 'ainda vazia');
    this.desenharSalas();
    this.mudou(this.existe ? itens.length : 0);
  }

  private aba(qual: string) {
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-pa-aba]')) b.classList.toggle('active', b.dataset.paAba === qual);
    for (const p of document.querySelectorAll<HTMLElement>('[data-pa-pane]')) p.hidden = p.dataset.paPane !== qual;
    if (qual === 'historico') void this.historico();
  }

  private desenharSalas() {
    const itens = filtrar(itensDoPalacio(this.md), {
      busca: $<HTMLInputElement>('#pa-busca').value,
      persona: $<HTMLSelectElement>('#pa-persona').value,
      conversa: $<HTMLSelectElement>('#pa-conversa').value,
    });
    const salas = [...new Set(this.md.split('\n').flatMap((l) => /^##\s+(.+?)\s*$/.exec(l)?.[1] ?? []))];
    $('#pa-salas').replaceChildren(
      ...salas.map((sala) => {
        const card = Object.assign(document.createElement('section'), { className: 'pa-sala' });
        const daSala = itens.filter((i) => i.sala === sala);
        card.innerHTML = `<h4>${escapar(sala)} <span>${daSala.length}</span></h4>`;
        const lista = document.createElement('ul');
        if (!daSala.length) lista.innerHTML = '<li class="pa-vazio">nada aqui</li>';
        for (const item of daSala) lista.append(this.item(item));
        card.append(lista);
        return card;
      }),
    );
  }

  private item(i: ItemDoPalacio) {
    const li = Object.assign(document.createElement('li'), { className: `pa-item ${i.status}` });
    const texto = Object.assign(document.createElement('span'), { className: 'pa-texto', textContent: i.texto });
    const editar = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Editar', title: 'Editar o item' });
    const apagar = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Apagar', className: 'danger', title: 'Apagar o item' });
    editar.addEventListener('click', () => {
      const novo = prompt('Editar o item da memória:', i.texto);
      if (novo !== null && novo.trim() && novo.trim() !== i.texto) void this.gravar(editarItem(this.md, i.sala, i.indice, novo));
    });
    apagar.addEventListener('click', () => void this.gravar(removerItem(this.md, i.sala, i.indice)));
    li.append(texto, editar, apagar);
    return li;
  }

  private async historico() {
    const versoes = (await fetch(`${this.api}/memoria/historico`).then((r) => r.json())) as { id: string; em: string; conversa: string; itens: number }[];
    const ul = $('#pa-versoes');
    if (!versoes.length) ul.innerHTML = '<li class="pa-vazio">sem versões ainda</li>';
    else
      ul.replaceChildren(
        ...versoes.map((v) => {
          const b = Object.assign(document.createElement('button'), {
            type: 'button',
            textContent: `${v.em ? new Date(v.em).toLocaleString('pt-BR') : v.id} · ${v.conversa} · ${v.itens} itens`,
          });
          b.addEventListener('click', async () => {
            $('#pa-versao').textContent = await fetch(`${this.api}/memoria/historico/${encodeURIComponent(v.id)}`).then((r) => r.text());
          });
          const li = document.createElement('li');
          li.append(b);
          return li;
        }),
      );
    $('#pa-versao').textContent = '';
  }

  private async gravar(md: string) {
    const res = await fetch(`${this.api}/memoria`, { method: 'PUT', body: md });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return this.status(json.error ?? `Erro ${res.status}`, true);
    await this.carregar();
    this.status('salvo');
  }

  private async zerar() {
    if (!confirm('Zerar a memória deste diagrama? A versão atual vai para .removidos/.')) return;
    await fetch(`${this.api}/memoria`, { method: 'DELETE' });
    await this.carregar();
  }

  private status(texto: string, erro = false) {
    const el = $('#pa-status');
    el.textContent = texto;
    el.classList.toggle('error', erro);
  }
}
