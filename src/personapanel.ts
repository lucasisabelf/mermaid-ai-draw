import type { Store } from './store';

/**
 * Painel da persona do retângulo selecionado: motor, modelo, papel, esforço, cor e o prompt.
 * Grava sozinho (o .md em personas/<id>.md), um pouco depois da última alteração.
 */

export interface PersonaView {
  id: string;
  nome: string;
  prompt: string;
  motor: 'mcp' | 'ollama' | 'api';
  modelo: string;
  esforco: string;
  papel: string;
  cor: string;
  ferramentas: string[];
  inicio: boolean;
  saida: boolean;
  arquivo: string;
  humana: boolean;
  prazo?: number;
  aoVencer: 'seguir' | 'encerrar';
  depois?: { diagrama: string; modo?: string; rodadas?: number; prefixo?: string };
  memoria: boolean;
  escuta: 'todas' | string[];
  quando: 'rodada' | 'fala';
  limite: number;
  resumoPara: 'todas' | string[];
}

const SALVAR_MS = 600;
const PADRAO: Record<PersonaView['motor'], string> = { mcp: 'claude-opus-5-5', ollama: 'qwen2.5:3b', api: 'claude-opus-5-5' };
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** O .md da persona, no mesmo formato que o servidor grava. */
export function personaMd(p: PersonaView) {
  const linhas = [`motor: ${p.motor}`, `modelo: ${p.modelo}`, `esforco: ${p.esforco}`, `papel: ${p.papel}`, `cor: "${p.cor}"`];
  if (p.ferramentas.length) linhas.push(`ferramentas: [${p.ferramentas.join(', ')}]`);
  if (p.inicio) linhas.push('inicio: true');
  if (p.saida) linhas.push('saida: true');
  if (p.arquivo && p.arquivo !== 'saida.md') linhas.push(`arquivo: ${JSON.stringify(p.arquivo)}`);
  if (p.humana) linhas.push('humana: true');
  if (p.prazo) linhas.push(`prazo: ${p.prazo}`);
  if (p.aoVencer === 'encerrar') linhas.push('aoVencer: encerrar');
  if (p.memoria) linhas.push('memoria: true');
  if (p.escuta !== 'todas') linhas.push(`escuta: [${p.escuta.join(', ')}]`);
  if (p.quando === 'fala') linhas.push('quando: fala');
  if (p.limite && p.limite !== 4000) linhas.push(`limite: ${p.limite}`);
  if (p.resumoPara !== 'todas') linhas.push(`resumoPara: [${p.resumoPara.join(', ')}]`);
  if (p.depois?.diagrama) {
    linhas.push('depois:', `  diagrama: ${p.depois.diagrama}`);
    if (p.depois.modo) linhas.push(`  modo: ${p.depois.modo}`);
    if (p.depois.rodadas) linhas.push(`  rodadas: ${p.depois.rodadas}`);
    if (p.depois.prefixo) linhas.push(`  prefixo: ${JSON.stringify(p.depois.prefixo)}`);
  }
  return `# ${p.nome}\n\n${p.prompt.trim()}\n\n\`\`\`yaml\n${linhas.join('\n')}\n\`\`\`\n`;
}

