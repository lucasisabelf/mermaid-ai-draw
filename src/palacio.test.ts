import { describe, expect, it } from 'vitest';
import { editarItem, filtrar, itensDoPalacio, removerItem } from './palacio';

const MD = `# Memória

## Decisões
- Abrir no bairro (Moderadora · c-1)
- Espresso e coado (Otimista · c-2)

## Fatos
- Aluguel no centro: R$ 12 mil (superado) (Cética · c-1)
- Aluguel no bairro: R$ 6 mil
`;

describe('palácio da memória (painel)', () => {
  it('lê os itens com a sala, a origem (persona · conversa) e o status', () => {
    const itens = itensDoPalacio(MD);
    expect(itens).toHaveLength(4);
    expect(itens[0]).toEqual({ sala: 'Decisões', indice: 0, texto: 'Abrir no bairro (Moderadora · c-1)', persona: 'Moderadora', conversa: 'c-1', status: 'valido' });
    expect(itens[2]).toMatchObject({ sala: 'Fatos', persona: 'Cética', conversa: 'c-1', status: 'superado' });
    expect(itens[3]).toMatchObject({ persona: undefined, conversa: undefined, status: 'valido' });
  });

  it('filtra por busca (sem acento), persona e conversa', () => {
    const itens = itensDoPalacio(MD);
    expect(filtrar(itens, { busca: 'ALUGUEL' }).map((i) => i.indice)).toEqual([0, 1]);
    expect(filtrar(itens, { busca: 'cetica' })).toHaveLength(1);
    expect(filtrar(itens, { persona: 'Otimista' })).toHaveLength(1);
    expect(filtrar(itens, { conversa: 'c-1' })).toHaveLength(2);
  });

  it('edita e remove um item, mantendo o resto do .md igual', () => {
    const editado = editarItem(MD, 'Fatos', 1, 'Aluguel no bairro: R$ 7 mil (Cética · c-3)');
    expect(editado).toContain('- Aluguel no bairro: R$ 7 mil (Cética · c-3)');
    expect(editado).not.toContain('R$ 6 mil');
    expect(editado.split('\n').length).toBe(MD.split('\n').length);
    const removido = removerItem(MD, 'Decisões', 1);
    expect(removido).not.toContain('Espresso');
    expect(removido).toContain('Abrir no bairro');
    expect(removido.split('\n').length).toBe(MD.split('\n').length - 1);
  });
});
