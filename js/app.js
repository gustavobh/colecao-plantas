/* Ponto de entrada: roteador por hash e ciclo de vida da tela.
 *
 * Hash em vez de History API porque o app é servido como arquivo estático
 * (GitHub Pages, Netlify, um Raspberry na sua casa) e hash nunca dá 404 ao
 * recarregar numa rota interna.
 */

import { soltarUrls } from './imagem.js';
import { h, limpar, avisar } from './ui.js';

import telaColecao from './views/colecao.js';
import telaNova from './views/nova.js';
import telaPlanta from './views/planta.js';
import telaEditar from './views/editar.js';
import telaMapa from './views/mapa.js';
import telaAjustes from './views/ajustes.js';

const ROTAS = [
  { padrao: /^\/colecao$/, tela: telaColecao, aba: 'colecao' },
  { padrao: /^\/nova$/, tela: telaNova, aba: 'nova' },
  { padrao: /^\/planta\/([^/]+)\/editar$/, tela: telaEditar, aba: 'colecao', chaves: ['id'] },
  { padrao: /^\/planta\/([^/]+)$/, tela: telaPlanta, aba: 'colecao', chaves: ['id'] },
  { padrao: /^\/mapa\/posicionar\/([^/]+)$/, tela: telaMapa, aba: 'mapa', chaves: ['id'] },
  { padrao: /^\/mapa$/, tela: telaMapa, aba: 'mapa' },
  { padrao: /^\/ajustes$/, tela: telaAjustes, aba: 'ajustes' },
];

/* Estado que sobrevive à troca de tela (filtros da busca, por exemplo).
 * Deliberadamente pequeno: o dado de verdade está sempre no IndexedDB. */
const estado = {};

const app = document.getElementById('app');
let renderizando = false;

function caminhoAtual() {
  const bruto = location.hash.replace(/^#/, '');
  return bruto && bruto !== '/' ? bruto : '/colecao';
}

function casar(caminho) {
  for (const rota of ROTAS) {
    const m = caminho.match(rota.padrao);
    if (!m) continue;
    const params = {};
    (rota.chaves || []).forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { rota, params };
  }
  return null;
}

function marcarAba(aba) {
  for (const link of document.querySelectorAll('#abas a')) {
    if (link.dataset.aba === aba) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function irPara(hash, { recarregar = false } = {}) {
  if (location.hash === hash) {
    if (recarregar) desenhar();
    return;
  }
  location.hash = hash;
  if (recarregar) {
    // O evento hashchange já vai disparar; nada a fazer.
  }
}

async function desenhar() {
  if (renderizando) return;
  renderizando = true;

  const caminho = caminhoAtual();
  const achado = casar(caminho);

  soltarUrls();          // libera as URLs de blob da tela anterior
  window.scrollTo(0, 0);

  try {
    if (!achado) {
      marcarAba(null);
      limpar(app).append(
        h('div', { class: 'vazio' },
          h('span', { class: 'vazio-icone' }, '🧭'),
          h('h3', null, 'Tela não encontrada'),
          h('a', { class: 'botao', href: '#/colecao' }, 'Voltar para a coleção')),
      );
      return;
    }
    marcarAba(achado.rota.aba);
    await achado.rota.tela(app, estado, { params: achado.params, irPara });
  } catch (e) {
    console.error(e);
    limpar(app).append(
      h('div', { class: 'vazio' },
        h('span', { class: 'vazio-icone' }, '😕'),
        h('h3', null, 'Algo quebrou nesta tela'),
        h('p', null, e?.message || 'Erro desconhecido.'),
        h('a', { class: 'botao', href: '#/colecao' }, 'Voltar para a coleção')),
    );
  } finally {
    renderizando = false;
  }
}

window.addEventListener('hashchange', desenhar);
window.addEventListener('DOMContentLoaded', desenhar);
if (document.readyState !== 'loading') desenhar();

/* Erros que escapam de um await solto não podem sumir em silêncio: num app
 * offline o usuário precisa saber que a ação não aconteceu. */
window.addEventListener('unhandledrejection', (ev) => {
  console.error(ev.reason);
  avisar(ev.reason?.message || 'Algo deu errado.', 'erro');
});

/* --------------------------------------------------------- offline ------ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW:', e));
  });
}
