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
  /** Bloco de início: a rodada começa por ela (num ciclo, é quem abre a conversa). */
  inicio: boolean;
  /** Persona de saída: não fala nas rodadas; roda uma vez no fim e preenche o template em `arquivo`. */
  saida: boolean;
  /** O nome do .md que a persona de saída gera (padrão saida.md). */
  arquivo: string;
  /** Persona humana: é você; na vez dela, a conversa espera a sua resposta (sem motor). */
  humana: boolean;
  /** Minutos de espera da persona humana; sem prazo, espera para sempre. */
  prazo?: number;
  /** O que fazer quando o prazo vence: seguir sem resposta ou encerrar a conversa. */
  aoVencer: 'seguir' | 'encerrar';
  /** Pós-fluxo (persona de saída): o diagrama que começa quando ela termina, com o .md como assunto. */
  depois?: PosFluxo;
  /** Persona de memória: escuta as personas (sem setas) e mantém o memoria.md do diagrama. */
  memoria: boolean;
  /** Quem a memória escuta: "todas" ou os ids dos retângulos. */
  escuta: 'todas' | string[];
  /** Quando ela atualiza: no fim de cada rodada ou depois de cada fala escutada. */
  quando: 'rodada' | 'fala';
  /** Tamanho-alvo do memoria.md, em caracteres. */
  limite: number;
  /** Quem recebe o resumo da memória no início ("todas" ou ids; [] = só consultam com RECORDAR). */
  resumoPara: 'todas' | string[];
}

/** O memoria.md de um diagrama que ainda não tem: as salas do "palácio". */
export const MEMORIA_PADRAO = `# Memória

## Decisões

## Fatos

## Hipóteses

## Pendências

## Preferências do usuário
`;

export interface PosFluxo {
  diagrama: string;
  modo?: 'debate' | 'resposta' | 'tarefa';
  rodadas?: number;
  /** Texto antes do .md no assunto da conversa disparada. */
  prefixo?: string;
}

const SLUG_DIAGRAMA_RE = /^[a-z0-9][a-z0-9-]*$/;

/** "todas" ou uma lista de ids de retângulos (quem a memória escuta, ou quem recebe o resumo dela). */
function lerEscuta(campo: string, v: unknown): 'todas' | string[] {
  if (v === undefined || v === null || v === 'todas') return 'todas';
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !ID_RE.test(x))) invalido(`"${campo}" deve ser "todas" ou uma lista de ids (ex.: [n1, n3]).`);
  return v as string[];
}

function lerPosFluxo(v: unknown): PosFluxo | undefined {
  if (v === undefined || v === null) return undefined;
  const msg = '"depois" deve ter o diagrama a iniciar (ex.: depois: {diagrama: plano, modo: tarefa, rodadas: 1}).';
  if (typeof v !== 'object' || Array.isArray(v)) invalido(msg);
  const o = v as Record<string, unknown>;
  if (typeof o.diagrama !== 'string' || !SLUG_DIAGRAMA_RE.test(o.diagrama)) invalido(msg);
  const p: PosFluxo = { diagrama: o.diagrama as string };
  if (o.modo !== undefined) p.modo = umDe('depois.modo', o.modo, ['debate', 'resposta', 'tarefa'] as const, 'debate');
  if (o.rodadas !== undefined) {
    if (!Number.isInteger(o.rodadas) || (o.rodadas as number) < 1 || (o.rodadas as number) > 10) invalido('"depois.rodadas" deve ser de 1 a 10.');
    p.rodadas = o.rodadas as number;
  }
  if (typeof o.prefixo === 'string' && o.prefixo.trim()) p.prefixo = o.prefixo.trim();
  return p;
}

/** Template de quem é marcada como saída e ainda não tem o seu (personas/<id>.saida.md). */
export const TEMPLATE_SAIDA_PADRAO = `# {{título}}

## Resumo
{{o resultado da conversa em poucas linhas}}

## Detalhes
{{os pontos principais, em tópicos}}

## Próximos passos
{{o que fazer a seguir}}
`;

