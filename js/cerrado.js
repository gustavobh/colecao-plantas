/* Heurística offline de "isso é do Cerrado?".
 *
 * Não é taxonomia séria: é uma lista de gêneros cuja presença no Cerrado é
 * característica o bastante para valer um sinal na tela. Serve para dois fins:
 *   1. destacar na coleção o que é nativo, que é justamente o que não se acha
 *      em jardim tradicional e o que é mais difícil de lembrar;
 *   2. desempatar candidatos do Pl@ntNet quando dois palpites têm nota parecida
 *      e um deles é um gênero tipicamente europeu.
 *
 * Fonte: gêneros recorrentes nas listas de flora do Cerrado (Mendonça et al.,
 * "Flora vascular do Cerrado", e Flora e Funga do Brasil). Quando houver
 * internet, `js/api.js` confirma o domínio fitogeográfico na Flora e Funga do
 * Brasil e o resultado de lá manda mais que esta lista.
 */

const GENEROS_CERRADO = new Set([
  // árvores e arbustos emblemáticos
  'handroanthus', 'tabebuia', 'cybistax', 'zeyheria', 'jacaranda', 'sparattosperma',
  'qualea', 'vochysia', 'salvertia', 'callisthene',
  'caryocar', 'kielmeyera', 'curatella', 'davilla',
  'dipteryx', 'pterodon', 'bowdichia', 'plathymenia', 'platypodium', 'machaerium',
  'dalbergia', 'andira', 'hymenaea', 'copaifera', 'stryphnodendron', 'anadenanthera',
  'piptadenia', 'mimosa', 'calliandra', 'chamaecrista', 'senna', 'bauhinia',
  'peltophorum', 'tachigali', 'sclerolobium', 'enterolobium', 'leptolobium',
  'byrsonima', 'heteropterys', 'banisteriopsis',
  'annona', 'duguetia', 'xylopia', 'guatteria',
  'eugenia', 'campomanesia', 'myrcia', 'psidium', 'blepharocalyx', 'siphoneugena',
  'anacardium', 'astronium', 'myracrodruon', 'tapirira', 'lithraea',
  'pouteria', 'chrysophyllum', 'micropholis',
  'erythroxylum', 'ouratea', 'miconia', 'tibouchina', 'pleroma',
  'aspidosperma', 'himatanthus', 'hancornia', 'macrosiphonia',
  'roupala', 'euplassa',
  'terminalia', 'buchenavia', 'combretum',
  'diospyros', 'styrax', 'symplocos',
  'alibertia', 'genipa', 'tocoyena', 'palicourea', 'psychotria', 'randia', 'guettarda',
  'eriotheca', 'pseudobombax', 'sterculia', 'luehea', 'guazuma', 'cochlospermum',
  'brosimum', 'salacia', 'emmotum', 'cheiloclinium',
  'lafoensia', 'physocalymma',
  'vernonanthura', 'lepidaploa', 'eremanthus', 'piptocarpha', 'gochnatia',
  'moquiniastrum', 'baccharis', 'aspilia', 'chromolaena',
  'jatropha', 'cnidoscolus', 'manihot', 'maprounea', 'pera', 'croton',
  'hirtella', 'licania', 'couepia', 'parinari',
  'casearia', 'zanthoxylum', 'simarouba', 'agonandra',
  'connarus', 'rourea', 'peritassa',
  'solanum', 'cordia', 'aegiphila', 'vitex', 'lippia', 'vernonia',
  'kielmeyera', 'caraipa', 'vismia',
  'myrsine', 'rapanea', 'schefflera', 'cecropia',
  // palmeiras e monocotiledôneas típicas
  'mauritia', 'syagrus', 'attalea', 'acrocomia', 'allagoptera', 'butia',
  'vellozia', 'barbacenia', 'bulbostylis', 'paepalanthus', 'syngonanthus', 'xyris',
  'aechmea', 'dyckia', 'ananas',
  'habenaria', 'cyrtopodium', 'epidendrum',
  // gramíneas nativas de campo
  'aristida', 'axonopus', 'echinolaena', 'loudetiopsis', 'trachypogon', 'paspalum',
  'schizachyrium', 'andropogon',
]);

/* Espécies em que o gênero sozinho engana (o gênero é pantropical, mas esta
 * espécie é marca do Cerrado). */
const ESPECIES_CERRADO = new Set([
  'solanum lycocarpum', 'annona crassiflora', 'anacardium humile',
  'anacardium occidentale', 'caryocar brasiliense', 'dipteryx alata',
  'hancornia speciosa', 'eugenia dysenterica', 'campomanesia adamantium',
  'brosimum gaudichaudii', 'mauritia flexuosa', 'butia archeri',
  'stryphnodendron adstringens', 'plathymenia reticulata', 'qualea grandiflora',
  'kielmeyera coriacea', 'curatella americana', 'byrsonima crassifolia',
  'handroanthus ochraceus', 'handroanthus impetiginosus', 'tabebuia aurea',
  'pouteria ramiflora', 'salvertia convallariodora', 'lafoensia pacari',
  'jacaranda cuspidifolia', 'cochlospermum regium', 'schefflera macrocarpa',
]);

/* Gêneros que praticamente só aparecem por aqui quando são jardim, não mato.
 * Ajuda a não marcar um lírio-do-nilo como nativo por engano. */
const GENEROS_ORNAMENTAIS_EXOTICOS = new Set([
  'rosa', 'hydrangea', 'agapanthus', 'lavandula', 'buxus', 'camellia', 'gardenia',
  'hibiscus', 'bougainvillea', 'ixora', 'duranta', 'nerium', 'plumbago',
  'dracaena', 'sansevieria', 'zamioculcas', 'monstera', 'epipremnum', 'spathiphyllum',
  'ficus', 'murraya', 'syzygium', 'eucalyptus', 'mangifera', 'citrus', 'persea',
  'pelargonium', 'petunia', 'tagetes', 'zinnia', 'impatiens', 'begonia',
  'cuphea', 'catharanthus', 'ruellia', 'russelia', 'strelitzia', 'heliconia',
  'alpinia', 'costus', 'canna', 'philodendron', 'anthurium', 'aglaonema',
  'nandina', 'podocarpus', 'cupressus', 'thuja', 'juniperus', 'pinus',
  'washingtonia', 'dypsis', 'chamaedorea', 'livistona', 'phoenix', 'roystonea',
]);

function normalizar(nome) {
  return (nome || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function generoDe(nomeCientifico) {
  return normalizar(nomeCientifico).split(' ')[0] || '';
}

/**
 * @returns {true|false|null} true = provavelmente do Cerrado,
 *   false = provavelmente exótica de jardim, null = não sei dizer offline.
 */
export function pareceCerrado(nomeCientifico) {
  const nome = normalizar(nomeCientifico);
  if (!nome) return null;
  const binomial = nome.split(' ').slice(0, 2).join(' ');
  if (ESPECIES_CERRADO.has(binomial)) return true;
  const genero = generoDe(nome);
  if (GENEROS_CERRADO.has(genero)) return true;
  if (GENEROS_ORNAMENTAIS_EXOTICOS.has(genero)) return false;
  return null;
}

/** Peso aplicado ao palpite do Pl@ntNet: nativo sobe um pouco, exótico desce. */
export function pesoRegional(nomeCientifico) {
  const veredito = pareceCerrado(nomeCientifico);
  if (veredito === true) return 1.15;
  if (veredito === false) return 0.92;
  return 1;
}
