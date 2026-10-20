import { describe, expect, it } from 'vitest';
import type { Diagram } from '../src/model.ts';
import { delegaveis, lerDelegacoes, mencionada, ordemDaRodada, predecessores, raizes } from './turnos.ts';

const d = (nodes: string, edges: string): Diagram => ({
  nodes: nodes.split(' ').map((id, i) => ({ id, text: id.toUpperCase(), x: i * 100, y: 0 })),
  edges: edges
    ? edges.split(' ').map((e, i) => {
        const [from, to] = e.split('>');
        return { id: `e${i + 1}`, from, to, text: '' };
      })
    : [],
});

describe('ordem dos turnos pelas setas', () => {
  it('cadeia: cada uma fala depois de quem aponta para ela', () => {
    const g = d('c a b', 'a>b b>c');
    expect(raizes(g)).toEqual(['a']);
    expect(ordemDaRodada(g)).toEqual(['a', 'b', 'c']);
    expect(predecessores(g, 'b')).toEqual(['a']);
    expect(predecessores(g, 'a')).toEqual([]);
  });

  it('ramos: em largura, na ordem das setas', () => {
    const g = d('a b c d', 'a>c a>b b>d c>d');
    expect(ordemDaRodada(g)).toEqual(['a', 'c', 'b', 'd']);
    expect(predecessores(g, 'd')).toEqual(['b', 'c']);
  });

  it('ciclo: sem raiz, começa pelo primeiro retângulo e cada uma fala uma vez', () => {
    const g = d('a b c', 'a>b b>c c>a');
    expect(raizes(g)).toEqual(['a']);
    expect(ordemDaRodada(g)).toEqual(['a', 'b', 'c']);
    expect(predecessores(g, 'a')).toEqual(['c']);
  });

  it('ciclo com entrada e retângulos soltos: todos falam', () => {
    const g = d('x a b solta', 'x>a a>b b>a a>a');
    expect(raizes(g)).toEqual(['x', 'solta']);
    expect(ordemDaRodada(g)).toEqual(['x', 'solta', 'a', 'b']);
    // A seta para si mesma não conta como quem ela ouve.
    expect(predecessores(g, 'a')).toEqual(['x', 'b']);
  });

  it('bloco de início: a rodada começa por quem foi marcado', () => {
    const ciclo = d('a b c', 'a>b b>c c>a');
    expect(ordemDaRodada(ciclo, ['b'])).toEqual(['b', 'c', 'a']);
    // Marcado no meio de uma cadeia: começa por ele, e quem ficou antes entra depois.
    const cadeia = d('a b c', 'a>b b>c');
    expect(ordemDaRodada(cadeia, ['b'])).toEqual(['b', 'c', 'a']);
    // Ids que não existem são ignorados; sem nenhum válido, vale a regra das raízes.
    expect(ordemDaRodada(cadeia, ['x'])).toEqual(['a', 'b', 'c']);
    expect(ordemDaRodada(cadeia, [])).toEqual(['a', 'b', 'c']);
  });

  it('delegáveis são os destinos das setas que saem', () => {
    const g = d('o p r v', 'o>p o>r r>v o>o');
    expect(delegaveis(g, 'o')).toEqual(['p', 'r']);
    expect(delegaveis(g, 'r')).toEqual(['v']);
    expect(delegaveis(g, 'v')).toEqual([]);
  });
});

const PESSOAS = [
  { id: 'n1', nome: 'Otimista' },
  { id: 'n2', nome: 'Cética' },
  { id: 'n3', nome: 'Moderadora Geral' },
];

describe('menções no chat', () => {
  it('acha @nome sem diferenciar acento e maiúsculas, e também @id', () => {
    expect(mencionada('@cetica, e os custos?', PESSOAS)).toBe('n2');
    expect(mencionada('o que acha, @Moderadora Geral?', PESSOAS)).toBe('n3');
    expect(mencionada('@n1 responda', PESSOAS)).toBe('n1');
    expect(mencionada('sem menção', PESSOAS)).toBeUndefined();
    expect(mencionada('@ninguem', PESSOAS)).toBeUndefined();
  });
});

describe('delegações por texto', () => {
  it('lê as linhas DELEGAR e recusa quem não está ao alcance das setas', () => {
    const texto = `Vou dividir assim.
DELEGAR Otimista: liste três oportunidades
delegar @cética: aponte os riscos
DELEGAR Moderadora Geral: resuma
DELEGAR Fulana: algo`;
    const permitidas = PESSOAS.slice(0, 2);
    const r = lerDelegacoes(texto, permitidas);
    expect(r.delegacoes).toEqual([
      { para: 'n1', tarefa: 'liste três oportunidades' },
      { para: 'n2', tarefa: 'aponte os riscos' },
    ]);
    expect(r.recusadas).toEqual(['Moderadora Geral', 'Fulana']);
    expect(r.resto).toBe('Vou dividir assim.');
  });
});
