/* Croqui do terreno.
 *
 * Por que não um mapa de verdade com as coordenadas do GPS: num lote de
 * 1000 m² (uns 30 x 33 m) o erro do GPS é da ordem do tamanho do canteiro.
 * Plotar as plantas por latitude/longitude daria uma nuvem embaralhada que não
 * ajuda ninguém a achar nada no quintal.
 *
 * O que funciona é o desenho: você sobe um print do seu lote (satélite do Google
 * Maps serve, ou uma foto de um croqui feito à mão) e toca onde cada planta
 * está. A posição fica guardada em fração da imagem (0 a 1), então continua
 * certa se você trocar o print depois ou abrir o app em outra tela.
 */

import * as bd from '../db.js';
import { prepararFoto, urlDe } from '../imagem.js';
import {
  h, limpar, definirTopo, avisar, carregando, confirmar,
  entradaDaGaleria, nomeDeExibicao,
} from '../ui.js';

export default async function telaMapa(app, estado, { params, irPara }) {
  const idParaPosicionar = params.id || null;

  limpar(app).append(carregando());

  const [plantas, fundo] = await Promise.all([
    bd.listarPlantas(),
    bd.lerConfig('croquiImagem', null),
  ]);

  const alvo = idParaPosicionar ? plantas.find((p) => p.id === idParaPosicionar) : null;

  definirTopo({
    titulo: alvo ? `Posicionar ${nomeDeExibicao(alvo)}` : 'Terreno',
    voltar: alvo ? `#/planta/${alvo.id}` : null,
  });

  /* ------------------------------------------------------------- croqui -- */

  const caixa = h('div', { class: 'croqui-caixa' });

  if (fundo) {
    caixa.append(h('img', { src: urlDe(fundo), alt: 'Croqui do terreno' }));
  } else {
    caixa.append(
      h('div', { style: { aspectRatio: '1 / 1' } }),
      h('div', { class: 'croqui-grade' }),
    );
  }

  function desenharPinos() {
    for (const antigo of caixa.querySelectorAll('.pino')) antigo.remove();
    const posicionadas = plantas.filter((p) => p.croqui);
    for (const p of posicionadas) {
      const ativo = alvo && p.id === alvo.id;
      caixa.append(h('button', {
        type: 'button',
        class: `pino${p.status !== 'identificada' ? ' pino--sem-nome' : ''}${ativo ? ' pino--ativo' : ''}`,
        style: { left: `${p.croqui.x * 100}%`, top: `${p.croqui.y * 100}%` },
        title: nomeDeExibicao(p),
        onclick: (e) => { e.stopPropagation(); irPara(`#/planta/${p.id}`); },
      }, h('span', null, (nomeDeExibicao(p)[0] || '?').toUpperCase())));
    }
  }

  if (alvo) {
    caixa.style.cursor = 'crosshair';
    caixa.addEventListener('click', async (ev) => {
      const r = caixa.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      alvo.croqui = { x: +x.toFixed(4), y: +y.toFixed(4) };
      await bd.salvarPlanta(alvo);
      avisar('Posição marcada no croqui.');
      irPara(`#/planta/${alvo.id}`);
    });
  }

  /* ------------------------------------------------------------- fundo --- */

  async function trocarFundo(arquivos) {
    try {
      const { imagem } = await prepararFoto(arquivos[0]);
      await bd.gravarConfig('croquiImagem', imagem);
      avisar('Croqui atualizado.');
      irPara('#/mapa', { recarregar: true });
    } catch (e) {
      avisar(e.message || 'Não consegui usar essa imagem.', 'erro');
    }
  }

  const trocarFundoBotao = entradaDaGaleria({
    rotulo: fundo ? 'Trocar a imagem do terreno' : 'Usar uma imagem do meu terreno',
    aoEscolher: trocarFundo,
    multiplo: false,
    classe: 'botao botao--claro botao--bloco',
  });

  /* -------------------------------------------------------- sem posição -- */

  const semPosicao = plantas.filter((p) => !p.croqui);

  const listaPendente = semPosicao.length
    ? h('section', { class: 'secao' },
      h('h2', null, `Ainda fora do croqui (${semPosicao.length})`),
      h('ul', { class: 'lista-simples' },
        ...semPosicao.slice(0, 40).map((p) => h('li', null,
          h('span', null, nomeDeExibicao(p)),
          h('a', { class: 'botao botao--claro botao--pequeno', href: `#/mapa/posicionar/${p.id}` }, 'Marcar'),
        ))))
    : null;

  /* ------------------------------------------------------------ montagem - */

  const instrucao = alvo
    ? h('p', { class: 'dica' }, 'Toque no ponto do terreno onde essa planta está.')
    : h('p', { class: 'dica' },
      fundo
        ? 'Toque em um pino para abrir a ficha. Verde = identificada, amarelo = ainda sem nome.'
        : 'Ainda sem imagem do terreno. Tire um print do seu lote no Google Maps (satélite) e envie abaixo — depois é só tocar para marcar cada planta.');

  limpar(app).append(
    instrucao,
    caixa,
    h('div', { style: { marginTop: '14px' } }, trocarFundoBotao),
    !alvo && fundo
      ? h('button', {
        type: 'button', class: 'botao botao--perigo botao--bloco', style: { marginTop: '8px' },
        onclick: async () => {
          if (!confirmar('Remover a imagem do terreno? Os pinos das plantas continuam salvos.')) return;
          await bd.gravarConfig('croquiImagem', null);
          irPara('#/mapa', { recarregar: true });
        },
      }, 'Remover a imagem')
      : null,
    alvo && alvo.croqui
      ? h('button', {
        type: 'button', class: 'botao botao--perigo botao--bloco', style: { marginTop: '8px' },
        onclick: async () => {
          alvo.croqui = null;
          await bd.salvarPlanta(alvo);
          avisar('Marcação removida.');
          irPara(`#/planta/${alvo.id}`);
        },
      }, 'Tirar do croqui')
      : null,
    listaPendente,
  );

  desenharPinos();
  void estado;
}
