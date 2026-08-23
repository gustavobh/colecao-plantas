/* Ficha de uma planta: o que você abre quando a dúvida bate.
 *
 * Duas coisas aqui não são enfeite:
 *   - a galeria aceita fotos novas a qualquer momento, então a mesma planta
 *     acumula folha, flor e fruto ao longo do ano. É isso que faz a segunda
 *     tentativa de identificação acertar quando a primeira falhou;
 *   - o painel de identificação aparece direto na ficha das pendentes, sem
 *     precisar recadastrar nada.
 */

import * as bd from '../db.js';
import { prepararFoto, urlDe } from '../imagem.js';
import { formatarGps, linkMapa, posicaoAtual } from '../geo.js';
import { painelIdentificacao } from '../identificacao.js';
import {
  h, limpar, definirTopo, avisar, confirmar, carregando, vazio,
  entradaDeFoto, entradaDaGaleria, etiquetaStatus, etiquetaCerrado,
  nomeDeExibicao, dataCurta, tempoRelativo, rotuloOrgao,
} from '../ui.js';

export default async function telaPlanta(app, estado, { params, irPara }) {
  limpar(app).append(carregando());

  const planta = await bd.obterPlanta(params.id);
  if (!planta) {
    definirTopo({ titulo: 'Planta', voltar: '#/colecao' });
    limpar(app).append(vazio('🤔', 'Não achei essa planta', 'Ela pode ter sido apagada.'));
    return;
  }

  definirTopo({
    titulo: nomeDeExibicao(planta),
    voltar: '#/colecao',
    acoes: [{ rotulo: 'Editar', aoClicar: () => irPara(`#/planta/${planta.id}/editar`) }],
  });

  const chave = await bd.lerConfig('chavePlantnet', '');
  let fotos = await bd.listarFotos(planta.id);

  /* ------------------------------------------------------------ galeria -- */

  const galeria = h('div', { class: 'galeria' });

  function desenharGaleria() {
    limpar(galeria);
    for (const f of fotos) {
      galeria.append(h('img', {
        src: urlDe(f.imagem),
        alt: rotuloOrgao(f.orgao),
        loading: 'lazy',
        onclick: () => {
          if (confirmar(`Apagar esta foto (${rotuloOrgao(f.orgao)})?`)) apagarFoto(f.id);
        },
      }));
    }
    galeria.append(h('button', {
      type: 'button', class: 'galeria-add',
      onclick: () => entradaCamera.querySelector('input').click(),
    }, '＋ foto'));
  }

  async function apagarFoto(id) {
    await bd.apagarFoto(id);
    fotos = await bd.listarFotos(planta.id);
    desenharGaleria();
    avisar('Foto apagada.');
  }

  async function receberArquivos(arquivos) {
    for (const arquivo of arquivos) {
      try {
        const { imagem, miniatura } = await prepararFoto(arquivo);
        await bd.salvarFoto({ plantaId: planta.id, imagem, miniatura });
      } catch (e) {
        avisar(e.message || 'Não consegui processar essa foto.', 'erro');
      }
    }
    fotos = await bd.listarFotos(planta.id);
    desenharGaleria();
    avisar('Foto adicionada à ficha.');
  }

  const entradaCamera = entradaDeFoto({ aoEscolher: receberArquivos, classe: 'botao' });
  const entradaGaleria = entradaDaGaleria({ aoEscolher: receberArquivos, classe: 'botao botao--claro' });

  /* -------------------------------------------------------- identificar -- */

  const areaIdentificacao = h('div');

  function montarIdentificacao() {
    limpar(areaIdentificacao);
    if (planta.status === 'identificada') return;

    const painel = painelIdentificacao({
      obterFotos: () => fotos.slice(0, 5).map((f) => ({ imagem: f.imagem, orgao: f.orgao })),
      obterGps: () => planta.gps,
      obterChave: () => chave,
      aoAceitar: async (escolha) => {
        planta.especie = escolha.nome;
        planta.familia = escolha.familia || planta.familia;
        planta.nomesPopulares = escolha.populares;
        planta.cerrado = escolha.cerrado;
        planta.status = 'identificada';
        planta.fontes = escolha.fontes;
        planta.identificacao = {
          fonte: 'plantnet',
          nome: escolha.nome,
          score: escolha.score,
          registrosPerto: escolha.registrosPerto,
          resumo: escolha.resumo,
          em: new Date().toISOString(),
        };
        await bd.salvarPlanta(planta);
        avisar('Identificação salva na ficha.');
        irPara(`#/planta/${planta.id}`, { recarregar: true });
      },
    });

    areaIdentificacao.append(
      h('section', { class: 'secao' },
        h('h2', null, 'Identificar'),
        fotos.length
          ? painel.no
          : h('p', { class: 'dica' }, 'Adicione uma foto acima para poder identificar.'),
        h('p', { class: 'dica' },
          'Se já tentou e não deu, tente de novo na época da flor ou do fruto: é quando a identificação por imagem fica confiável.'),
      ),
    );
  }

  /* ------------------------------------------------------------- dados --- */

  const dados = h('dl', { class: 'dados' });

  function linha(rotulo, valor) {
    if (!valor) return;
    dados.append(h('dt', null, rotulo), h('dd', null, valor));
  }

  linha('Espécie', planta.especie ? h('span', { class: 'nome-cientifico' }, planta.especie) : null);
  linha('Família', planta.familia);
  linha('Nomes populares', (planta.nomesPopulares || []).join(', '));
  linha('Canteiro', planta.zona);
  linha('Plantada em', dataCurta(planta.plantadaEm));
  linha('Coordenada', planta.gps
    ? h('span', null, formatarGps(planta.gps), ' ',
      h('a', { href: linkMapa(planta.gps), target: '_blank', rel: 'noopener' }, 'abrir no mapa'))
    : null);
  linha('No croqui', planta.croqui
    ? h('a', { href: '#/mapa' }, 'marcada na planta baixa')
    : h('a', { href: `#/mapa/posicionar/${planta.id}` }, 'posicionar no terreno'));
  linha('Registrada', `${dataCurta(planta.criadoEm)} (${tempoRelativo(planta.criadoEm)})`);

  const btnGps = !planta.gps
    ? h('button', {
      type: 'button', class: 'botao botao--claro botao--pequeno',
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          planta.gps = await posicaoAtual();
          await bd.salvarPlanta(planta);
          avisar('Coordenada marcada.');
          irPara(`#/planta/${planta.id}`, { recarregar: true });
        } catch (err) {
          avisar(err.message, 'erro');
          e.target.disabled = false;
        }
      },
    }, 'Marcar a coordenada agora')
    : null;

  /* ------------------------------------------------------------ montagem - */

  const identificacao = planta.identificacao;

  limpar(app).append(
    galeria,
    h('div', { class: 'botoes', style: { marginBottom: '16px' } }, entradaCamera, entradaGaleria),

    h('h2', { style: { marginBottom: '4px' } }, nomeDeExibicao(planta)),
    h('div', { class: 'etiquetas', style: { marginBottom: '14px' } },
      etiquetaStatus(planta.status),
      etiquetaCerrado(planta.cerrado),
      planta.familia ? h('span', { class: 'etq etq--neutra' }, planta.familia) : null,
    ),

    h('div', { class: 'cartao' }, dados, btnGps),

    planta.notas
      ? h('section', { class: 'secao' }, h('h2', null, 'Notas'),
        h('div', { class: 'cartao' }, ...planta.notas.split('\n').map((l) => h('p', null, l))))
      : null,

    identificacao?.resumo
      ? h('section', { class: 'secao' }, h('h2', null, 'Sobre a espécie'),
        h('div', { class: 'cartao' }, h('p', null, identificacao.resumo)))
      : null,

    identificacao
      ? h('section', { class: 'secao' }, h('h2', null, 'Como foi identificada'),
        h('div', { class: 'cartao' },
          h('p', { class: 'dica', style: { margin: 0 } },
            `Pl@ntNet sugeriu ${identificacao.nome} com ${Math.round((identificacao.score || 0) * 100)}% de confiança`
            + (identificacao.registrosPerto
              ? `, e o GBIF tem ${identificacao.registrosPerto} registro(s) dessa espécie num raio de 150 km daqui.`
              : '.')
            + ` Confirmado por você em ${dataCurta(identificacao.em)}.`)))
      : null,

    areaIdentificacao,

    (planta.fontes || []).length
      ? h('section', { class: 'secao' }, h('h2', null, 'Consultar'),
        h('ul', { class: 'lista-simples' },
          ...planta.fontes.map((f) => h('li', null,
            h('a', { href: f.url, target: '_blank', rel: 'noopener' }, f.titulo)))))
      : null,

    h('div', { class: 'botoes', style: { marginTop: '24px' } },
      h('button', {
        type: 'button', class: 'botao botao--perigo',
        onclick: async () => {
          if (!confirmar(`Apagar "${nomeDeExibicao(planta)}" e todas as fotos dela? Não dá para desfazer.`)) return;
          await bd.apagarPlanta(planta.id);
          avisar('Planta apagada.');
          irPara('#/colecao');
        },
      }, 'Apagar planta'),
    ),
  );

  desenharGaleria();
  montarIdentificacao();
  void estado;
}
