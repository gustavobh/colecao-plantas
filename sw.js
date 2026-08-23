/* Service worker — o que faz o app abrir no meio do quintal sem sinal.
 *
 * Estratégia por tipo de pedido:
 *   navegação        -> cache primeiro, rede como reforço (abre instantâneo)
 *   arquivos do app  -> cache primeiro, atualiza em segundo plano
 *   APIs externas    -> só rede, nunca cache (identificação precisa ser fresca,
 *                       e resposta de API em cache confunde mais do que ajuda)
 */

const CACHE = 'colecao-plantas-v1';

const ARQUIVOS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/estilo.css',
  './js/app.js',
  './js/db.js',
  './js/ui.js',
  './js/api.js',
  './js/geo.js',
  './js/imagem.js',
  './js/cerrado.js',
  './js/backup.js',
  './js/identificacao.js',
  './js/views/colecao.js',
  './js/views/nova.js',
  './js/views/planta.js',
  './js/views/editar.js',
  './js/views/mapa.js',
  './js/views/ajustes.js',
  './icones/icone.svg',
  './icones/icone-180.png',
  './icones/icone-192.png',
  './icones/icone-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll aborta tudo se um arquivo faltar; adicionamos um a um para que
    // um ícone ausente não impeça o app inteiro de ficar offline.
    await Promise.all(ARQUIVOS.map((url) => cache.add(url).catch(() => null)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (ev) => {
  const pedido = ev.request;
  if (pedido.method !== 'GET') return;

  const url = new URL(pedido.url);
  if (url.origin !== self.location.origin) return;   // Pl@ntNet, GBIF, Wikipédia

  if (pedido.mode === 'navigate') {
    ev.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const guardado = await cache.match('./index.html');
      const rede = fetch(pedido)
        .then((r) => { if (r.ok) cache.put('./index.html', r.clone()); return r; })
        .catch(() => null);
      return guardado || (await rede) || new Response('Offline', { status: 503 });
    })());
    return;
  }

  ev.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const guardado = await cache.match(pedido);
    const rede = fetch(pedido)
      .then((r) => { if (r.ok) cache.put(pedido, r.clone()); return r; })
      .catch(() => null);
    return guardado || (await rede) || new Response('', { status: 504 });
  })());
});
