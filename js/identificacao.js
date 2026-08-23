/* Painel de identificação — usado tanto ao registrar quanto depois, na ficha
 * de uma planta que ficou pendente.
 *
 * A tela nunca decide sozinha. Ela mostra os palpites com a nota do Pl@ntNet,
 * quantos registros daquela espécie existem perto do terreno e se o gênero é
 * de Cerrado; quem escolhe é você. Um app que grava "Prunus avium" sozinho num
 * jardim do Planalto Central estraga a coleção em silêncio, e você só descobre
 * meses depois.
 */

import { identificar, reforcarComRegiao, enriquecer, ErroIdentificacao } from './api.js';
import { h, limpar, avisar, carregando } from './ui.js';

function porcento(v) {
  return `${Math.round(v * 100)}%`;
}

function linhaRegional(c) {
  if (c.registrosPerto === null || c.registrosPerto === undefined) return null;
  if (c.registrosPerto === 0) {
    return h('span', { class: 'etq etq--neutra' }, 'sem registro por perto');
  }
  return h('span', { class: 'etq' }, `${c.registrosPerto} registro(s) num raio de 150 km`);
}

function cartaoCandidato(c, aoEscolher) {
  const populares = (c.populares || []).slice(0, 3).join(', ');
  return h('button', {
    type: 'button', class: 'candidato', onclick: () => aoEscolher(c),
  },
    h('div', { class: 'candidato-info' },
      h('div', { class: 'candidato-nome' }, c.nome),
      populares && h('div', { class: 'candidato-comum' }, populares),
      h('div', { class: 'candidato-comum' }, c.familia),
      h('div', { class: 'etiquetas', style: { marginTop: '6px' } },
        linhaRegional(c),
        c.cerrado === true ? h('span', { class: 'etq etq--cerrado' }, 'gênero do Cerrado') : null,
      ),
      h('div', { class: 'barra' }, h('i', { style: { width: porcento(Math.min(1, c.scoreFinal)) } })),
    ),
    h('div', { class: 'candidato-score' }, porcento(c.score)),
  );
}

/**
 * @param {object} conf
 * @param {() => {imagem: Blob, orgao: string}[]} conf.obterFotos
 * @param {() => object|null} conf.obterGps
 * @param {() => string} conf.obterChave
 * @param {(escolha: object) => void} conf.aoAceitar  recebe {nome, familia, populares, ...extras}
 */
export function painelIdentificacao({ obterFotos, obterGps, obterChave, aoAceitar }) {
  const resultados = h('div');
  const botao = h('button', {
    type: 'button', class: 'botao botao--bloco', onclick: () => executar(),
  }, 'Identificar pela foto');

  async function executar() {
    const fotos = obterFotos();
    if (!fotos.length) {
      avisar('Adicione pelo menos uma foto antes de identificar.', 'erro');
      return;
    }

    botao.disabled = true;
    limpar(resultados).append(carregando('Consultando o Pl@ntNet…'));

    try {
      const { candidatos, restantes } = await identificar(fotos, { chave: obterChave() });
      if (!candidatos.length) {
        limpar(resultados).append(
          h('p', { class: 'dica' }, 'Nenhum palpite veio. Tente uma foto de folha isolada, com fundo limpo.'),
        );
        return;
      }

      const gps = obterGps();
      let lista = candidatos;
      if (gps) {
        limpar(resultados).append(carregando('Cruzando com registros da região…'));
        lista = await reforcarComRegiao(candidatos, gps);
      }

      limpar(resultados).append(
        h('p', { class: 'dica' },
          gps
            ? 'Ordenado pela nota do Pl@ntNet ajustada pelos registros da sua região. A porcentagem à direita é a nota original.'
            : 'Sem localização: ordem pura do Pl@ntNet. Marque o GPS para filtrar por região.'),
        ...lista.slice(0, 6).map((c) => cartaoCandidato(c, escolher)),
        h('button', {
          type: 'button', class: 'botao botao--claro botao--bloco',
          onclick: () => {
            limpar(resultados).append(h('p', { class: 'dica' },
              'Sem problema. A planta fica marcada como "a identificar" e você tenta de novo quando ela florescer — é aí que a identificação acerta mais.'));
          },
        }, 'Nenhuma dessas'),
        restantes !== null
          ? h('p', { class: 'dica' }, `Restam ${restantes} identificações na sua cota do Pl@ntNet hoje.`)
          : null,
      );
    } catch (e) {
      const msg = e instanceof ErroIdentificacao ? e.message : 'Falha inesperada na identificação.';
      limpar(resultados).append(h('p', { class: 'dica' }, msg));
      avisar(msg, 'erro', 5);
    } finally {
      botao.disabled = false;
    }
  }

  async function escolher(candidato) {
    limpar(resultados).append(carregando('Buscando nome popular e origem…'));
    const extra = await enriquecer(candidato.nome).catch(() => null);

    const escolha = {
      nome: candidato.nome,
      familia: extra?.familia || candidato.familia,
      populares: [...new Set([...(extra?.populares || []), ...(candidato.populares || [])])],
      cerrado: extra?.cerrado ?? candidato.cerrado,
      origem: extra?.origem || '',
      dominios: extra?.dominios || [],
      resumo: extra?.resumo || '',
      fontes: extra?.fontes || [],
      registrosPerto: candidato.registrosPerto,
      score: candidato.score,
    };

    limpar(resultados).append(
      h('div', { class: 'cartao' },
        h('div', { class: 'candidato-nome' }, escolha.nome),
        escolha.populares.length ? h('div', { class: 'candidato-comum' }, escolha.populares.join(', ')) : null,
        h('p', { class: 'dica' }, 'Anotado. Confira o nome abaixo antes de salvar.'),
      ),
    );
    aoAceitar(escolha);
  }

  return { no: h('div', null, botao, resultados), executar };
}
