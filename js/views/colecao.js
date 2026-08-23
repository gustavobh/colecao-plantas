/* Tela inicial: a coleção inteira, buscável.
 *
 * O problema declarado é "esqueço o que eu tenho". Então esta tela é uma grade
 * visual (foto manda mais que texto para lembrar de planta) com busca que casa
 * apelido, nome científico, nome popular, família, zona e notas — porque na
 * hora da dúvida você lembra de qualquer um desses, nunca do "certo".
 */

import * as bd from '../db.js';
import { h, limpar, definirTopo, vazio, carregando, nomeDeExibicao, normalizarTexto as normalizar } from '../ui.js';
import { urlDe } from '../imagem.js';

function combina(planta, termo) {
  if (!termo) return true;
  const alvo = normalizar([
    planta.apelido, planta.especie, planta.familia, planta.zona, planta.notas,
    (planta.nomesPopulares || []).join(' '),
  ].join(' '));
  return normalizar(termo).split(/\s+/).every((parte) => alvo.includes(parte));
}

export default async function telaColecao(app, estado) {
  definirTopo({ titulo: 'Coleção' });
  limpar(app).append(carregando('Abrindo a coleção…'));

  const [plantas, capas] = await Promise.all([bd.listarPlantas(), bd.capasPorPlanta()]);

  const zonas = [...new Set(plantas.map((p) => p.zona).filter(Boolean))].sort();
  const filtro = estado.filtroColecao || { chip: 'todas', termo: '' };
  estado.filtroColecao = filtro;

  const busca = h('input', {
    type: 'search',
    placeholder: 'Buscar por nome, família, canteiro…',
    value: filtro.termo,
    autocomplete: 'off',
    autocapitalize: 'none',
    oninput: (e) => { filtro.termo = e.target.value; desenharGrade(); },
  });

  const chips = [
    { id: 'todas', rotulo: `Todas (${plantas.length})` },
    { id: 'a_identificar', rotulo: `Sem nome (${plantas.filter((p) => p.status !== 'identificada').length})` },
    { id: 'cerrado', rotulo: `Cerrado (${plantas.filter((p) => p.cerrado === true).length})` },
    ...zonas.map((z) => ({ id: `zona:${z}`, rotulo: z })),
  ];

  const barraFiltros = h('div', { class: 'filtros' },
    ...chips.map((c) => h('button', {
      type: 'button',
      'aria-pressed': String(filtro.chip === c.id),
      onclick: () => {
        filtro.chip = filtro.chip === c.id && c.id !== 'todas' ? 'todas' : c.id;
        for (const b of barraFiltros.children) {
          b.setAttribute('aria-pressed', String(b.dataset.chip === filtro.chip));
        }
        desenharGrade();
      },
      dataset: { chip: c.id },
    }, c.rotulo)),
  );

  const grade = h('div');

  function aplicarChip(p) {
    if (filtro.chip === 'a_identificar') return p.status !== 'identificada';
    if (filtro.chip === 'cerrado') return p.cerrado === true;
    if (filtro.chip.startsWith('zona:')) return p.zona === filtro.chip.slice(5);
    return true;
  }

  function desenharGrade() {
    const lista = plantas.filter((p) => aplicarChip(p) && combina(p, filtro.termo));
    limpar(grade);

    if (!plantas.length) {
      grade.append(vazio('🌱', 'Sua coleção começa agora',
        'Fotografe a primeira planta do quintal. Se você não souber o nome dela, tudo bem — registre assim mesmo e identifique depois.',
        h('a', { class: 'botao', href: '#/nova' }, 'Registrar primeira planta')));
      return;
    }
    if (!lista.length) {
      grade.append(vazio('🔍', 'Nada encontrado', 'Tente outro termo ou tire o filtro.'));
      return;
    }

    grade.append(h('div', { class: 'grade' }, ...lista.map((p) => ficha(p, capas.get(p.id)))));
  }

  limpar(app).append(
    h('div', { class: 'barra-busca' }, busca),
    barraFiltros,
    grade,
  );
  desenharGrade();
}

function ficha(planta, capa) {
  const foto = capa
    ? h('img', { class: 'ficha-foto', src: urlDe(capa), alt: '', loading: 'lazy', decoding: 'async' })
    : h('div', { class: 'ficha-foto ficha-foto--vazia' }, '🌿');

  const semNome = planta.status !== 'identificada';

  return h('a', { class: 'ficha', href: `#/planta/${planta.id}` },
    foto,
    h('div', { class: 'ficha-corpo' },
      h('div', { class: 'ficha-nome' }, nomeDeExibicao(planta)),
      planta.especie
        ? h('div', { class: 'ficha-especie' }, planta.especie)
        : h('div', { class: 'ficha-especie' }, semNome ? 'a identificar' : ''),
      h('div', { class: 'ficha-zona' },
        [planta.zona, planta.cerrado === true ? '· Cerrado' : ''].filter(Boolean).join(' ')),
    ),
  );
}
