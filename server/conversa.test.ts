import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
/** Arquivos que as personas de saída gravaram. */
let gravadas: { conversa: string; arquivo: string; texto: string }[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversa-'));
  eventos = [];
  gravadas = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function montar(d: Diagram, personas: Record<string, Partial<Persona>>, motores: Partial<Record<MotorNome, Motor>>, limiteTurnos?: number, extra: Partial<Parameters<typeof createConversas>[0]> = {}) {
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
    saida: false,
    arquivo: 'saida.md',
    humana: false,
    aoVencer: 'seguir',
    memoria: false,
    escuta: 'todas',
    quando: 'rodada',
    limite: 4000,
    ...personas[id],
  });
  const todos = { mcp: falso('mcp').motor, ollama: falso('ollama').motor, api: falso('api').motor, ...motores };
  return createConversas({ dir, diagrama: 'teste', ler: () => d, persona: pessoa, motores: todos,
    emitir: (ev) => eventos.push(ev),
    limiteTurnos,
    template: (id) => `# Template de ${id}\n\n## Resumo\n`,
    gravarSaida: (conversa, arquivo, texto) => void gravadas.push({ conversa, arquivo, texto }),
    ...extra,
  });
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

describe('persona de saída', () => {
  const readme = { saida: true, arquivo: 'README.md' } as const;

  it('não fala nas rodadas: roda uma vez no fim, preenche o template e gera o arquivo', async () => {
    const mcp = falso('mcp', (p) => ({ texto: p.tipo === 'saida' ? '# README pronto\n\n## Resumo\nTudo certo.' : `${p.persona.nome} opina` }));
    const d = diagrama([['a', 'A'], ['b', 'B'], ['s', 'README']], 'a>b b>s s>a');
    const conversas = montar(d, { s: readme }, { mcp: mcp.motor });
    const c = conversas.iniciar({ assunto: 'Lançar o app', modo: 'debate', rodadas: 2 });
    const fim = await conversas.esperar(c.id);

    expect(falas(fim)).toEqual(['A:fala', 'B:fala', 'A:fala', 'B:fala', 'README:saida']);
    expect(eventos[0].ordem).toEqual(['A', 'B']);
    const pedido = mcp.pedidos.at(-1)!;
    expect(pedido.tipo).toBe('saida');
    expect(pedido.contexto).toContain('Lançar o app');
    expect(pedido.contexto).toContain('B: B opina');
    expect(pedido.contexto).toContain('# Template de s');
    expect(pedido.system).toMatch(/template/i);
    expect(fim.mensagens.at(-1)).toMatchObject({ tipo: 'saida', nome: 'README', persona: 's', arquivo: 'README.md', texto: '# README pronto\n\n## Resumo\nTudo certo.' });
    expect(gravadas).toEqual([{ conversa: c.id, arquivo: 'README.md', texto: '# README pronto\n\n## Resumo\nTudo certo.' }]);
    // Ninguém responde à saída: a seta s>a não faz A responder a ela.
    expect(mcp.pedidos.filter((p) => p.tipo === 'fala').every((p) => !p.respondendoA.includes('s'))).toBe(true);
  });

  it('no modo resposta, roda depois da síntese e recebe a resposta final', async () => {
    const mcp = falso('mcp', (p) => ({ texto: p.tipo === 'sintese' ? 'Resposta polida.' : p.tipo === 'saida' ? '# Doc' : 'opina' }));
    const d = diagrama([['a', 'A'], ['m', 'Moderadora'], ['s', 'Doc']], 'a>m m>s');
    const conversas = montar(d, { m: { papel: 'moderadora' }, s: { saida: true } }, { mcp: mcp.motor });
    const fim = await conversas.esperar(conversas.iniciar({ assunto: 'x', modo: 'resposta', rodadas: 1 }).id);
    expect(falas(fim)).toEqual(['A:fala', 'Moderadora:fala', 'Moderadora:sintese', 'Doc:saida']);
    expect(mcp.pedidos.at(-1)!.contexto).toContain('Resposta polida.');
    expect(fim.resposta).toBe('Resposta polida.');
    expect(gravadas[0].arquivo).toBe('saida.md');
  });

  it('na tarefa, não é delegável e roda depois da consolidação', async () => {
    const mcp = falso('mcp', (p) => {
      if (p.tipo === 'tarefa') return { texto: 'DELEGAR Pesquisadora: levante dados\nDELEGAR README: escreva' };
      if (p.tipo === 'consolidar') return { texto: 'Entrega consolidada.' };
      if (p.tipo === 'saida') return { texto: '```markdown\n# README\n\nEntrega consolidada.\n```' };
      return { texto: 'dados' };
    });
    const d = diagrama([['o', 'Orquestradora'], ['p', 'Pesquisadora'], ['s', 'README']], 'o>p o>s');
    const conversas = montar(d, { o: { papel: 'orquestradora' }, s: readme }, { mcp: mcp.motor });
    const fim = await conversas.esperar(conversas.iniciar({ assunto: 'Lançar o app', modo: 'tarefa' }).id);

    expect(mcp.pedidos[0].delegaveis.map((x) => x.nome)).toEqual(['Pesquisadora']);
    expect(fim.mensagens.some((m) => m.tipo === 'sistema' && m.texto.includes('README'))).toBe(true);
    expect(falas(fim).filter((f) => !f.endsWith(':sistema'))).toEqual(['Orquestradora:tarefa', 'Pesquisadora:resultado', 'Orquestradora:sintese', 'README:saida']);
    expect(mcp.pedidos.at(-1)!.contexto).toContain('Entrega consolidada.');
    // A cerca de código que o modelo às vezes põe em volta é tirada.
    expect(fim.mensagens.at(-1)!.texto).toBe('# README\n\nEntrega consolidada.');
    expect(fim.resposta).toBe('Entrega consolidada.');
  });

  it('parar antes do fim: a saída não roda', async () => {
    const mcp = falso('mcp', (p) => new Promise((_r, reject) => p.signal.addEventListener('abort', () => reject(new Error('cancelado')))));
    const d = diagrama([['a', 'A'], ['s', 'README']], 'a>s');
    const conversas = montar(d, { s: readme }, { mcp: mcp.motor });
    const c = conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 });
    await espera(10);
    conversas.parar(c.id);
    const fim = await conversas.esperar(c.id);
    expect(fim.status).toBe('parada');
    expect(mcp.pedidos.map((p) => p.tipo)).toEqual(['fala']);
    expect(gravadas).toEqual([]);
  });

  it('erro no motor da saída vira mensagem de erro e a conversa termina', async () => {
    const mcp = falso('mcp');
    const d = diagrama([['a', 'A'], ['s', 'README']], 'a>s');
    const conversas = montar(d, { s: { ...readme, motor: 'ollama' } }, { mcp: mcp.motor, ollama: falso('ollama', undefined, false).motor });
    const fim = await conversas.esperar(conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 }).id);
    expect(fim.status).toBe('terminada');
    expect(falas(fim)).toEqual(['A:fala', 'README:erro']);
    expect(gravadas).toEqual([]);
  });
});

