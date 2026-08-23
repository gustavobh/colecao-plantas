/* Serviços externos usados na identificação.
 *
 * Regra de ouro deste arquivo: NADA aqui pode ser obrigatório. O app inteiro
 * funciona sem internet e sem chave de API — você cadastra a planta, marca como
 * "a identificar" e roda a identificação depois. Toda função abaixo falha em
 * silêncio devolvendo null/[] em vez de quebrar a tela.
 *
 * Quem faz o quê:
 *   Pl@ntNet          — palpites de espécie a partir da foto (exige chave grátis)
 *   GBIF              — quantos registros da espécie existem perto do terreno
 *   Flora e Funga BR  — origem (nativa/exótica) e domínio fitogeográfico
 *   Wikipédia (pt)    — nome popular e um resumo em português
 */

import { pesoRegional, pareceCerrado } from './cerrado.js';

const PLANTNET = 'https://my-api.plantnet.org/v2/identify';
const GBIF = 'https://api.gbif.org/v1';
const FLORA_BR = 'https://servicos.jbrj.gov.br/flora/taxon';
const WIKI = 'https://pt.wikipedia.org';

const RAIO_REGIONAL_KM = 150;

async function buscar(url, opcoes = {}, ms = 15000) {
  const cancelar = new AbortController();
  const relogio = setTimeout(() => cancelar.abort(), ms);
  try {
    return await fetch(url, { ...opcoes, signal: cancelar.signal });
  } finally {
    clearTimeout(relogio);
  }
}