export class PersonaPanel {
  private id: string | null = null;
  private atual: PersonaView | null = null;
  private timer?: number;
  private sujo = false;
  private modelos: Record<string, string[]> = {};
  private root = $('#persona-panel');
  private campos = {
    motor: $<HTMLSelectElement>('#pp-motor'),
    modelo: $<HTMLInputElement>('#pp-modelo'),
    papel: $<HTMLSelectElement>('#pp-papel'),
    esforco: $<HTMLSelectElement>('#pp-esforco'),
    cor: $<HTMLInputElement>('#pp-cor'),
    prompt: $<HTMLTextAreaElement>('#pp-prompt'),
    inicio: $<HTMLInputElement>('#pp-inicio'),
    saida: $<HTMLInputElement>('#pp-saida'),
    arquivo: $<HTMLInputElement>('#pp-arquivo'),
    humana: $<HTMLInputElement>('#pp-humana'),
    prazo: $<HTMLInputElement>('#pp-prazo'),
    aoVencer: $<HTMLSelectElement>('#pp-aovencer'),
    depois: $<HTMLSelectElement>('#pp-depois'),
    depoisModo: $<HTMLSelectElement>('#pp-depois-modo'),
    depoisRodadas: $<HTMLInputElement>('#pp-depois-rodadas'),
    memoria: $<HTMLInputElement>('#pp-memoria'),
    quando: $<HTMLSelectElement>('#pp-quando'),
    limite: $<HTMLInputElement>('#pp-limite'),
  };
  private template = new TemplateEditor();

  constructor(
    private api: string,
    private store: Store,
    /** Avisa o resto da tela (canvas, chat) que a persona mudou. */
    private mudou: (p: PersonaView) => void,
  ) {
    store.subscribe(() => {
      const sel = store.selection?.kind === 'node' ? store.selection.id : null;
      if (sel !== this.id) void this.mostrar(sel);
    });
    for (const el of Object.values(this.campos)) el.addEventListener('input', () => this.editar());
    this.campos.motor.addEventListener('change', () => {
      // Trocar de motor troca o modelo pelo padrão do novo motor, se o atual não for dele.
      const motor = this.campos.motor.value as PersonaView['motor'];
      const doClaude = this.campos.modelo.value.startsWith('claude');
      if ((motor === 'ollama') === doClaude) this.campos.modelo.value = this.modelos[motor]?.[0] ?? PADRAO[motor];
      this.preencherModelos();
      this.editar();
    });
    $('#pp-template').addEventListener('click', () => this.atual && void this.template.abrir(`${this.api}/personas/${encodeURIComponent(this.atual.id)}/saida`, this.atual.arquivo));
    document.addEventListener('motores', (e) => {
      for (const m of (e as CustomEvent).detail as { nome: string; modelos: string[]; ok: boolean; detalhe: string }[]) {
        this.modelos[m.nome] = m.modelos;
        const opt = [...this.campos.motor.options].find((o) => o.value === m.nome);
        if (opt) opt.textContent = `${opt.textContent!.replace(/ \(fora do ar\)$/, '')}${m.ok ? '' : ' (fora do ar)'}`;
      }
      this.preencherModelos();
    });
  }

  /** Tecla I: marca ou desmarca o bloco de início da persona selecionada (e grava já). */
  alternarInicio() {
    if (!this.atual) return;
    this.campos.inicio.checked = !this.campos.inicio.checked;
    this.editar();
    void this.salvar();
  }

  /** Outra aba (ou o MCP) mudou a persona: recarrega se não há edição pendente aqui. */
  atualizada(p: PersonaView) {
    if (p.id === this.id && !this.sujo) this.preencher(p);
  }

  private async mostrar(id: string | null) {
    if (this.sujo) await this.salvar();
    this.id = id;
    this.root.hidden = !id;
    if (!id) return;
    const res = await fetch(`${this.api}/personas/${encodeURIComponent(id)}`);
    if (!res.ok || this.id !== id) return;
    this.preencher((await res.json()).persona as PersonaView);
  }

