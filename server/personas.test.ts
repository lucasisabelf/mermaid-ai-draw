import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpError } from '../src/ops.ts';
import { carregarTemplates, MODELO_PADRAO, parsePersona, personaDoTemplate, PersonaStore, renderPersona } from './personas.ts';

const CETICA = `# Cética

Você é uma analista cética: procura riscos, custos escondidos e evidências fracas.

\`\`\`yaml
motor: api
modelo: claude-sonnet-5-5
esforco: high
papel: debatedora
cor: "#e11d48"
\`\`\`
`;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personas-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('parsePersona', () => {
  it('lê o prompt (o texto fora do yaml) e as opções', () => {
    const p = parsePersona('n2', CETICA, 'Cética');
    expect(p).toMatchObject({ id: 'n2', nome: 'Cética', motor: 'api', modelo: 'claude-sonnet-5-5', esforco: 'high', papel: 'debatedora', cor: '#e11d48' });
    expect(p.prompt).toBe('Você é uma analista cética: procura riscos, custos escondidos e evidências fracas.');
    expect(p.ferramentas).toEqual([]);
  });

  it('completa o que falta com os padrões do motor', () => {
    const p = parsePersona('n1', '# Otimista\n\nVê oportunidades.\n\n```yaml\nmotor: ollama\n```\n', 'Otimista');
    expect(p).toMatchObject({ motor: 'ollama', modelo: MODELO_PADRAO.ollama, esforco: 'medium', papel: 'debatedora' });
    expect(p.cor).toMatch(/^#[0-9a-f]{6}$/i);
    // Sem bloco yaml: tudo padrão, motor MCP (o que funciona sem chave).
    expect(parsePersona('n3', 'Só um prompt.', 'X')).toMatchObject({ motor: 'mcp', modelo: MODELO_PADRAO.mcp, prompt: 'Só um prompt.' });
  });

  it('recusa valores inválidos com uma mensagem clara', () => {
    for (const [yaml, msg] of [
      ['motor: gpt', 'motor'],
      ['esforco: turbo', 'esforco'],
      ['papel: chefe', 'papel'],
      ['cor: vermelho', 'cor'],
      ['modelo: ""', 'modelo'],
      ['ferramentas: [martelo]', 'ferramentas'],
      ['motor: [', 'yaml'],
    ]) {
      const fn = () => parsePersona('n1', `Prompt.\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n`, 'X');
      expect(fn, yaml).toThrow(OpError);
      expect(fn, yaml).toThrow(new RegExp(msg));
    }
  });

  it('marca o bloco de início (inicio: true), que é falso por padrão', () => {
    expect(parsePersona('n1', CETICA, 'Cética').inicio).toBe(false);
    const p = parsePersona('n1', 'Prompt.\n\n```yaml\ninicio: true\n```\n', 'X');
    expect(p.inicio).toBe(true);
    expect(renderPersona(p)).toContain('inicio: true');
    expect(renderPersona(parsePersona('n1', CETICA, 'Cética'))).not.toContain('inicio');
    expect(() => parsePersona('n1', 'x\n\n```yaml\ninicio: talvez\n```\n', 'X')).toThrow(/inicio/);
  });

  it('marca a persona de saída (saida: true) com o arquivo que ela gera', () => {
    const comum = parsePersona('n1', CETICA, 'Cética');
    expect(comum).toMatchObject({ saida: false, arquivo: 'saida.md' });
    expect(renderPersona(comum)).not.toMatch(/saida|arquivo/);

    const p = parsePersona('n5', 'Preenche o README.\n\n```yaml\nsaida: true\narquivo: README.md\n```\n', 'README');
    expect(p).toMatchObject({ saida: true, arquivo: 'README.md' });
    expect(renderPersona(p)).toContain('saida: true');
    expect(renderPersona(p)).toContain('arquivo: README.md');
    expect(parsePersona('n5', renderPersona(p), 'README')).toEqual(p);

    // O arquivo é só um nome .md (sem pasta), e saida é booleano.
    for (const ruim of ['arquivo: ../fora.md', 'arquivo: docs/x.md', 'arquivo: README.txt', 'arquivo: ""', 'saida: sim']) {
      expect(() => parsePersona('n5', `x\n\n\`\`\`yaml\n${ruim}\n\`\`\`\n`, 'X'), ruim).toThrow(OpError);
    }
  });

  it('renderPersona e parsePersona fazem ida e volta', () => {
    const p = parsePersona('n2', CETICA, 'Cética');
    expect(parsePersona('n2', renderPersona(p), 'Cética')).toEqual(p);
  });
});

describe('PersonaStore', () => {
  it('lê o padrão quando não há arquivo, grava validando e remove para .removidos', () => {
    const store = new PersonaStore(dir);
    expect(store.ler('n1', 'Nova')).toMatchObject({ id: 'n1', nome: 'Nova', motor: 'mcp' });
    expect(store.lerMd('n1', 'Nova')).toContain('# Nova');

    expect(() => store.gravarMd('n1', 'x\n\n```yaml\nmotor: gpt\n```\n')).toThrow(OpError);
    const salva = store.gravarMd('n1', CETICA);
    expect(salva.motor).toBe('api');
    expect(fs.readFileSync(path.join(dir, 'n1.md'), 'utf8')).toBe(CETICA);
    // O nome vem do retângulo (o texto do nó), não do título do .md.
    expect(store.ler('n1', 'Cética do canvas').nome).toBe('Cética do canvas');

    store.remover('n1');
    expect(fs.existsSync(path.join(dir, 'n1.md'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, '.removidos'))).toHaveLength(1);
    expect(() => store.ler('../fora', 'x')).toThrow(OpError);
  });

  it('o template de saída fica num arquivo próprio, separado da persona', () => {
    const store = new PersonaStore(dir);
    store.gravarMd('n5', CETICA);
    // Sem arquivo: o template padrão.
    expect(store.temTemplate('n5')).toBe(false);
    expect(store.lerTemplate('n5')).toContain('#');

    store.gravarTemplate('n5', '# {{titulo}}\n\n## Visão\n');
    expect(fs.readFileSync(path.join(dir, 'n5.saida.md'), 'utf8')).toBe('# {{titulo}}\n\n## Visão\n');
    expect(store.lerTemplate('n5')).toBe('# {{titulo}}\n\n## Visão\n');
    // Gravar o template não toca na persona, e ele não vira uma persona na lista.
    expect(fs.readFileSync(path.join(dir, 'n5.md'), 'utf8')).toBe(CETICA);
    expect(store.ids()).toEqual(['n5']);
    expect(store.idsComTemplate()).toEqual(['n5']);
    expect(() => store.gravarTemplate('n5', '   ')).toThrow(OpError);

    // Remover o retângulo leva os dois arquivos para .removidos/.
    store.remover('n5');
    expect(fs.existsSync(path.join(dir, 'n5.saida.md'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, '.removidos'))).toHaveLength(2);
  });
});

describe('templates', () => {
  it('carrega os papéis e cria a persona no motor escolhido, com o modelo daquele motor', () => {
    fs.writeFileSync(
      path.join(dir, 'moderadora.md'),
      `# Moderadora\n\nVocê conduz o debate e no fim sintetiza.\n\n\`\`\`yaml\npapel: moderadora\ncor: "#7c3aed"\nesforco: high\ndescricao: Conduz e sintetiza.\nmodelos:\n  mcp: claude-opus-5-5\n  ollama: llama3.2:3b\n  api: claude-sonnet-5-5\n\`\`\`\n`,
    );
    fs.writeFileSync(path.join(dir, 'LEIAME.txt'), 'ignorado');
    const [t, ...resto] = carregarTemplates(dir);
    expect(resto).toHaveLength(0);
    expect(t).toMatchObject({ nome: 'moderadora', titulo: 'Moderadora', papel: 'moderadora', descricao: 'Conduz e sintetiza.' });

    const viaOllama = personaDoTemplate(t, 'n4', 'ollama');
    expect(viaOllama).toMatchObject({ id: 'n4', nome: 'Moderadora', motor: 'ollama', modelo: 'llama3.2:3b', papel: 'moderadora', esforco: 'high', cor: '#7c3aed' });
    expect(viaOllama.prompt).toBe('Você conduz o debate e no fim sintetiza.');
    expect(personaDoTemplate(t, 'n5', 'api').modelo).toBe('claude-sonnet-5-5');
  });

  it('os templates do projeto cobrem os papéis e os três motores', () => {
    const ts = carregarTemplates(path.join(import.meta.dirname, '..', 'templates'));
    const nomes = ts.map((t) => t.nome);
    for (const n of ['otimista', 'cetica', 'especialista', 'moderadora', 'orquestradora', 'pesquisadora', 'redatora', 'revisora']) {
      expect(nomes).toContain(n);
    }
    for (const t of ts) {
      expect(Object.keys(t.modelos).sort(), t.nome).toEqual(['api', 'mcp', 'ollama']);
      expect(t.prompt.length, t.nome).toBeGreaterThan(40);
    }
    expect(ts.find((t) => t.nome === 'orquestradora')!.papel).toBe('orquestradora');
  });
});
