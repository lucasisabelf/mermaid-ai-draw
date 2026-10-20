import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Diagram } from '../src/model.ts';
import { createConversas, type Motor, type Pedido, type Resposta } from './conversa.ts';
import type { MotorNome, Persona } from './personas.ts';

type Script = (p: Pedido) => Resposta | Promise<Resposta>;

/** Motor falso: grava os pedidos e responde com o roteiro (padrão: "<nome> fala <n>"). */
function falso(nome: MotorNome, script?: Script, ok = true) {
  const pedidos: Pedido[] = [];
  let ativos = 0;
  let pico = 0;
  const motor: Motor = {
    nome,
    disponivel: async () => ({ ok, detalhe: ok ? 'ok' : `${nome} fora do ar` }),
    async atender(p, delta) {
      if (!ok) throw new Error(`${nome} fora do ar`);
      pedidos.push(p);
      ativos++;
      pico = Math.max(pico, ativos);
      try {
        const r = script ? await script(p) : { texto: `${p.persona.nome} fala ${pedidos.filter((x) => x.persona.id === p.persona.id).length}` };
        delta(r.texto.slice(0, 3));
        return r;
      } finally {
        ativos--;
      }
    },
  };
  return { motor, pedidos, pico: () => pico };
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

function diagrama(nodes: [string, string][], edges: string): Diagram {
  return {
    nodes: nodes.map(([id, text], i) => ({ id, text, x: i * 200, y: 0 })),
    edges: edges
      ? edges.split(' ').map((e, i) => {
          const [from, to] = e.split('>');
          return { id: `e${i + 1}`, from, to, text: '' };
        })
      : [],
  };
}

let dir: string;
let eventos: any[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversa-'));
  eventos = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function montar(d: Diagram, personas: Record<string, Partial<Persona>>, motores: Partial<Record<MotorNome, Motor>>, limiteTurnos?: number) {
  const pessoa = (id: string, nome: string): Persona => ({
    id,
    nome,
    prompt: `Você é ${nome}.`,
    motor: 'mcp',
    modelo: 'claude-opus-5-5',
    esforco: 'medium',
    papel: 'debatedora',
    cor: '#123456',
    ferramentas: [],
    inicio: false,
    ...personas[id],
  });
  const todos = { mcp: falso('mcp').motor, ollama: falso('ollama').motor, api: falso('api').motor, ...motores };
  return createConversas({ dir, diagrama: 'teste', ler: () => d, persona: pessoa, motores: todos, emitir: (ev) => eventos.push(ev), limiteTurnos });
}

const falas = (c: { mensagens: { nome: string; tipo: string }[] }) => c.mensagens.filter((m) => m.tipo !== 'usuario').map((m) => `${m.nome}:${m.tipo}`);

describe('debate', () => {
  it('cada rodada segue as setas, e cada persona responde a quem aponta para ela', async () => {
    const mcp = falso('mcp');
    const d = diagrama([['n1', 'Otimista'], ['n2', 'Cética'], ['n3', 'Moderadora']], 'n1>n2 n2>n3 n3>n1');
    const conversas = montar(d, {}, { mcp: mcp.motor });
    const c = conversas.iniciar({ assunto: 'Vale abrir uma cafeteria?', modo: 'debate', rodadas: 2 });
    const fim = await conversas.esperar(c.id);

    expect(fim.status).toBe('terminada');
    expect(falas(fim)).toEqual(['Otimista:fala', 'Cética:fala', 'Moderadora:fala', 'Otimista:fala', 'Cética:fala', 'Moderadora:fala']);
    expect(fim.mensagens[0]).toMatchObject({ tipo: 'usuario', texto: 'Vale abrir uma cafeteria?' });
    // Quem a persona ouve: a Cética responde à Otimista; na 2ª rodada a Otimista responde à Moderadora.
    expect(mcp.pedidos[1]).toMatchObject({ tipo: 'fala', respondendoA: ['n1'] });
    expect(mcp.pedidos[3].respondendoA).toEqual(['n3']);
    expect(mcp.pedidos[0].respondendoA).toEqual([]);
    // O pedido leva o prompt da persona, o assunto e a transcrição com nomes.
    expect(mcp.pedidos[1].system).toContain('Você é Cética.');
    expect(mcp.pedidos[1].contexto).toContain('Vale abrir uma cafeteria?');
    expect(mcp.pedidos[1].contexto).toContain('Otimista: Otimista fala 1');
    expect(mcp.pedidos[1].contexto).toMatch(/responda.*Otimista/i);

    // Eventos para o navegador e a conversa salva em disco.
    const tipos = eventos.map((e) => e.type);
    expect(tipos[0]).toBe('chat.inicio');
    expect(tipos).toContain('chat.turno');
    expect(tipos).toContain('chat.delta');
    expect(tipos.filter((t) => t === 'chat.mensagem')).toHaveLength(7);
    expect(tipos.at(-1)).toBe('chat.fim');
    expect(eventos.find((e) => e.type === 'chat.turno' && e.persona === 'n2')).toMatchObject({ respondendoA: ['n1'], arestas: ['e1'] });
    const salva = JSON.parse(fs.readFileSync(path.join(dir, `${c.id}.json`), 'utf8'));
    expect(salva.mensagens).toHaveLength(7);
    expect(conversas.listar().map((x) => x.id)).toEqual([c.id]);
  });

  it('o bloco de início escolhe quem abre o debate num ciclo', async () => {
    const d = diagrama([['n1', 'Otimista'], ['n2', 'Cética'], ['n3', 'Moderadora']], 'n1>n2 n2>n3 n3>n1');
    const conversas = montar(d, { n3: { inicio: true } }, {});
    const fim = await conversas.esperar(conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 }).id);
    expect(falas(fim)).toEqual(['Moderadora:fala', 'Otimista:fala', 'Cética:fala']);
    expect(eventos[0]).toMatchObject({ type: 'chat.inicio', ordem: ['Moderadora', 'Otimista', 'Cética'] });
  });

  it('cada persona usa o próprio motor: MCP, Ollama e API na mesma conversa', async () => {
    const mcp = falso('mcp');
    const ollama = falso('ollama');
    const api = falso('api');
    const d = diagrama([['a', 'A'], ['b', 'B'], ['c', 'C']], 'a>b b>c');
    const conversas = montar(d, { a: { motor: 'ollama' }, b: { motor: 'api' }, c: { motor: 'mcp' } }, { mcp: mcp.motor, ollama: ollama.motor, api: api.motor });
    const fim = await conversas.esperar(conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 }).id);
    expect([ollama.pedidos.length, api.pedidos.length, mcp.pedidos.length]).toEqual([1, 1, 1]);
    expect(fim.mensagens.filter((m) => m.tipo === 'fala').map((m) => m.motor)).toEqual(['ollama', 'api', 'mcp']);
  });

  it('motor fora do ar: a fala vira um erro no chat e o debate continua', async () => {
    const d = diagrama([['a', 'A'], ['b', 'B']], 'a>b');
    const conversas = montar(d, { a: { motor: 'ollama' } }, { ollama: falso('ollama', undefined, false).motor });
    const fim = await conversas.esperar(conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 }).id);
    expect(falas(fim)).toEqual(['A:erro', 'B:fala']);
    expect(fim.mensagens[1].texto).toContain('ollama fora do ar');
  });

  it('o limite de turnos para uma conversa que não acabaria', async () => {
    const d = diagrama([['a', 'A'], ['b', 'B']], 'a>b b>a');
    const conversas = montar(d, {}, {}, 5);
    const fim = await conversas.esperar(conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 10 }).id);
    expect(fim.mensagens.filter((m) => m.tipo === 'fala')).toHaveLength(5);
    expect(fim.mensagens.at(-1)).toMatchObject({ tipo: 'sistema' });
    expect(fim.mensagens.at(-1)!.texto).toMatch(/limite de 5 turnos/);
  });
});