  private preencher(p: PersonaView) {
    this.atual = p;
    $('#pp-titulo').textContent = `Persona · ${p.nome}`;
    const c = this.campos;
    c.motor.value = p.motor;
    c.modelo.value = p.modelo;
    c.papel.value = p.papel;
    c.esforco.value = p.esforco;
    c.cor.value = p.cor;
    c.inicio.checked = p.inicio;
    c.saida.checked = p.saida;
    if (document.activeElement !== c.arquivo) c.arquivo.value = p.arquivo;
    $('#pp-saida-box').hidden = !p.saida;
    c.humana.checked = p.humana;
    if (document.activeElement !== c.prazo) c.prazo.value = p.prazo ? String(p.prazo) : '';
    c.aoVencer.value = p.aoVencer;
    void this.preencherDiagramas(p.depois?.diagrama ?? '');
    c.depoisModo.value = p.depois?.modo ?? 'debate';
    c.depoisRodadas.value = String(p.depois?.rodadas ?? 2);
    $('#pp-depois-box').hidden = !p.saida;
    c.memoria.checked = p.memoria;
    c.quando.value = p.quando;
    if (document.activeElement !== c.limite) c.limite.value = String(p.limite);
    $('#pp-memoria-box').hidden = !p.memoria;
    this.preencherLista('#pp-escuta', p.id, p.escuta);
    this.preencherLista('#pp-resumo', p.id, p.resumoPara);
    this.mostrarHumana(p.humana);
    if (document.activeElement !== c.prompt) c.prompt.value = p.prompt;
    this.preencherModelos();
    this.status('');
  }

  /** Uma lista de personas ("Escuta:", "Resumo no início para:"): "todas" e cada uma (menos a própria memória). */
  private preencherLista(sel: string, proprio: string, valor: 'todas' | string[]) {
    const box = $(sel);
    const caixa = (valor: string, rotulo: string, marcada: boolean) => {
      const l = Object.assign(document.createElement('label'), { className: 'pp-inicio' });
      const i = Object.assign(document.createElement('input'), { type: 'checkbox', value: valor, checked: marcada });
      i.addEventListener('change', () => {
        if (valor === 'todas' && i.checked) for (const o of box.querySelectorAll<HTMLInputElement>('input')) o.checked = o === i;
        if (valor !== 'todas' && i.checked) box.querySelector<HTMLInputElement>('input[value="todas"]')!.checked = false;
        this.editar();
      });
      l.append(i, ` ${rotulo}`);
      return l;
    };
    const todas = valor === 'todas';
    box.replaceChildren(
      caixa('todas', 'todas', todas),
      ...this.store.diagram.nodes.filter((n) => n.id !== proprio).map((n) => caixa(n.id, n.text, !todas && valor.includes(n.id))),
    );
  }

  /** "todas", os ids marcados, ou undefined quando nada está marcado (cada lista decide o padrão). */
  private marcadas(sel: string): 'todas' | string[] | undefined {
    const marcadas = [...document.querySelectorAll<HTMLInputElement>(`${sel} input:checked`)].map((i) => i.value);
    if (marcadas.includes('todas')) return 'todas';
    return marcadas.length ? marcadas : undefined;
  }

  /** Os diagramas para o pós-fluxo (o atual também vale: a cadeia tem limite). */
  private async preencherDiagramas(escolhido: string) {
    const lista = (await fetch('/api/diagrams').then((r) => r.json()).catch(() => [])) as { slug: string; name: string }[];
    const sel = this.campos.depois;
    sel.replaceChildren(new Option('— nada —', ''), ...lista.map((d) => new Option(d.name, d.slug)));
    if (escolhido && !lista.some((d) => d.slug === escolhido)) sel.append(new Option(`${escolhido} (não existe)`, escolhido));
    sel.value = escolhido;
  }

  /** A persona humana não usa motor: o prazo aparece e os campos do motor ficam apagados. */
  private mostrarHumana(humana: boolean) {
    $('#pp-humana-box').hidden = !humana;
    this.root.classList.toggle('pp-e-humana', humana);
  }

  private preencherModelos() {
    const lista = this.modelos[this.campos.motor.value] ?? [];
    $('#pp-modelos').replaceChildren(...lista.map((m) => new Option(m, m)));
    this.campos.esforco.disabled = this.campos.motor.value !== 'api';
    this.campos.esforco.title = this.campos.esforco.disabled ? 'O esforço só vale no motor API.' : '';
  }

