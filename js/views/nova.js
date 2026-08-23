/* Registrar uma planta.
 *
 * A ordem da tela é a ordem do que acontece no quintal: você está de pé na
 * frente da planta com o celular na mão. Primeiro a foto, que é o gesto que já
 * ia fazer. Depois onde ela está. A identificação vem depois disso, e é
 * opcional — dá para salvar sem nome nenhum, que é justamente o caso das
 * plantas que você não conhece.
 */

import * as bd from '../db.js';
import { prepararFoto, urlDe } from '../imagem.js';
import { posicaoAtual, formatarGps } from '../geo.js';
import { painelIdentificacao } from '../identificacao.js';
import { pareceCerrado } from '../cerrado.js';
import {
  h, limpar, definirTopo, avisar, entradaDeFoto, entradaDaGaleria,
  seletorDeOrgao, etiquetaCerrado,
} from '../ui.js';

export default async function telaNova(app, estado, { irPara }) {
  definirTopo({ titulo: 'Registrar planta', voltar: '#/colecao' });

  const chave = await bd.lerConfig('chavePlantnet', '');
  const zonasSalvas = await bd.lerConfig('zonas', []);
  const plantasExistentes = await bd.listarPlantas();
  const zonas = [...new Set([
    ...zonasSalvas,
    ...plantasExistentes.map((p) => p.zona).filter(Boolean),
  ])].sort();

  const rascunho = {
    fotos: [],        // { imagem, miniatura, orgao, url }
    gps: null,
    especieEscolhida: null,
  };

  /* ------------------------------------------------------------- fotos --- */

  const tiras = h('div', { class: 'galeria' });

  function desenharFotos() {
    limpar(tiras);
    for (const [i, f] of rascunho.fotos.entries()) {
      tiras.append(h('div', { style: { flex: 'none' } },
        h('img', { src: f.url, alt: `Foto ${i + 1}` }),
        h('div', { style: { marginTop: '6px', width: '150px' } },
          seletorDeOrgao(f.orgao, (v) => { f.orgao = v; })),
        h('button', {
          type: 'button', class: 'botao botao--perigo botao--pequeno',
          style: { marginTop: '4px', width: '100%' },
          onclick: () => { rascunho.fotos.splice(i, 1); desenharFotos(); },
        }, 'Remover'),
      ));
    }
    if (!rascunho.fotos.length) {
      tiras.append(h('p', { class: 'dica' },
        'Dica: uma foto da folha inteira contra um fundo liso identifica melhor que a planta toda de longe.'));
    }
  }

  async function receberArquivos(arquivos) {
    for (const arquivo of arquivos.slice(0, 5 - rascunho.fotos.length)) {
      try {
        const { imagem, miniatura } = await prepararFoto(arquivo);
        rascunho.fotos.push({ imagem, miniatura, orgao: 'auto', url: urlDe(imagem) });
      } catch (e) {
        avisar(e.message || 'Não consegui processar essa foto.', 'erro');
      }
    }
    desenharFotos();
    if (rascunho.fotos.length && !rascunho.gps) pegarGps({ silencioso: true });
  }

  /* --------------------------------------------------------------- gps --- */

  const gpsTexto = h('span', { class: 'dica' }, 'Localização ainda não marcada.');
  const btnGps = h('button', {
    type: 'button', class: 'botao botao--claro botao--pequeno',
    onclick: () => pegarGps({ silencioso: false }),
  }, 'Marcar aqui');

  async function pegarGps({ silencioso }) {
    btnGps.disabled = true;
    gpsTexto.textContent = 'Procurando satélites…';
    try {
      rascunho.gps = await posicaoAtual();
      gpsTexto.textContent = formatarGps(rascunho.gps);
    } catch (e) {
      rascunho.gps = null;
      gpsTexto.textContent = silencioso
        ? 'Sem localização — dá para salvar assim mesmo.'
        : e.message;
      if (!silencioso) avisar(e.message, 'erro');
    } finally {
      btnGps.disabled = false;
    }
  }

  /* ------------------------------------------------------------- ficha --- */

  const campoApelido = h('input', {
    type: 'text', placeholder: 'ex.: ipê do portão', autocapitalize: 'sentences',
  });
  const campoEspecie = h('input', {
    type: 'text', placeholder: 'preenchido pela identificação, ou digite',
    autocapitalize: 'none', autocorrect: 'off', spellcheck: false,
  });
  const campoFamilia = h('input', { type: 'text', placeholder: 'ex.: Bignoniaceae' });
  const campoZona = h('input', {
    type: 'text', list: 'lista-zonas', placeholder: 'ex.: canteiro da frente',
    autocapitalize: 'sentences',
  });
  const campoNotas = h('textarea', {
    placeholder: 'Onde conseguiu a muda, como ela se comporta na seca, quando floresce…',
  });
  const campoData = h('input', { type: 'date' });

  const resumoEspecie = h('div');

  function mostrarEscolha(escolha) {
    rascunho.especieEscolhida = escolha;
    campoEspecie.value = escolha.nome;
    campoFamilia.value = escolha.familia || '';

    limpar(resumoEspecie).append(
      h('div', { class: 'etiquetas', style: { margin: '8px 0' } },
        etiquetaCerrado(escolha.cerrado),
        escolha.origem ? h('span', { class: 'etq etq--neutra' }, escolha.origem) : null,
        ...(escolha.dominios || []).map((d) => h('span', { class: 'etq etq--neutra' }, d)),
      ),
      escolha.resumo ? h('p', { class: 'dica' }, escolha.resumo) : null,
    );
  }

  const painel = painelIdentificacao({
    obterFotos: () => rascunho.fotos.map((f) => ({ imagem: f.imagem, orgao: f.orgao })),
    obterGps: () => rascunho.gps,
    obterChave: () => chave,
    aoAceitar: mostrarEscolha,
  });

  /* ------------------------------------------------------------- salvar -- */

  const btnSalvar = h('button', { type: 'button', class: 'botao botao--bloco', onclick: salvar },
    'Salvar na coleção');

  async function salvar() {
    const especie = campoEspecie.value.trim();
    const apelido = campoApelido.value.trim();

    if (!especie && !apelido && !rascunho.fotos.length) {
      avisar('Coloque ao menos uma foto ou um apelido.', 'erro');
      return;
    }

    btnSalvar.disabled = true;
    try {
      const escolha = rascunho.especieEscolhida;
      const planta = bd.plantaVazia();
      Object.assign(planta, {
        apelido,
        especie,
        familia: campoFamilia.value.trim(),
        nomesPopulares: escolha?.populares || [],
        zona: campoZona.value.trim(),
        notas: campoNotas.value.trim(),
        plantadaEm: campoData.value || '',
        gps: rascunho.gps,
        status: especie ? 'identificada' : 'a_identificar',
        // Digitou o nome à mão? A heurística de gênero ainda vale — senão a
        // etiqueta de Cerrado só apareceria em quem passou pelo Pl@ntNet.
        cerrado: escolha?.cerrado ?? pareceCerrado(especie),
        fontes: escolha?.fontes || [],
        identificacao: escolha
          ? {
            fonte: 'plantnet',
            nome: escolha.nome,
            score: escolha.score,
            registrosPerto: escolha.registrosPerto,
            resumo: escolha.resumo,
            em: new Date().toISOString(),
          }
          : null,
      });

      await bd.salvarPlanta(planta);
      for (const f of rascunho.fotos) {
        await bd.salvarFoto({
          plantaId: planta.id, imagem: f.imagem, miniatura: f.miniatura, orgao: f.orgao,
        });
      }
      if (planta.zona && !zonas.includes(planta.zona)) {
        await bd.gravarConfig('zonas', [...zonas, planta.zona]);
      }

      avisar(especie ? 'Planta salva e identificada.' : 'Planta salva como "a identificar".');
      irPara(`#/planta/${planta.id}`);
    } catch (e) {
      avisar(e.message || 'Não consegui salvar.', 'erro');
      btnSalvar.disabled = false;
    }
  }

  /* ------------------------------------------------------------ montagem - */

  limpar(app).append(
    h('datalist', { id: 'lista-zonas' }, ...zonas.map((z) => h('option', { value: z }))),

    h('section', { class: 'secao' },
      h('h2', null, '1. Fotos'),
      tiras,
      h('div', { class: 'botoes' },
        entradaDeFoto({ aoEscolher: receberArquivos, classe: 'botao' }),
        entradaDaGaleria({ aoEscolher: receberArquivos, classe: 'botao botao--claro' }),
      ),
    ),

    h('section', { class: 'secao' },
      h('h2', null, '2. Onde ela está'),
      h('label', { class: 'campo' },
        h('span', null, 'Canteiro / área do terreno'),
        campoZona,
        h('div', { class: 'dica' },
          'O GPS erra uns 5 metros, então ele não separa um canteiro do outro. Quem faz isso é este campo — e o croqui, na aba Terreno.'),
      ),
      h('div', { class: 'lista-simples' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('div', { style: { flex: '1' } }, gpsTexto), btnGps)),
    ),

    h('section', { class: 'secao' },
      h('h2', null, '3. Identificação (opcional)'),
      painel.no,
      resumoEspecie,
      !chave ? h('p', { class: 'dica' },
        'Você ainda não cadastrou a chave do Pl@ntNet. Dá para salvar sem identificar e resolver isso depois, em Ajustes.') : null,
    ),

    h('section', { class: 'secao' },
      h('h2', null, '4. Ficha'),
      h('label', { class: 'campo' }, h('span', null, 'Como você chama'), campoApelido),
      h('label', { class: 'campo' }, h('span', null, 'Nome científico'), campoEspecie),
      h('label', { class: 'campo' }, h('span', null, 'Família'), campoFamilia),
      h('label', { class: 'campo' }, h('span', null, 'Plantada em'), campoData),
      h('label', { class: 'campo' }, h('span', null, 'Notas'), campoNotas),
    ),

    btnSalvar,
    h('p', { class: 'dica', style: { textAlign: 'center', marginTop: '10px' } },
      'Sem nome também vale: ela entra como "a identificar" e fica na fila para quando florescer.'),
  );

  desenharFotos();
}