/** Chamada auxiliar: erro de rede vira null em vez de exceção. */
async function json(url, ms = 12000) {
  try {
    const r = await buscar(url, { headers: { Accept: 'application/json' } }, ms);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ Pl@ntNet --- */

export class ErroIdentificacao extends Error {
  constructor(mensagem, codigo) {
    super(mensagem);
    this.codigo = codigo;
  }
}

/**
 * Manda de 1 a 5 fotos da MESMA planta e recebe os palpites.
 * @param {{imagem: Blob, orgao: string}[]} fotos
 * @param {{chave: string, projeto?: string}} conf
 */
export async function identificar(fotos, { chave, projeto = 'all' }) {
  if (!chave) {
    throw new ErroIdentificacao(
      'Cadastre sua chave do Pl@ntNet em Ajustes para identificar por foto.',
      'sem-chave',
    );
  }
  if (!fotos.length) throw new ErroIdentificacao('Escolha ao menos uma foto.', 'sem-foto');

  const corpo = new FormData();
  for (const f of fotos.slice(0, 5)) {
    corpo.append('images', f.imagem, 'planta.jpg');
    corpo.append('organs', f.orgao && f.orgao !== 'auto' ? f.orgao : 'auto');
  }

  const url = `${PLANTNET}/${encodeURIComponent(projeto)}`
    + `?api-key=${encodeURIComponent(chave)}&lang=pt&nb-results=8&include-related-images=false`;

  let resposta;
  try {
    resposta = await buscar(url, { method: 'POST', body: corpo }, 45000);
  } catch (e) {
    throw new ErroIdentificacao(
      e.name === 'AbortError'
        ? 'O Pl@ntNet demorou demais. Tente de novo com sinal melhor.'
        : 'Sem conexão com o Pl@ntNet. A foto ficou salva: identifique depois.',
      'rede',
    );
  }

  if (resposta.status === 401 || resposta.status === 403) {
    throw new ErroIdentificacao('Chave do Pl@ntNet recusada. Confira em Ajustes.', 'chave');
  }
  if (resposta.status === 404) {
    throw new ErroIdentificacao(
      'O Pl@ntNet não reconheceu nada nessa foto. Tente enquadrar só a folha ou a flor.',
      'sem-resultado',
    );
  }
  if (resposta.status === 429) {
    throw new ErroIdentificacao('Cota diária do Pl@ntNet esgotada. Tente amanhã.', 'cota');
  }
  if (!resposta.ok) {
    throw new ErroIdentificacao(`Pl@ntNet respondeu ${resposta.status}.`, 'http');
  }

  const dados = await resposta.json();
  return {
    restantes: dados.remainingIdentificationRequests ?? null,
    candidatos: (dados.results || []).map((r) => ({
      nome: r.species?.scientificNameWithoutAuthor || '',
      autor: r.species?.scientificNameAuthorship || '',
      familia: r.species?.family?.scientificNameWithoutAuthor || '',
      genero: r.species?.genus?.scientificNameWithoutAuthor || '',
      populares: r.species?.commonNames || [],
      score: r.score || 0,
      gbifId: r.gbif?.id ? String(r.gbif.id) : null,
      registrosPerto: null,   // preenchido por reforcarComRegiao()
      scoreFinal: r.score || 0,
      cerrado: pareceCerrado(r.species?.scientificNameWithoutAuthor || ''),
    })).filter((c) => c.nome),
  };
}

/* ---------------------------------------------------------------- GBIF --- */

async function chaveGbif(nome, idConhecido) {
  if (idConhecido) return idConhecido;
  const d = await json(`${GBIF}/species/match?name=${encodeURIComponent(nome)}`, 8000);
  return d && d.usageKey ? String(d.usageKey) : null;
}

/** Quantos registros dessa espécie existem num raio do terreno. */
async function registrosPerto(taxonKey, { lat, lon }) {
  if (!taxonKey) return null;
  const url = `${GBIF}/occurrence/search?taxonKey=${encodeURIComponent(taxonKey)}`
    + `&geoDistance=${lat},${lon},${RAIO_REGIONAL_KM}km&limit=0`;
  const d = await json(url, 8000);
  return d && typeof d.count === 'number' ? d.count : null;
}

/**
 * O diferencial pedido: cruzar foto com geolocalização.
 *
 * O Pl@ntNet é treinado no mundo todo e adora sugerir uma congênere europeia
 * ou asiática parecida. Se a espécie tem centenas de registros num raio de
 * 150 km daqui e a outra não tem nenhum, isso é informação forte. Não
 * sobrescrevemos o palpite dele — reordenamos com um peso suave e mostramos o
 * número na tela, para a decisão continuar sendo sua.
 */
export async function reforcarComRegiao(candidatos, gps) {
  if (!gps || !candidatos.length) return candidatos;

  await Promise.all(candidatos.slice(0, 6).map(async (c) => {
    try {
      const chave = await chaveGbif(c.nome, c.gbifId);
      c.gbifId = chave;
      c.registrosPerto = await registrosPerto(chave, gps);
    } catch { /* offline ou GBIF fora do ar: segue sem o reforço */ }
  }));

  for (const c of candidatos) {
    const n = c.registrosPerto;
    // 0 registros não penaliza (pode ser só falta de coleta na região);
    // muitos registros dão até +40%. Escala log para não explodir.
    const bonus = n && n > 0 ? 1 + 0.4 * Math.min(1, Math.log10(1 + n) / 2.5) : 1;
    c.scoreFinal = c.score * bonus * pesoRegional(c.nome);
  }
  return candidatos.slice().sort((a, b) => b.scoreFinal - a.scoreFinal);
}

/* -------------------------------------------------- Flora e Funga do BR --- */

/**
 * Confirma se a espécie é nativa e em que domínio ela ocorre. É a fonte
 * brasileira oficial; quando responde, vale mais que a heurística de gênero.
 * Pode não responder (o serviço nem sempre libera CORS) — daí voltamos a null.
 */
export async function floraDoBrasil(nomeCientifico) {
  if (!nomeCientifico) return null;
  const d = await json(`${FLORA_BR}/${encodeURIComponent(nomeCientifico)}`, 9000);
  const item = d && Array.isArray(d.result) ? d.result[0] : null;
  if (!item) return null;

  const dist = item.distribution || {};
  const dominios = []
    .concat(dist.phytogeographicDomain || dist.phytogeographicDomains || [])
    .map(String);
  const populares = (item.vernacularname || item.vernacularNames || [])
    .map((v) => (typeof v === 'string' ? v : v.vernacularname || v.name))
    .filter(Boolean);

  return {
    nomeAceito: item.scientificname || item.scientificName || nomeCientifico,
    familia: item.family || '',
    origem: item.origin || dist.origin || '',       // Nativa | Naturalizada | Cultivada
    endemismo: item.endemism || dist.endemism || '',
    dominios,
    populares,
    cerrado: dominios.some((d2) => /cerrado/i.test(d2)) || null,
  };
}

/* ----------------------------------------------------------- Wikipédia --- */

/** Resumo em português para lembrar do que se trata na hora da consulta. */
export async function resumoWikipedia(nomeCientifico) {
  if (!nomeCientifico) return null;
  const busca = await json(
    `${WIKI}/w/api.php?action=query&list=search&srlimit=1&format=json&origin=*`
    + `&srsearch=${encodeURIComponent(nomeCientifico)}`,
    9000,
  );
  const titulo = busca?.query?.search?.[0]?.title;
  if (!titulo) return null;

  const resumo = await json(
    `${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(titulo)}`,
    9000,
  );
  if (!resumo || resumo.type === 'disambiguation') return null;

  return {
    titulo: resumo.title,
    texto: resumo.extract || '',
    link: resumo.content_urls?.desktop?.page || `${WIKI}/wiki/${encodeURIComponent(titulo)}`,
  };
}

/* ------------------------------------------------------------ conjunto --- */

/**
 * Depois que você aceita um candidato, junta tudo que dá para saber sobre ele.
 * Cada pedaço é opcional: o que não vier fica de fora sem travar nada.
 */
export async function enriquecer(nomeCientifico) {
  const [flora, wiki] = await Promise.all([
    floraDoBrasil(nomeCientifico).catch(() => null),
    resumoWikipedia(nomeCientifico).catch(() => null),
  ]);

  const populares = [];
  for (const n of [...(flora?.populares || []), ...(wiki ? [wiki.titulo] : [])]) {
    const limpo = String(n).trim();
    if (limpo && !/^[A-Z][a-z]+ [a-z-]+$/.test(limpo) && !populares.includes(limpo)) {
      populares.push(limpo);   // descarta títulos que são só o binômio latino
    }
  }

  const fontes = [];
  if (wiki?.link) fontes.push({ titulo: 'Wikipédia', url: wiki.link });
  fontes.push({
    titulo: 'Flora e Funga do Brasil',
    url: `https://floradobrasil.jbrj.gov.br/consulta/?grupo=5&filtro=${encodeURIComponent(nomeCientifico)}`,
  });
  fontes.push({
    titulo: 'GBIF',
    url: `https://www.gbif.org/species/search?q=${encodeURIComponent(nomeCientifico)}`,
  });

  return {
    familia: flora?.familia || '',
    origem: flora?.origem || '',
    dominios: flora?.dominios || [],
    populares,
    resumo: wiki?.texto || '',
    cerrado: flora?.cerrado ?? pareceCerrado(nomeCientifico),
    fontes,
  };
}