describe('resposta final', () => {
  it('depois das rodadas, a moderadora sintetiza', async () => {
    const mcp = falso('mcp', (p) => ({ texto: p.tipo === 'sintese' ? 'Resposta polida.' : `${p.persona.nome} opina` }));
    const d = diagrama([['n1', 'Otimista'], ['n2', 'Moderadora'], ['n3', 'Cética']], 'n1>n3 n3>n2');
    const conversas = montar(d, { n2: { papel: 'moderadora' } }, { mcp: mcp.motor });
    const fim = await conversas.esperar(conversas.iniciar({ assunto: 'x', modo: 'resposta', rodadas: 1 }).id);
    expect(falas(fim)).toEqual(['Otimista:fala', 'Cética:fala', 'Moderadora:fala', 'Moderadora:sintese']);
    expect(fim.mensagens.at(-1)!.texto).toBe('Resposta polida.');
    expect(mcp.pedidos.at(-1)!.contexto).toMatch(/síntese|sintetize/i);
    expect(fim.resposta).toBe('Resposta polida.');
  });

  it('sem moderadora, sintetiza a última a falar; e dá para pedir a síntese antes do fim', async () => {
    let liberar!: () => void;
    const segurar = new Promise<void>((r) => (liberar = r));
    const mcp = falso('mcp', async (p) => {
      if (p.persona.id === 'b' && p.tipo === 'fala') await segurar;
      return { texto: p.tipo === 'sintese' ? 'síntese de B' : 'opina' };
    });
    const d = diagrama([['a', 'A'], ['b', 'B']], 'a>b');
    const conversas = montar(d, {}, { mcp: mcp.motor });
    const c = conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 3 });
    await espera(20);
    conversas.sintetizar(c.id);
    liberar();
    const fim = await conversas.esperar(c.id);
    // A rodada em andamento termina na fala de B, sem as rodadas 2 e 3, e B sintetiza.
    expect(falas(fim)).toEqual(['A:fala', 'B:fala', 'B:sintese']);
  });
});

