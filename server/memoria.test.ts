import { describe, expect, it } from 'vitest';
import { buscar, lerSalas, resumo } from './memoria.ts';

const MD = `# Memória

## Decisões
- Abrir no bairro residencial, não no centro (Moderadora · c1)
- Começar com café coado e espresso (Otimista · c1)

## Fatos
- Aluguel no centro é caro: R$ 12 mil (Cética · c1)

## Hipóteses
- Público do bairro valoriza café especial (Otimista · c1)

## Pendências
- Levantar o custo da máquina de espresso (Cética · c2)

## Preferências do usuário
`;

describe('memória: salas, resumo e busca', () => {
  it('lê as salas e os itens', () => {
    const salas = lerSalas(MD);
    expect(salas.map((s) => [s.titulo, s.itens.length])).toEqual([
      ['Decisões', 2],
      ['Fatos', 1],
      ['Hipóteses', 1],
      ['Pendências', 1],
      ['Preferências do usuário', 0],
    ]);
    expect(salas[1].itens[0]).toBe('Aluguel no centro é caro: R$ 12 mil (Cética · c1)');
    expect(lerSalas('')).toEqual([]);
  });

  it('resumo: só as salas pedidas, com limite de tamanho', () => {
    const r = resumo(MD, ['Decisões', 'Pendências'], 1000);
    expect(r).toContain('Decisões:');
    expect(r).toContain('- Abrir no bairro residencial');
    expect(r).toContain('Pendências:');
    expect(r).not.toContain('Aluguel');
    expect(resumo(MD, ['Decisões', 'Pendências'], 80).length).toBeLessThanOrEqual(80);
    expect(resumo('# Memória\n\n## Decisões\n', ['Decisões'], 500)).toBe('');
  });

  it('busca por palavras, sem diferenciar acento, os itens mais relevantes', () => {
    expect(buscar(MD, 'quanto custa o aluguel?', 3)).toEqual([{ sala: 'Fatos', texto: 'Aluguel no centro é caro: R$ 12 mil (Cética · c1)' }]);
    const maquina = buscar(MD, 'maquina de espresso', 2);
    expect(maquina[0]).toEqual({ sala: 'Pendências', texto: 'Levantar o custo da máquina de espresso (Cética · c2)' });
    expect(maquina).toHaveLength(2);
    expect(buscar(MD, 'xyz', 3)).toEqual([]);
  });
});
