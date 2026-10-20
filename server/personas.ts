import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { OpError } from '../src/ops.ts';

/**
 * Cada retângulo é uma persona, descrita em `diagrams/<slug>/personas/<id>.md`: o texto é o system
 * prompt e um bloco ```yaml traz as opções. O nome é o texto do retângulo.
 *
 * ````md
 * # Cética
 * Você é uma analista cética…
 *
 * ```yaml
 * motor: mcp            # mcp (o Claude Code conectado) · ollama (local) · api (chave da Anthropic)
 * modelo: claude-opus-5-5
 * esforco: medium
 * papel: debatedora     # debatedora · moderadora · orquestradora · executora
 * cor: "#e11d48"
 * ```
 * ````
 */

export type MotorNome = 'mcp' | 'ollama' | 'api';
export const MOTORES: MotorNome[] = ['mcp', 'ollama', 'api'];
export type Papel = 'debatedora' | 'moderadora' | 'orquestradora' | 'executora';
export const PAPEIS: Papel[] = ['debatedora', 'moderadora', 'orquestradora', 'executora'];
export type Esforco = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const ESFORCOS: Esforco[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Ferramentas que o motor API sabe ligar. */
export const FERRAMENTAS = ['web_search'];

/** Modelo de cada motor quando a persona não diz qual. */
export const MODELO_PADRAO: Record<MotorNome, string> = {
  mcp: 'claude-opus-5-5',
  ollama: 'qwen2.5:3b',
  api: 'claude-opus-5-5',
};

export interface Persona {
  id: string;
  nome: string;
  /** O system prompt: o texto do .md fora do título e do bloco yaml. */
  prompt: string;
  motor: MotorNome;
  modelo: string;
  esforco: Esforco;
  papel: Papel;
  cor: string;
  ferramentas: string[];
}

const FENCE_RE = /^```ya?ml[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m;
const COR_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[A-Za-z][\w-]*$/;
const CORES = ['#2563eb', '#e11d48', '#059669', '#7c3aed', '#d97706', '#0891b2', '#db2777', '#4f46e5'];

/** Cor estável para quem não escolheu uma (pelo id). */
function corPadrao(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CORES[h % CORES.length];
}

const invalido = (msg: string): never => {
  throw new OpError(400, msg);
};

/** Separa o título (# …), o prompt e o yaml do .md. */
function partes(md: string) {
  const m = FENCE_RE.exec(md);
  const semYaml = m ? md.slice(0, m.index) + md.slice(m.index + m[0].length) : md;
  const prompt = semYaml.replace(/^\s*#[^\n]*\n/, '').trim();
  return { yaml: m?.[1] ?? '', prompt };
}

function lerYaml(yaml: string): Record<string, unknown> {
  if (!yaml.trim()) return {};
  let v: unknown;
  try {
    v = parse(yaml);
  } catch (err) {
    invalido(`yaml inválido: ${(err as Error).message.split('\n')[0]}`);
  }
  if (v === null || v === undefined) return {};
  if (typeof v !== 'object' || Array.isArray(v)) invalido('yaml inválido: esperava campos (motor, modelo…).');
  return v as Record<string, unknown>;
}

function umDe<T extends string>(campo: string, valor: unknown, opcoes: readonly T[], padrao: T): T {
  if (valor === undefined || valor === null || valor === '') return padrao;
  if (typeof valor !== 'string' || !opcoes.includes(valor as T)) invalido(`"${campo}" deve ser ${opcoes.join(', ')}; veio ${JSON.stringify(valor)}.`);
  return valor as T;
}

export function parsePersona(id: string, md: string, nome: string): Persona {
  const { yaml, prompt } = partes(md);
  const y = lerYaml(yaml);
  const motor = umDe('motor', y.motor, MOTORES, 'mcp');
  if (y.modelo !== undefined && (typeof y.modelo !== 'string' || !y.modelo.trim())) invalido('"modelo" não pode ser vazio.');
  if (y.cor !== undefined && (typeof y.cor !== 'string' || !COR_RE.test(y.cor))) invalido('"cor" deve ser como "#e11d48".');
  const ferramentas = y.ferramentas ?? [];
  if (!Array.isArray(ferramentas) || ferramentas.some((f) => !FERRAMENTAS.includes(f))) {
    invalido(`"ferramentas" aceita só: ${FERRAMENTAS.join(', ')}.`);
  }
  return {
    id,
    nome,
    prompt,
    motor,
    modelo: (y.modelo as string | undefined)?.trim() || MODELO_PADRAO[motor],
    esforco: umDe('esforco', y.esforco, ESFORCOS, 'medium'),
    papel: umDe('papel', y.papel, PAPEIS, 'debatedora'),
    cor: (y.cor as string | undefined) ?? corPadrao(id),
    ferramentas: ferramentas as string[],
  };
}

export function renderPersona(p: Persona): string {
  const opcoes: Record<string, unknown> = { motor: p.motor, modelo: p.modelo, esforco: p.esforco, papel: p.papel, cor: p.cor };
  if (p.ferramentas.length) opcoes.ferramentas = p.ferramentas;
  return `# ${p.nome}\n\n${p.prompt.trim()}\n\n\`\`\`yaml\n${stringify(opcoes)}\`\`\`\n`;
}