describe('intervenções e parar', () => {
  it('o usuário intervém com @persona: ela fala a seguir, respondendo a ele', async () => {
    let liberar!: () => void;
    const segurar = new Promise<void>((r) => (liberar = r));
    const mcp = falso('mcp', async (p) => {
      if (p.persona.id === 'a' && p.tipo === 'fala' && !p.contexto.includes('custos')) await segurar;
      return { texto: `${p.persona.nome} ok` };
    });
    const d = diagrama([['a', 'A'], ['b', 'Bela'], ['c', 'C']], 'a>b b>c');
    const conversas = montar(d, {}, { mcp: mcp.motor });
    const c = conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 });
    await espera(10);
    conversas.intervir(c.id, '@C, e os custos?');
    liberar();
    const fim = await conversas.esperar(c.id);
    expect(falas(fim)).toEqual(['A:fala', 'C:fala', 'Bela:fala', 'C:fala']);
    const pedidoC = mcp.pedidos.find((p) => p.persona.id === 'c')!;
    expect(pedidoC.respondendoA).toEqual(['usuario']);
    expect(pedidoC.contexto).toContain('e os custos?');
  });

  it('depois do fim, uma intervenção é respondida (pela mencionada ou pela moderadora)', async () => {
    const d = diagrama([['a', 'A'], ['m', 'M']], 'a>m');
    const conversas = montar(d, { m: { papel: 'moderadora' } }, {});
    const c = conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 });
    await conversas.esperar(c.id);
    conversas.intervir(c.id, 'pode resumir?');
    const fim = await conversas.esperar(c.id);
    expect(falas(fim)).toEqual(['A:fala', 'M:fala', 'M:fala']);
    expect(fim.status).toBe('terminada');
  });

  it('uma @menção feita durante a síntese é atendida depois dela (não se perde)', async () => {
    let liberar!: () => void;
    const segurar = new Promise<void>((r) => (liberar = r));
    const mcp = falso('mcp', async (p) => {
      if (p.tipo === 'sintese') await segurar;
      return { texto: `${p.persona.nome} ${p.tipo}` };
    });
    const d = diagrama([['a', 'A'], ['m', 'M']], 'a>m');
    const conversas = montar(d, { m: { papel: 'moderadora' } }, { mcp: mcp.motor });
    const c = conversas.iniciar({ assunto: 'x', modo: 'resposta', rodadas: 1 });
    await espera(20);
    conversas.intervir(c.id, '@A e o aluguel?');
    liberar();
    const fim = await conversas.esperar(c.id);
    expect(falas(fim)).toEqual(['A:fala', 'M:fala', 'M:sintese', 'A:fala']);
    expect(mcp.pedidos.at(-1)!.respondendoA).toEqual(['usuario']);
  });

  it('a conversa em andamento informa os turnos pendentes (para quem abre a página no meio)', async () => {
    const mcp = falso('mcp', () => new Promise(() => {}));
    const d = diagrama([['a', 'A']], '');
    const conversas = montar(d, { a: { motor: 'mcp' } }, { mcp: mcp.motor });
    const c = conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 });
    await espera(10);
    expect(conversas.obter(c.id).pendentes).toEqual([expect.objectContaining({ persona: 'a', nome: 'A', tipo: 'fala', motor: 'mcp', turno: expect.any(String) })]);
    conversas.parar(c.id);
    await conversas.esperar(c.id);
    expect(conversas.obter(c.id).pendentes).toEqual([]);
  });

  it('parar cancela o turno pendente e encerra', async () => {
    const mcp = falso('mcp', (p) => new Promise((_resolve, reject) => p.signal.addEventListener('abort', () => reject(new Error('cancelado')))));
    const d = diagrama([['a', 'A'], ['b', 'B']], 'a>b');
    const conversas = montar(d, {}, { mcp: mcp.motor });
    const c = conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 });
    await espera(10);
    conversas.parar(c.id);
    const fim = await conversas.esperar(c.id);
    expect(fim.status).toBe('parada');
    expect(falas(fim)).toEqual(['Conversa:sistema']);
    expect(mcp.pedidos[0].signal.aborted).toBe(true);
  });
});

