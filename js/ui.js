/* Pequena camada de UI: criação de elementos, avisos e cabeçalho.
 *
 * Construímos o DOM por função em vez de innerHTML porque quase todo texto na
 * tela é digitado por você (apelidos, notas) ou vem de API externa. Assim não
 * existe caminho de injeção de HTML, e não precisamos lembrar de escapar nada.
 */

/**
 * h('div', {class: 'x', onclick: fn}, 'texto', outroNo)
 * Atributos especiais: class, dataset, html (só para conteúdo confiável),
 * on<evento> e qualquer propriedade direta do elemento.
 */
export function h(tag, props = null, ...filhos) {
  const no = document.createElement(tag);
  if (props) {
    for (const [chave, valor] of Object.entries(props)) {
      if (valor === null || valor === undefined || valor === false) continue;
      if (chave === 'class') no.className = valor;
      else if (chave === 'dataset') Object.assign(no.dataset, valor);
      else if (chave === 'style' && typeof valor === 'object') Object.assign(no.style, valor);
      else if (chave.startsWith('on') && typeof valor === 'function') {
        no.addEventListener(chave.slice(2).toLowerCase(), valor);
      } else if (chave in no && chave !== 'list' && chave !== 'form') {
        no[chave] = valor;
      } else {
        no.setAttribute(chave, valor === true ? '' : valor);
      }
    }
  }
  adicionar(no, filhos);
  return no;
}

function adicionar(pai, filhos) {
  for (const f of filhos) {
    if (f === null || f === undefined || f === false) continue;
    if (Array.isArray(f)) adicionar(pai, f);
    else pai.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
}

export function limpar(no) {
  while (no.firstChild) no.removeChild(no.firstChild);
  return no;
}

/* -------------------------------------------------------------- avisos --- */

let contadorAvisos = 0;

export function avisar(mensagem, tipo = 'ok', segundos = 3.6) {
  const caixa = document.getElementById('avisos');
  if (!caixa) return;
  const id = ++contadorAvisos;
  const no = h('div', { class: `aviso${tipo === 'erro' ? ' aviso--erro' : ''}`, dataset: { id } }, mensagem);
  caixa.append(no);
  setTimeout(() => no.remove(), segundos * 1000);
}

export function confirmar(pergunta) {
  return window.confirm(pergunta);
}

/* ------------------------------------------------------------ cabeçalho -- */

export function definirTopo({ titulo, voltar = null, acoes = [] }) {
  document.getElementById('topo-titulo').textContent = titulo;

  const btnVoltar = document.getElementById('btn-voltar');
  btnVoltar.hidden = !voltar;
  btnVoltar.onclick = voltar ? () => { location.hash = voltar; } : null;

  const caixa = limpar(document.getElementById('topo-acoes'));
  for (const a of acoes) {
    caixa.append(h('button', { type: 'button', onclick: a.aoClicar }, a.rotulo));
  }
}

/* --------------------------------------------------------------- textos -- */

export function carregando(texto = 'Carregando…') {
  return h('div', { class: 'carregando' }, h('span', { class: 'girando' }), texto);
}

export function vazio(icone, titulo, detalhe, acao = null) {
  return h('div', { class: 'vazio' },
    h('span', { class: 'vazio-icone' }, icone),
    h('h3', null, titulo),
    detalhe && h('p', null, detalhe),
    acao,
  );
}

/** Minúsculas e sem acento — usado por toda busca do app. */
export function normalizarTexto(t) {
  return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function dataCurta(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MESES[d.getMonth()]} ${d.getFullYear()}`;
}

export function tempoRelativo(iso) {
  if (!iso) return '';
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (dias <= 0) return 'hoje';
  if (dias === 1) return 'ontem';
  if (dias < 30) return `há ${dias} dias`;
  if (dias < 365) return `há ${Math.round(dias / 30)} meses`;
  return `há ${Math.floor(dias / 365)} ano(s)`;
}

/** Rótulo e cor da etiqueta de status. */
export function etiquetaStatus(status) {
  if (status === 'identificada') return h('span', { class: 'etq' }, 'identificada');
  if (status === 'duvida') return h('span', { class: 'etq etq--aviso' }, 'em dúvida');
  return h('span', { class: 'etq etq--aviso' }, 'a identificar');
}

export function etiquetaCerrado(cerrado) {
  if (cerrado === true) return h('span', { class: 'etq etq--cerrado' }, 'Cerrado');
  return null;
}

/** Nome que aparece na listagem: apelido, senão espécie, senão "sem nome". */
export function nomeDeExibicao(planta) {
  return planta.apelido?.trim()
    || planta.especie?.trim()
    || planta.nomesPopulares?.[0]
    || 'Planta sem nome';
}

/* ---------------------------------------------------- entrada de foto ---- */

const ORGAOS = [
  ['auto', 'Deixar o app decidir'],
  ['leaf', 'Folha'],
  ['flower', 'Flor'],
  ['fruit', 'Fruto'],
  ['bark', 'Casca / tronco'],
  ['habit', 'Planta inteira'],
];

export function seletorDeOrgao(valor = 'auto', aoMudar = null) {
  return h('select', { onchange: (e) => aoMudar?.(e.target.value) },
    ...ORGAOS.map(([v, rotulo]) => h('option', { value: v, selected: v === valor }, rotulo)));
}

export function rotuloOrgao(valor) {
  return (ORGAOS.find(([v]) => v === valor) || [null, 'Foto'])[1];
}

/**
 * Botão que abre a câmera do iPhone. Usamos <input capture> em vez de
 * getUserMedia: é o caminho que o Safari trata melhor dentro de um PWA
 * instalado, já entrega a foto com resolução cheia e não pede permissão
 * persistente de câmera.
 */
export function entradaDeFoto({ rotulo = 'Tirar foto', aoEscolher, multiplo = false, classe = 'botao botao--bloco' }) {
  const entrada = h('input', {
    type: 'file',
    accept: 'image/*',
    capture: 'environment',
    multiple: multiplo,
    class: 'oculto',
    onchange: (e) => {
      const arquivos = Array.from(e.target.files || []);
      e.target.value = '';           // permite escolher a mesma foto de novo
      if (arquivos.length) aoEscolher(arquivos);
    },
  });
  const botao = h('button', { type: 'button', class: classe, onclick: () => entrada.click() }, rotulo);
  return h('div', null, botao, entrada);
}

/**
 * Igual ao anterior, mas sem `capture`: abre a galeria/arquivos. O iOS mostra
 * as duas opções, e para plantas já fotografadas antes isso é o que serve.
 */
export function entradaDaGaleria({ rotulo = 'Escolher da galeria', aoEscolher, multiplo = true, classe = 'botao botao--claro botao--bloco' }) {
  const entrada = h('input', {
    type: 'file',
    accept: 'image/*',
    multiple: multiplo,
    class: 'oculto',
    onchange: (e) => {
      const arquivos = Array.from(e.target.files || []);
      e.target.value = '';
      if (arquivos.length) aoEscolher(arquivos);
    },
  });
  const botao = h('button', { type: 'button', class: classe, onclick: () => entrada.click() }, rotulo);
  return h('div', null, botao, entrada);
}
