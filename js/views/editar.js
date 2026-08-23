/* Edição manual da ficha.
 *
 * Existe porque a identificação automática erra e porque muita coisa que você
 * sabe nunca vai estar em API nenhuma: quem te deu a muda, que ela morre se
 * podar em julho, que o nome que a vizinhança usa não é o do livro.
 */

import * as bd from '../db.js';
import { h, limpar, definirTopo, avisar, carregando, vazio, nomeDeExibicao } from '../ui.js';
import { pareceCerrado } from '../cerrado.js';

const STATUS = [
  ['identificada', 'Identificada'],
  ['duvida', 'Em dúvida'],
  ['a_identificar', 'A identificar'],
];

const CERRADO = [
  ['', 'Não sei'],
  ['sim', 'Nativa do Cerrado'],
  ['nao', 'Exótica / de outro bioma'],
];

export default async function telaEditar(app, estado, { params, irPara }) {
  limpar(app).append(carregando());

  const planta = await bd.obterPlanta(params.id);
  if (!planta) {
    definirTopo({ titulo: 'Editar', voltar: '#/colecao' });
    limpar(app).append(vazio('🤔', 'Não achei essa planta', null));
    return;
  }

  definirTopo({ titulo: `Editar ${nomeDeExibicao(planta)}`, voltar: `#/planta/${planta.id}` });

  const zonasSalvas = await bd.lerConfig('zonas', []);
  const todas = await bd.listarPlantas();
  const zonas = [...new Set([...zonasSalvas, ...todas.map((p) => p.zona).filter(Boolean)])].sort();

  const campo = (props) => h('input', { type: 'text', ...props });

  const apelido = campo({ value: planta.apelido, placeholder: 'ipê do portão' });
  const especie = campo({
    value: planta.especie, autocapitalize: 'none', autocorrect: 'off', spellcheck: false,
  });
  const familia = campo({ value: planta.familia });
  const populares = campo({
    value: (planta.nomesPopulares || []).join(', '),
    placeholder: 'separados por vírgula',
  });
  const zona = campo({ value: planta.zona, list: 'lista-zonas-edicao' });
  const plantadaEm = h('input', { type: 'date', value: planta.plantadaEm || '' });
  const notas = h('textarea', null, planta.notas || '');

  const status = h('select', null, ...STATUS.map(([v, r]) =>
    h('option', { value: v, selected: planta.status === v }, r)));

  const valorCerrado = planta.cerrado === true ? 'sim' : planta.cerrado === false ? 'nao' : '';
  const cerrado = h('select', null, ...CERRADO.map(([v, r]) =>
    h('option', { value: v, selected: valorCerrado === v }, r)));

  const btnSalvar = h('button', { type: 'button', class: 'botao botao--bloco' }, 'Salvar alterações');

  btnSalvar.onclick = async () => {
    btnSalvar.disabled = true;
    try {
      Object.assign(planta, {
        apelido: apelido.value.trim(),
        especie: especie.value.trim(),
        familia: familia.value.trim(),
        nomesPopulares: populares.value.split(',').map((s) => s.trim()).filter(Boolean),
        zona: zona.value.trim(),
        plantadaEm: plantadaEm.value || '',
        notas: notas.value.trim(),
        status: status.value,
        // "Não sei" não zera o palpite: cai de volta na heurística de gênero.
        cerrado: cerrado.value === 'sim' ? true
          : cerrado.value === 'nao' ? false
            : pareceCerrado(especie.value.trim()),
      });
      await bd.salvarPlanta(planta);
      if (planta.zona && !zonas.includes(planta.zona)) {
        await bd.gravarConfig('zonas', [...zonas, planta.zona]);
      }
      avisar('Ficha atualizada.');
      irPara(`#/planta/${planta.id}`, { recarregar: true });
    } catch (e) {
      avisar(e.message || 'Não consegui salvar.', 'erro');
      btnSalvar.disabled = false;
    }
  };

  limpar(app).append(
    h('datalist', { id: 'lista-zonas-edicao' }, ...zonas.map((z) => h('option', { value: z }))),
    h('label', { class: 'campo' }, h('span', null, 'Como você chama'), apelido),
    h('label', { class: 'campo' }, h('span', null, 'Nome científico'), especie),
    h('label', { class: 'campo' }, h('span', null, 'Família'), familia),
    h('label', { class: 'campo' }, h('span', null, 'Nomes populares'), populares),
    h('label', { class: 'campo' }, h('span', null, 'Canteiro / área'), zona),
    h('label', { class: 'campo' }, h('span', null, 'Situação'), status),
    h('label', { class: 'campo' }, h('span', null, 'Origem'), cerrado),
    h('label', { class: 'campo' }, h('span', null, 'Plantada em'), plantadaEm),
    h('label', { class: 'campo' }, h('span', null, 'Notas'), notas),
    btnSalvar,
  );

  void estado;
}