/** Espera a conversa chegar no status (a vez humana pausa a execução). */
async function ate(conversas: ReturnType<typeof montar>, id: string, status: string) {
  for (let i = 0; i < 100 && conversas.obter(id).status !== status; i++) await espera(5);
  expect(conversas.obter(id).status).toBe(status);
}

describe('persona humana', () => {
  const voce = { humana: true } as const;

  it('a conversa pausa na vez dela, mostra o pedido e segue com a resposta', async () => {
    const mcp = falso('mcp');
    const d = diagrama([['a', 'A'], ['h', 'Você'], ['b', 'B']], 'a>h h>b');
    const conversas = montar(d, { h: voce }, { mcp: mcp.motor });
    const c = conversas.iniciar({ assunto: 'Lançar?', modo: 'debate', rodadas: 1 });
    await ate(conversas, c.id, 'aguardando');

    const parada = conversas.obter(c.id);
    expect(parada.espera).toMatchObject({ persona: 'h', nome: 'Você', tipo: 'fala' });
    expect(parada.espera!.contexto).toContain('A: A fala 1');
    expect(mcp.pedidos.map((p) => p.persona.id)).toEqual(['a']);
    expect(eventos.find((e) => e.type === 'chat.turno' && e.status === 'aguardando')).toMatchObject({ persona: 'h', espera: { nome: 'Você' } });

    conversas.responderHumano(c.id, { acao: 'aprovar', texto: 'pode seguir' });
    const fim = await conversas.esperar(c.id);
    expect(fim.status).toBe('terminada');
    expect(fim.espera).toBeUndefined();
    expect(falas(fim)).toEqual(['A:fala', 'Você:fala', 'B:fala']);
    expect(fim.mensagens[2]).toMatchObject({ persona: 'h', texto: 'Aprovado. pode seguir' });
    expect(fim.mensagens[2].motor).toBeUndefined();
    expect(mcp.pedidos.at(-1)!.contexto).toContain('Você: Aprovado. pode seguir');
    // Fora da vez dela, responder é um erro.
    expect(() => conversas.responderHumano(c.id, { acao: 'aprovar' })).toThrow(/não está esperando/);
  });

  it('pedir mudança: quem falou antes responde de novo ao pedido', async () => {
    const mcp = falso('mcp');
    const d = diagrama([['a', 'A'], ['h', 'Você']], 'a>h');
    const conversas = montar(d, { h: voce }, { mcp: mcp.motor });
    const c = conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 });
    await ate(conversas, c.id, 'aguardando');
    conversas.responderHumano(c.id, { acao: 'mudar', texto: 'mais curto' });
    const fim = await conversas.esperar(c.id);
    expect(falas(fim)).toEqual(['A:fala', 'Você:fala', 'A:fala']);
    expect(fim.mensagens[2].texto).toBe('Pedido de mudança: mais curto');
    expect(mcp.pedidos.at(-1)!.respondendoA).toEqual(['h']);
  });

  it('encerrar termina a conversa ali', async () => {
    const mcp = falso('mcp');
    const d = diagrama([['a', 'A'], ['h', 'Você'], ['b', 'B']], 'a>h h>b');
    const conversas = montar(d, { h: voce }, { mcp: mcp.motor });
    const c = conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 2 });
    await ate(conversas, c.id, 'aguardando');
    conversas.responderHumano(c.id, { acao: 'encerrar', texto: 'chega' });
    const fim = await conversas.esperar(c.id);
    expect(fim.status).toBe('terminada');
    expect(falas(fim)).toEqual(['A:fala', 'Você:fala', 'Conversa:sistema']);
    expect(mcp.pedidos.map((p) => p.persona.id)).toEqual(['a']);
  });

  it('na tarefa, a humana recebe a delegação e o resultado dela vai para a consolidação', async () => {
    const mcp = falso('mcp', (p) => {
      if (p.tipo === 'tarefa') return { texto: 'DELEGAR Você: aprove o orçamento' };
      if (p.tipo === 'consolidar') return { texto: `Consolidado com: ${p.contexto.includes('ok, até 5 mil') ? 'aprovação' : 'nada'}` };
      return { texto: 'x' };
    });
    const d = diagrama([['o', 'Orquestradora'], ['h', 'Você']], 'o>h');
    const conversas = montar(d, { o: { papel: 'orquestradora' }, h: voce }, { mcp: mcp.motor });
    const c = conversas.iniciar({ assunto: 'Comprar', modo: 'tarefa' });
    await ate(conversas, c.id, 'aguardando');
    expect(conversas.obter(c.id).espera).toMatchObject({ tipo: 'execucao' });
    expect(conversas.obter(c.id).espera!.contexto).toContain('aprove o orçamento');
    conversas.responderHumano(c.id, { acao: 'aprovar', texto: 'ok, até 5 mil' });
    const fim = await conversas.esperar(c.id);
    expect(fim.resposta).toBe('Consolidado com: aprovação');
  });

  it('prazo: sem resposta, segue sozinha ou encerra', async () => {
    const d = diagrama([['a', 'A'], ['h', 'Você'], ['b', 'B']], 'a>h h>b');
    const segue = montar(d, { h: { ...voce, prazo: 0.002 } }, {});
    const f1 = await segue.esperar(segue.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 }).id);
    expect(falas(f1)).toEqual(['A:fala', 'Você:fala', 'B:fala']);
    expect(f1.mensagens[2].texto).toMatch(/prazo/);

    const encerra = montar(d, { h: { ...voce, prazo: 0.002, aoVencer: 'encerrar' } }, {});
    const f2 = await encerra.esperar(encerra.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 }).id);
    expect(f2.status).toBe('terminada');
    expect(falas(f2)).toEqual(['A:fala', 'Conversa:sistema']);
  });

  it('parar enquanto espera encerra a conversa', async () => {
    const d = diagrama([['a', 'A'], ['h', 'Você']], 'a>h');
    const conversas = montar(d, { h: voce }, {});
    const c = conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 });
    await ate(conversas, c.id, 'aguardando');
    conversas.parar(c.id);
    const fim = await conversas.esperar(c.id);
    expect(fim.status).toBe('parada');
    expect(fim.espera).toBeUndefined();
  });

  it('depois de reiniciar o servidor, a espera continua e o debate retoma do próximo', async () => {
    const mcp = falso('mcp');
    const d = diagrama([['a', 'A'], ['h', 'Você'], ['b', 'B']], 'a>h h>b');
    const antes = montar(d, { h: voce }, { mcp: mcp.motor });
    const c = antes.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 });
    await ate(antes, c.id, 'aguardando');
    antes.fechar();

    // Outra instância lendo a mesma pasta (o servidor reiniciou).
    const depois = montar(d, { h: voce }, { mcp: mcp.motor });
    expect(depois.obter(c.id)).toMatchObject({ status: 'aguardando', espera: { persona: 'h' } });
    depois.responderHumano(c.id, { acao: 'aprovar', texto: 'voltei' });
    const fim = await depois.esperar(c.id);
    expect(fim.status).toBe('terminada');
    expect(falas(fim)).toEqual(['A:fala', 'Você:fala', 'B:fala']);
  });
});