export function personaPadrao(id: string, nome: string): Persona {
  return parsePersona(id, `Você é ${nome}. Participe da conversa com a sua visão, de forma direta.`, nome);
}

/** As personas de um diagrama, uma por arquivo. Removidas vão para `.removidos/`. */
export class PersonaStore {
  constructor(readonly dir: string) {}

  private arquivo(id: string) {
    if (!ID_RE.test(id)) invalido(`Id de retângulo inválido: "${id}".`);
    return path.join(this.dir, `${id}.md`);
  }

  existe(id: string) {
    return fs.existsSync(this.arquivo(id));
  }

  /** O .md da persona; sem arquivo, o modelo padrão. */
  lerMd(id: string, nome: string): string {
    try {
      return fs.readFileSync(this.arquivo(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return renderPersona(personaPadrao(id, nome));
    }
  }

  ler(id: string, nome: string): Persona {
    return parsePersona(id, this.lerMd(id, nome), nome);
  }

  /** Grava o .md exatamente como veio, depois de validar. */
  gravarMd(id: string, md: string): Persona {
    const p = parsePersona(id, md, id);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.arquivo(id), md);
    return p;
  }

  gravar(p: Persona) {
    this.gravarMd(p.id, renderPersona(p));
  }

  remover(id: string) {
    const src = this.arquivo(id);
    if (!fs.existsSync(src)) return;
    const lixo = path.join(this.dir, '.removidos');
    fs.mkdirSync(lixo, { recursive: true });
    fs.renameSync(src, path.join(lixo, `${id}-${Date.now()}.md`));
  }

  /** Ids com arquivo (para exportar). */
  ids(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3))
        .filter((id) => ID_RE.test(id))
        .sort();
    } catch {
      return [];
    }
  }
}

// ---- templates ---------------------------------------------------------------

/** Um papel da paleta (templates/<nome>.md): o mesmo papel pode nascer em qualquer motor. */
export interface Template {
  nome: string;
  titulo: string;
  descricao: string;
  papel: Papel;
  cor: string;
  esforco: Esforco;
  /** O modelo de cada motor: é aqui que se configura o padrão. */
  modelos: Record<MotorNome, string>;
  prompt: string;
}

export function carregarTemplates(dir: string): Template[] {
  let arquivos: string[] = [];
  try {
    arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
  return arquivos.map((f) => {
    const md = fs.readFileSync(path.join(dir, f), 'utf8');
    const { yaml, prompt } = partes(md);
    const y = lerYaml(yaml);
    const modelos = { ...MODELO_PADRAO, ...((y.modelos as Record<string, string> | undefined) ?? {}) };
    return {
      nome: f.slice(0, -3),
      titulo: /^\s*#\s*(.+)$/m.exec(md)?.[1].trim() ?? f.slice(0, -3),
      descricao: typeof y.descricao === 'string' ? y.descricao : '',
      papel: umDe('papel', y.papel, PAPEIS, 'debatedora'),
      cor: typeof y.cor === 'string' && COR_RE.test(y.cor) ? y.cor : corPadrao(f),
      esforco: umDe('esforco', y.esforco, ESFORCOS, 'medium'),
      modelos: Object.fromEntries(MOTORES.map((m) => [m, modelos[m]])) as Record<MotorNome, string>,
      prompt,
    };
  });
}

export function personaDoTemplate(t: Template, id: string, motor: MotorNome, nome = t.titulo): Persona {
  return { id, nome, prompt: t.prompt, motor, modelo: t.modelos[motor], esforco: t.esforco, papel: t.papel, cor: t.cor, ferramentas: [] };
}
