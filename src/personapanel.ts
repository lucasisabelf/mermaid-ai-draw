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
}

const SALVAR_MS = 600;
const PADRAO: Record<PersonaView['motor'], string> = { mcp: 'claude-opus-5-5', ollama: 'qwen2.5:3b', api: 'claude-opus-5-5' };
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** O .md da persona, no mesmo formato que o servidor grava. */
export function personaMd(p: PersonaView) {
  const linhas = [`motor: ${p.motor}`, `modelo: ${p.modelo}`, `esforco: ${p.esforco}`, `papel: ${p.papel}`, `cor: "${p.cor}"`];
  if (p.ferramentas.length) linhas.push(`ferramentas: [${p.ferramentas.join(', ')}]`);
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
  };

  constructor(
    private api: string,
    store: Store,
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
    document.addEventListener('motores', (e) => {
      for (const m of (e as CustomEvent).detail as { nome: string; modelos: string[]; ok: boolean; detalhe: string }[]) {
        this.modelos[m.nome] = m.modelos;
        const opt = [...this.campos.motor.options].find((o) => o.value === m.nome);
        if (opt) opt.textContent = `${opt.textContent!.replace(/ \(fora do ar\)$/, '')}${m.ok ? '' : ' (fora do ar)'}`;
      }
      this.preencherModelos();
    });
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
    if (document.activeElement !== c.prompt) c.prompt.value = p.prompt;
    this.preencherModelos();
    this.status('');
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
    this.atual = { ...this.atual, motor: c.motor.value as PersonaView['motor'], modelo: c.modelo.value.trim(), papel: c.papel.value, esforco: c.esforco.value, cor: c.cor.value, prompt: c.prompt.value };
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