const FENCE_RE = /^```ya?ml[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m;
const COR_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[A-Za-z][\w-]*$/;
/** Só um nome de arquivo .md, sem pasta. */
export const ARQUIVO_RE = /^[\p{L}\p{N}_][\p{L}\p{N} _.()-]*\.md$/u;
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
  if (y.inicio !== undefined && typeof y.inicio !== 'boolean') invalido('"inicio" deve ser true ou false.');
  if (y.saida !== undefined && typeof y.saida !== 'boolean') invalido('"saida" deve ser true ou false.');
  if (y.humana !== undefined && typeof y.humana !== 'boolean') invalido('"humana" deve ser true ou false.');
  if (y.prazo !== undefined && (typeof y.prazo !== 'number' || !(y.prazo > 0))) invalido('"prazo" deve ser um número de minutos maior que zero.');
  if (y.memoria !== undefined && typeof y.memoria !== 'boolean') invalido('"memoria" deve ser true ou false.');
  if (y.arquivo !== undefined && (typeof y.arquivo !== 'string' || !ARQUIVO_RE.test(y.arquivo) || y.arquivo.includes('..'))) {
    invalido('"arquivo" deve ser só o nome de um .md, como "README.md".');
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
    inicio: y.inicio === true,
    saida: y.saida === true,
    arquivo: (y.arquivo as string | undefined) ?? 'saida.md',
    humana: y.humana === true,
    ...(y.prazo !== undefined ? { prazo: y.prazo as number } : {}),
    aoVencer: umDe('aoVencer', y.aoVencer, ['seguir', 'encerrar'] as const, 'seguir'),
    ...(y.depois !== undefined ? { depois: lerPosFluxo(y.depois) } : {}),
    memoria: y.memoria === true,
    escuta: lerEscuta('escuta', y.escuta),
    resumoPara: lerEscuta('resumoPara', y.resumoPara),
    quando: umDe('quando', y.quando, ['rodada', 'fala'] as const, 'rodada'),
    limite: y.limite === undefined ? 4000 : (Number.isInteger(y.limite) && (y.limite as number) >= 200 ? (y.limite as number) : invalido('"limite" deve ser um número inteiro de caracteres, a partir de 200.')),
  };
}

export function renderPersona(p: Persona): string {
  const opcoes: Record<string, unknown> = { motor: p.motor, modelo: p.modelo, esforco: p.esforco, papel: p.papel, cor: p.cor };
  if (p.ferramentas.length) opcoes.ferramentas = p.ferramentas;
  if (p.inicio) opcoes.inicio = true;
  if (p.saida) opcoes.saida = true;
  if (p.arquivo !== 'saida.md') opcoes.arquivo = p.arquivo;
  if (p.humana) opcoes.humana = true;
  if (p.prazo !== undefined) opcoes.prazo = p.prazo;
  if (p.aoVencer !== 'seguir') opcoes.aoVencer = p.aoVencer;
  if (p.depois) opcoes.depois = p.depois;
  if (p.memoria) opcoes.memoria = true;
  if (p.escuta !== 'todas') opcoes.escuta = p.escuta;
  if (p.quando !== 'rodada') opcoes.quando = p.quando;
  if (p.limite !== 4000) opcoes.limite = p.limite;
  if (p.resumoPara !== 'todas') opcoes.resumoPara = p.resumoPara;
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

  private arquivoTemplate(id: string) {
    this.arquivo(id);
    return path.join(this.dir, `${id}.saida.md`);
  }

  temTemplate(id: string) {
    return fs.existsSync(this.arquivoTemplate(id));
  }

  /** O template de saída (personas/<id>.saida.md); sem arquivo, o padrão. */
  lerTemplate(id: string): string {
    try {
      return fs.readFileSync(this.arquivoTemplate(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return TEMPLATE_SAIDA_PADRAO;
    }
  }

  /** Grava só o template: a persona (<id>.md) não muda. */
  gravarTemplate(id: string, md: string) {
    if (!md.trim()) invalido('O template de saída não pode ficar vazio.');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.arquivoTemplate(id), md);
  }

  remover(id: string) {
    const lixo = path.join(this.dir, '.removidos');
    const quando = Date.now();
    for (const [src, nome] of [
      [this.arquivo(id), `${id}-${quando}.md`],
      [this.arquivoTemplate(id), `${id}-${quando}.saida.md`],
    ]) {
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(lixo, { recursive: true });
      fs.renameSync(src, path.join(lixo, nome));
    }
  }

  /** Ids com arquivo (para exportar). */
  ids(): string[] {
    return this.listar('.md');
  }

  /** Ids com template de saída próprio (para exportar). */
  idsComTemplate(): string[] {
    return this.listar('.saida.md');
  }

  private listar(fim: string): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith(fim))
        .map((f) => f.slice(0, -fim.length))
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
  return { id, nome, prompt: t.prompt, motor, modelo: t.modelos[motor], esforco: t.esforco, papel: t.papel, cor: t.cor, ferramentas: [], inicio: false, saida: false, arquivo: 'saida.md', humana: false, aoVencer: 'seguir', memoria: false, escuta: 'todas', quando: 'rodada', limite: 4000, resumoPara: 'todas' };
}
