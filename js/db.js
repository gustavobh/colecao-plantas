/* Persistência local em IndexedDB.
 *
 * Tudo mora no aparelho: nenhuma foto ou coordenada sai do iPhone, exceto a
 * imagem que você mandar explicitamente para identificação. Como não há
 * servidor, o backup manual (ver js/backup.js) é a única rede de segurança —
 * a tela de Ajustes insiste nisso de propósito.
 */

const NOME_BD = 'colecao-plantas';
const VERSAO_BD = 1;

let conexao = null;

export function abrir() {
  if (conexao) return Promise.resolve(conexao);
  return new Promise((ok, erro) => {
    const req = indexedDB.open(NOME_BD, VERSAO_BD);
    req.onupgradeneeded = (ev) => {
      const bd = req.result;
      if (!bd.objectStoreNames.contains('plantas')) {
        const s = bd.createObjectStore('plantas', { keyPath: 'id' });
        s.createIndex('status', 'status');
        s.createIndex('zona', 'zona');
        s.createIndex('atualizadoEm', 'atualizadoEm');
      }
      if (!bd.objectStoreNames.contains('fotos')) {
        const s = bd.createObjectStore('fotos', { keyPath: 'id' });
        s.createIndex('plantaId', 'plantaId');
      }
      if (!bd.objectStoreNames.contains('config')) {
        bd.createObjectStore('config', { keyPath: 'chave' });
      }
      void ev;
    };
    req.onsuccess = () => {
      conexao = req.result;
      conexao.onclose = () => { conexao = null; };
      ok(conexao);
    };
    req.onerror = () => erro(req.error);
    req.onblocked = () => erro(new Error('Banco bloqueado por outra aba aberta.'));
  });
}

function pedido(req) {
  return new Promise((ok, erro) => {
    req.onsuccess = () => ok(req.result);
    req.onerror = () => erro(req.error);
  });
}

async function loja(nome, modo = 'readonly') {
  const bd = await abrir();
  return bd.transaction(nome, modo).objectStore(nome);
}

export function novoId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/* ------------------------------------------------------------- plantas --- */

/** Molde de uma planta nova. Campos vazios são preenchidos ao longo do tempo. */
export function plantaVazia() {
  const agora = new Date().toISOString();
  return {
    id: novoId(),
    apelido: '',            // como você chama ("ipê do portão")
    especie: '',            // nome científico aceito
    familia: '',
    nomesPopulares: [],
    status: 'a_identificar',// a_identificar | identificada | duvida
    zona: '',               // canteiro / área do terreno
    croqui: null,           // { x, y } em fração 0..1 sobre a planta baixa
    gps: null,              // { lat, lon, precisao, em }
    notas: '',
    plantadaEm: '',
    cerrado: null,          // true/false/null — heurística por gênero
    identificacao: null,    // resposta guardada do Pl@ntNet + reforço regional
    fontes: [],             // links consultados (Wikipédia, GBIF...)
    criadoEm: agora,
    atualizadoEm: agora,
  };
}

export async function salvarPlanta(planta) {
  planta.atualizadoEm = new Date().toISOString();
  const s = await loja('plantas', 'readwrite');
  await pedido(s.put(planta));
  return planta;
}

export async function obterPlanta(id) {
  const s = await loja('plantas');
  return pedido(s.get(id));
}

export async function listarPlantas() {
  const s = await loja('plantas');
  const todas = await pedido(s.getAll());
  return todas.sort((a, b) => (b.atualizadoEm || '').localeCompare(a.atualizadoEm || ''));
}

export async function apagarPlanta(id) {
  const fotos = await listarFotos(id);
  const bd = await abrir();
  const tx = bd.transaction(['plantas', 'fotos'], 'readwrite');
  tx.objectStore('plantas').delete(id);
  for (const f of fotos) tx.objectStore('fotos').delete(f.id);
  return new Promise((ok, erro) => {
    tx.oncomplete = ok;
    tx.onerror = () => erro(tx.error);
  });
}

/* --------------------------------------------------------------- fotos --- */

export async function salvarFoto({ plantaId, imagem, miniatura, orgao = 'auto', nota = '' }) {
  const foto = {
    id: novoId(),
    plantaId,
    imagem,        // Blob JPEG reduzido (lado maior ~1600px)
    miniatura,     // Blob JPEG ~320px, usado nas listagens
    orgao,         // folha | flor | fruto | casca | habito | auto
    nota,
    criadoEm: new Date().toISOString(),
  };
  const s = await loja('fotos', 'readwrite');
  await pedido(s.put(foto));
  return foto;
}

export async function listarFotos(plantaId) {
  const s = await loja('fotos');
  const fotos = await pedido(s.index('plantaId').getAll(plantaId));
  return fotos.sort((a, b) => (a.criadoEm || '').localeCompare(b.criadoEm || ''));
}

export async function listarTodasFotos() {
  const s = await loja('fotos');
  return pedido(s.getAll());
}

export async function obterFoto(id) {
  const s = await loja('fotos');
  return pedido(s.get(id));
}

export async function apagarFoto(id) {
  const s = await loja('fotos', 'readwrite');
  return pedido(s.delete(id));
}

/** Primeira foto de cada planta, em um mapa id-da-planta -> miniatura. */
export async function capasPorPlanta() {
  const fotos = await listarTodasFotos();
  fotos.sort((a, b) => (a.criadoEm || '').localeCompare(b.criadoEm || ''));
  const capas = new Map();
  for (const f of fotos) {
    if (!capas.has(f.plantaId)) capas.set(f.plantaId, f.miniatura || f.imagem);
  }
  return capas;
}

/* -------------------------------------------------------------- config --- */

export async function lerConfig(chave, padrao = null) {
  const s = await loja('config');
  const reg = await pedido(s.get(chave));
  return reg === undefined ? padrao : reg.valor;
}

export async function gravarConfig(chave, valor) {
  const s = await loja('config', 'readwrite');
  await pedido(s.put({ chave, valor }));
  return valor;
}

export async function lerTodaConfig() {
  const s = await loja('config');
  const regs = await pedido(s.getAll());
  return Object.fromEntries(regs.map((r) => [r.chave, r.valor]));
}

export async function limparTudo() {
  const bd = await abrir();
  const tx = bd.transaction(['plantas', 'fotos', 'config'], 'readwrite');
  tx.objectStore('plantas').clear();
  tx.objectStore('fotos').clear();
  tx.objectStore('config').clear();
  return new Promise((ok, erro) => {
    tx.oncomplete = ok;
    tx.onerror = () => erro(tx.error);
  });
}