describe('pós-fluxo', () => {
  const comDepois = { saida: true, arquivo: 'README.md', depois: { diagrama: 'plano', modo: 'tarefa' as const, rodadas: 1, prefixo: 'Use este README:' } };

  it('a persona de saída dispara outro diagrama com o .md gerado como assunto', async () => {
    const iniciarOutro = vi.fn(() => ({ id: 'c-outro' }));
    const mcp = falso('mcp', (p) => ({ texto: p.tipo === 'saida' ? '# README\n\nPronto.' : 'opina' }));
    const d = diagrama([['a', 'A'], ['s', 'README']], 'a>s');
    const conversas = montar(d, { s: comDepois }, { mcp: mcp.motor }, undefined, { iniciarOutro });
    const c = conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 });
    const fim = await conversas.esperar(c.id);

    expect(iniciarOutro).toHaveBeenCalledWith('plano', { assunto: 'Use este README:\n\n# README\n\nPronto.', modo: 'tarefa', rodadas: 1 }, { origem: { diagrama: 'teste', conversa: c.id }, profundidade: 1 });
    expect(fim.mensagens.at(-1)).toMatchObject({ tipo: 'sistema', link: { diagrama: 'plano', conversa: 'c-outro' } });
    expect(fim.mensagens.at(-1)!.texto).toMatch(/plano/);
  });

  it('a conversa disparada guarda e mostra de onde veio', async () => {
    const conversas = montar(diagrama([['a', 'A']], ''), {}, {});
    const c = conversas.iniciar({ assunto: 'continuação', modo: 'debate', rodadas: 1 }, { origem: { diagrama: 'discovery', conversa: 'c-1' }, profundidade: 2 });
    expect(c).toMatchObject({ origem: { diagrama: 'discovery', conversa: 'c-1' }, profundidade: 2 });
    const fim = await conversas.esperar(c.id);
    expect(fim.mensagens[1]).toMatchObject({ tipo: 'sistema', link: { diagrama: 'discovery', conversa: 'c-1' } });
  });

  it('limite de encadeamento, parar e diagrama inexistente', async () => {
    const d = diagrama([['a', 'A'], ['s', 'README']], 'a>s');
    // No limite (3 fluxos encadeados), não dispara mais.
    const iniciarOutro = vi.fn(() => ({ id: 'c-outro' }));
    const noLimite = montar(d, { s: comDepois }, {}, undefined, { iniciarOutro });
    const f1 = await noLimite.esperar(noLimite.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 }, { profundidade: 3 }).id);
    expect(iniciarOutro).not.toHaveBeenCalled();
    expect(f1.mensagens.at(-1)!.texto).toMatch(/limite/);

    // Parada antes do fim: nem a saída nem o pós-fluxo rodam.
    const lento = falso('mcp', (p) => new Promise((_r, reject) => p.signal.addEventListener('abort', () => reject(new Error('x')))));
    const parada = montar(d, { s: comDepois }, { mcp: lento.motor }, undefined, { iniciarOutro });
    const c = parada.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 });
    await espera(10);
    parada.parar(c.id);
    await parada.esperar(c.id);
    expect(iniciarOutro).not.toHaveBeenCalled();

    // O diagrama de destino não existe: erro no chat, sem derrubar a conversa.
    const quebra = montar(d, { s: comDepois }, {}, undefined, { iniciarOutro: () => { throw new Error('Diagrama "plano" não encontrado.'); } });
    const f3 = await quebra.esperar(quebra.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 }).id);
    expect(f3.status).toBe('terminada');
    expect(f3.mensagens.at(-1)).toMatchObject({ tipo: 'erro' });
    expect(f3.mensagens.at(-1)!.texto).toMatch(/não encontrado/);
  });
});