  private editar() {
    if (!this.atual) return;
    const c = this.campos;
    this.atual = { ...this.atual, motor: c.motor.value as PersonaView['motor'], modelo: c.modelo.value.trim(), papel: c.papel.value, esforco: c.esforco.value, cor: c.cor.value, prompt: c.prompt.value, inicio: c.inicio.checked, saida: c.saida.checked, arquivo: c.arquivo.value.trim() || 'saida.md', humana: c.humana.checked, prazo: Number(c.prazo.value) > 0 ? Number(c.prazo.value) : undefined, aoVencer: c.aoVencer.value as 'seguir' | 'encerrar', depois: c.depois.value ? { ...this.atual.depois, diagrama: c.depois.value, modo: c.depoisModo.value, rodadas: Number(c.depoisRodadas.value) || 2 } : undefined, memoria: c.memoria.checked, escuta: this.marcadas('#pp-escuta') ?? 'todas', resumoPara: this.marcadas('#pp-resumo') ?? [], quando: c.quando.value as 'rodada' | 'fala', limite: Math.max(200, Number(c.limite.value) || 4000) };
    $('#pp-saida-box').hidden = !c.saida.checked;
    this.mostrarHumana(c.humana.checked);
    $('#pp-depois-box').hidden = !c.saida.checked;
    $('#pp-memoria-box').hidden = !c.memoria.checked;
    this.sujo = true;
    this.status('alterações não salvas…');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.salvar(), SALVAR_MS);
  }

  private async salvar() {
    clearTimeout(this.timer);
    const p = this.atual;
    if (!p || !this.sujo) return;
    this.sujo = false;
    const res = await fetch(`${this.api}/personas/${encodeURIComponent(p.id)}`, { method: 'PUT', body: personaMd(p) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return this.status(json.error ?? `Erro ${res.status}`, true);
    this.status('salvo');
    this.mudou(json.persona as PersonaView);
  }

  private status(texto: string, erro = false) {
    const el = $('#pp-status');
    el.textContent = texto;
    el.classList.toggle('error', erro);
  }
}

/** Editor só do template de saída (personas/<id>.saida.md): grava sozinho, sem tocar na persona. */
class TemplateEditor {
  private dialog = $<HTMLDialogElement>('#template-dialog');
  private texto = $<HTMLTextAreaElement>('#td-texto');
  private url = '';
  private timer?: number;
  private sujo = false;

  constructor() {
    this.texto.addEventListener('input', () => {
      this.sujo = true;
      this.status('alterações não salvas…');
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.salvar(), SALVAR_MS);
    });
    $('#td-fechar').addEventListener('click', () => this.dialog.close());
    // Fechar (botão, Esc ou clique fora) grava o que estiver pendente.
    this.dialog.addEventListener('close', () => void this.salvar());
    this.dialog.addEventListener('click', (e) => e.target === this.dialog && this.dialog.close());
  }

  async abrir(url: string, arquivo: string) {
    await this.salvar();
    this.url = url;
    $('#td-titulo').textContent = `Template de saída · ${arquivo}`;
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return this.status(json.error ?? `Erro ${res.status}`, true);
    this.texto.value = json.template;
    this.status(json.padrao ? 'template padrão (ainda não gravado)' : '');
    this.dialog.showModal();
    this.texto.focus();
    this.texto.setSelectionRange(0, 0);
    this.texto.scrollTop = 0;
  }

  private async salvar() {
    clearTimeout(this.timer);
    if (!this.sujo || !this.url) return;
    this.sujo = false;
    const res = await fetch(this.url, { method: 'PUT', body: this.texto.value });
    const json = await res.json().catch(() => ({}));
    this.status(res.ok ? 'salvo' : (json.error ?? `Erro ${res.status}`), !res.ok);
  }

  private status(texto: string, erro = false) {
    const el = $('#td-status');
    el.textContent = texto;
    el.classList.toggle('error', erro);
  }
}