describe('tarefa com vários agentes', () => {
  it('a orquestradora delega pelas setas, as delegadas trabalham em paralelo e ela consolida', async () => {
    const api = falso('api', async (p) => {
      if (p.tipo === 'tarefa') return { texto: 'Plano:\nDELEGAR Pesquisadora: levante dados\nDELEGAR Redatora: escreva o texto\nDELEGAR Revisora: revise' };
      if (p.tipo === 'consolidar') return { texto: 'Entrega final consolidada.' };
      await espera(30);
      return { texto: `${p.persona.nome} entregou` };
    });
    const ollama = falso('ollama', async () => {
      await espera(30);
      return { texto: 'Redatora entregou' };
    });
    // A orquestradora só alcança Pesquisadora e Redatora; a Revisora está ligada à Redatora.
    const d = diagrama([['o', 'Orquestradora'], ['p', 'Pesquisadora'], ['r', 'Redatora'], ['v', 'Revisora']], 'o>p o>r r>v');
    const conversas = montar(d, { o: { papel: 'orquestradora', motor: 'api' }, p: { motor: 'api' }, r: { motor: 'ollama' }, v: { motor: 'api' } }, { api: api.motor, ollama: ollama.motor });
    const t0 = Date.now();
    const fim = await conversas.esperar(conversas.iniciar({ assunto: 'Lançar o produto', modo: 'tarefa' }).id);

    expect(api.pedidos[0]).toMatchObject({ tipo: 'tarefa' });
    expect(api.pedidos[0].delegaveis.map((x) => x.nome)).toEqual(['Pesquisadora', 'Redatora']);
    const tarefas = fim.mensagens.filter((m) => m.tipo === 'resultado');
    expect(tarefas.map((m) => m.nome).sort()).toEqual(['Pesquisadora', 'Redatora']);
    expect(tarefas.every((m) => m.pai === fim.mensagens.find((x) => x.tipo === 'tarefa')!.id)).toBe(true);
    // Em paralelo: as duas levaram ~30 ms juntas, não 60.
    expect(Date.now() - t0).toBeLessThan(55);
    // A Revisora não estava ao alcance: a recusa aparece, sem rodar.
    expect(fim.mensagens.some((m) => m.tipo === 'sistema' && m.texto.includes('Revisora'))).toBe(true);
    // A consolidação recebe os resultados.
    const consolidar = api.pedidos.find((p) => p.tipo === 'consolidar')!;
    expect(consolidar.contexto).toContain('Pesquisadora entregou');
    expect(consolidar.contexto).toContain('Redatora entregou');
    expect(fim.mensagens.at(-1)).toMatchObject({ nome: 'Orquestradora', tipo: 'sintese', texto: 'Entrega final consolidada.' });
    expect(fim.resposta).toBe('Entrega final consolidada.');
    expect(eventos.filter((e) => e.type === 'chat.delegacao')).toHaveLength(2);
  });

  it('delegação em cadeia: a delegada também pode delegar pelas setas dela', async () => {
    const mcp = falso('mcp', (p) => {
      if (p.persona.id === 'o' && p.tipo === 'tarefa') return { texto: 'x', delegacoes: [{ para: 'r', tarefa: 'escreva' }] };
      if (p.persona.id === 'r' && p.tipo === 'tarefa') return { texto: 'DELEGAR Revisora: revise isto' };
      if (p.tipo === 'consolidar') return { texto: `${p.persona.nome} consolidou` };
      return { texto: `${p.persona.nome} fez` };
    });
    const d = diagrama([['o', 'Orquestradora'], ['r', 'Redatora'], ['v', 'Revisora']], 'o>r r>v');
    const conversas = montar(d, { o: { papel: 'orquestradora' } }, { mcp: mcp.motor });
    const fim = await conversas.esperar(conversas.iniciar({ assunto: 'x', modo: 'tarefa' }).id);
    expect(falas(fim)).toEqual(['Orquestradora:tarefa', 'Redatora:tarefa', 'Revisora:resultado', 'Redatora:resultado', 'Orquestradora:sintese']);
    expect(fim.mensagens.find((m) => m.nome === 'Redatora' && m.tipo === 'resultado')!.texto).toBe('Redatora consolidou');
  });
});