describe('persona de memória', () => {
  /** A memória do diagrama, como o diagrams.ts guarda (memoria.md). */
  function comMemoria(inicial = '') {
    const m = { md: inicial, gravacoes: [] as { md: string; conversa: string }[] };
    return {
      m,
      extra: {
        lerMemoria: () => m.md,
        gravarMemoria: (md: string, conversa: string) => {
          m.md = md;
          m.gravacoes.push({ md, conversa });
        },
      },
    };
  }
  const memo = (texto: (p: Pedido) => string) => falso('mcp', (p) => ({ texto: p.tipo === 'memoria' ? texto(p) : `${p.persona.nome} fala ${p.contexto.length}` }));

  it('escuta no fim de cada rodada só as falas novas, grava o .md e não fala nas rodadas', async () => {
    const mcp = memo(() => '## Decisões\n- abrir no bairro (A · c1)\n- validar custos (B · c1)');
    const { m, extra } = comMemoria();
    const d = diagrama([['a', 'A'], ['b', 'B'], ['m', 'Memória']], 'a>b');
    const conversas = montar(d, { m: { memoria: true } }, { mcp: mcp.motor }, undefined, extra);
    const c = conversas.iniciar({ assunto: 'Cafeteria?', modo: 'debate', rodadas: 2 });
    const fim = await conversas.esperar(c.id);

    expect(eventos[0].ordem).toEqual(['A', 'B']);
    expect(mcp.pedidos.map((p) => p.tipo)).toEqual(['fala', 'fala', 'memoria', 'fala', 'fala', 'memoria']);
    expect(falas(fim)).toEqual(['A:fala', 'B:fala', 'Memória:memoria', 'A:fala', 'B:fala', 'Memória:memoria']);
    expect(fim.mensagens.at(-1)!.texto).toBe('Memória atualizada: 2 itens.');
    const [m1, m2] = mcp.pedidos.filter((p) => p.tipo === 'memoria');
    // A primeira começa do modelo das salas e ouve o assunto e a 1ª rodada; a segunda, só a 2ª rodada.
    expect(m1.contexto).toContain('## Decisões');
    expect(m1.contexto).toContain('Usuário: Cafeteria?');
    expect(m2.contexto).toContain('abrir no bairro');
    expect(m2.contexto).not.toContain('Usuário: Cafeteria?');
    expect(m1.system).toMatch(/memória/i);
    expect(m.gravacoes).toHaveLength(2);
    expect(m.gravacoes[0].conversa).toBe(c.id);
    // As mensagens de memória ficam fora do que as outras personas leem.
    expect(mcp.pedidos[3].contexto).not.toContain('Memória atualizada');
  });

  it('escuta só as personas marcadas; com "fala", atualiza depois de cada uma', async () => {
    const mcp = memo(() => '- item');
    const { extra } = comMemoria();
    const d = diagrama([['a', 'A'], ['b', 'B'], ['m', 'Memória']], 'a>b');
    const conversas = montar(d, { m: { memoria: true, escuta: ['a'], quando: 'fala' } }, { mcp: mcp.motor }, undefined, extra);
    await conversas.esperar(conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 }).id);
    const memorias = mcp.pedidos.filter((p) => p.tipo === 'memoria');
    // Só depois da fala de A (B não é escutada, então a fala dele não gera atualização).
    expect(mcp.pedidos.map((p) => p.tipo)).toEqual(['fala', 'memoria', 'fala']);
    expect(memorias[0].contexto).toContain('A: A fala');
    expect(memorias[0].contexto).not.toContain('B: B fala');
  });

  it('a memória continua entre conversas do mesmo diagrama', async () => {
    const mcp = memo((p) => (p.contexto.includes('lembrança antiga') ? '- lembrança antiga\n- nova' : '- primeira'));
    const { m, extra } = comMemoria('## Fatos\n- lembrança antiga (A · c0)\n');
    const d = diagrama([['a', 'A'], ['m', 'Memória']], '');
    const conversas = montar(d, { m: { memoria: true } }, { mcp: mcp.motor }, undefined, extra);
    await conversas.esperar(conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 }).id);
    expect(m.md).toBe('- lembrança antiga\n- nova');
  });

  it('passou do tamanho-alvo: pede para compactar uma vez', async () => {
    const mcp = memo((p) => (p.contexto.includes('Compacte') ? '- curto' : `- ${'x'.repeat(200)}`));
    const { m, extra } = comMemoria();
    const d = diagrama([['a', 'A'], ['m', 'Memória']], '');
    const conversas = montar(d, { m: { memoria: true, limite: 100 } }, { mcp: mcp.motor }, undefined, extra);
    await conversas.esperar(conversas.iniciar({ assunto: 'x', modo: 'debate', rodadas: 1 }).id);
    expect(mcp.pedidos.filter((p) => p.tipo === 'memoria')).toHaveLength(2);
    expect(m.md).toBe('- curto');
  });

  it('na tarefa, não é delegável e atualiza no fim', async () => {
    const mcp = falso('mcp', (p) => {
      if (p.tipo === 'tarefa') return { texto: 'DELEGAR Pesquisadora: dados' };
      if (p.tipo === 'consolidar') return { texto: 'Entrega.' };
      if (p.tipo === 'memoria') return { texto: '- entrega feita' };
      return { texto: 'dados' };
    });
    const { m, extra } = comMemoria();
    const d = diagrama([['o', 'Orquestradora'], ['p', 'Pesquisadora'], ['m', 'Memória']], 'o>p o>m');
    const conversas = montar(d, { o: { papel: 'orquestradora' }, m: { memoria: true } }, { mcp: mcp.motor }, undefined, extra);
    await conversas.esperar(conversas.iniciar({ assunto: 'x', modo: 'tarefa' }).id);
    expect(mcp.pedidos[0].delegaveis.map((x) => x.nome)).toEqual(['Pesquisadora']);
    expect(mcp.pedidos.at(-1)!.tipo).toBe('memoria');
    expect(mcp.pedidos.at(-1)!.contexto).toContain('Orquestradora: Entrega.');
    expect(m.md).toBe('- entrega feita');
  });
});
