/* Teste de fumaça: percorre o app inteiro num iPhone simulado e confere que
 * o caminho principal continua funcionando — registrar com foto, salvar sem
 * nome, buscar, marcar no croqui, guardar a chave, gerar backup e abrir
 * offline.
 *
 * Como rodar:
 *   npm install playwright-core        (uma vez)
 *   python3 -m http.server 8765        (na raiz do projeto, noutro terminal)
 *   node testes/fumaca.mjs
 *
 * Variáveis de ambiente:
 *   BASE     endereço do servidor            (padrão http://127.0.0.1:8765)
 *   CHROME   caminho do executável Chromium  (padrão: o do Playwright)
 *   SAIDA    pasta das capturas de tela      (padrão ./testes/capturas)
 */
import { chromium, devices } from 'playwright-core';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const SAIDA = process.env.SAIDA || 'testes/capturas';
mkdirSync(SAIDA, { recursive: true });

const falhas = [];
function conferir(condicao, descricao) {
  if (condicao) console.log('  ok  ', descricao);
  else { console.log('  FALHA', descricao); falhas.push(descricao); }
}

const navegador = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: ['--no-sandbox'],
});

const contexto = await navegador.newContext({
  ...devices['iPhone 13'],
  isMobile: true,
  hasTouch: true,
  locale: 'pt-BR',
  geolocation: { latitude: -15.7801, longitude: -47.9292, accuracy: 8 },  // Brasília
  permissions: ['geolocation'],
});

const pagina = await contexto.newPage();

const errosConsole = [];
pagina.on('pageerror', (e) => errosConsole.push(String(e)));
pagina.on('console', (m) => { if (m.type() === 'error') errosConsole.push(m.text()); });

/* --------------------------------------------------- 1. coleção vazia --- */
console.log('\n1. Coleção vazia');
await pagina.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
await pagina.waitForSelector('.vazio', { timeout: 10000 });
conferir(await pagina.locator('text=Sua coleção começa agora').isVisible(), 'estado vazio aparece');
conferir(await pagina.locator('#abas a[data-aba="colecao"][aria-current="page"]').count() === 1,
  'aba Coleção marcada como ativa');

/* ------------------------------------------------ 2. foto de exemplo ---- */
const jpegBase64 = await pagina.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 900; c.height = 1200;
  const g = c.getContext('2d');
  g.fillStyle = '#8fbf7a'; g.fillRect(0, 0, 900, 1200);
  g.fillStyle = '#2f6b3a';
  g.beginPath(); g.ellipse(450, 600, 260, 460, 0, 0, Math.PI * 2); g.fill();
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (const b of buf) s += String.fromCharCode(b);
  return btoa(s);
});
const jpeg = Buffer.from(jpegBase64, 'base64');
conferir(jpeg.length > 3000, `foto de teste gerada (${jpeg.length} bytes)`);

/* --------------------------------------------------- 3. registrar -------- */
console.log('\n2. Registrar planta');
await pagina.click('#abas a[data-aba="nova"]');
await pagina.waitForSelector('text=1. Fotos');

await pagina.setInputFiles('input[type=file][capture]', {
  name: 'ipe.jpg', mimeType: 'image/jpeg', buffer: jpeg,
});
await pagina.waitForSelector('.galeria img', { timeout: 10000 });
conferir(await pagina.locator('.galeria img').count() === 1, 'miniatura da foto aparece');

await pagina.waitForFunction(
  () => /−|-?\d+\.\d+, -?\d+\.\d+/.test(document.body.innerText) || document.body.innerText.includes('±'),
  null, { timeout: 15000 },
).catch(() => {});
conferir(/±\s*\d+\s*m/.test(await pagina.locator('body').innerText()), 'GPS capturado automaticamente');

await pagina.fill('input[placeholder="ex.: ipê do portão"]', 'Ipê do portão');
await pagina.fill('input[placeholder="preenchido pela identificação, ou digite"]', 'Handroanthus impetiginosus');
await pagina.fill('input[placeholder="ex.: Bignoniaceae"]', 'Bignoniaceae');
await pagina.fill('input[placeholder="ex.: canteiro da frente"]', 'Canteiro da frente');
await pagina.fill('textarea', 'Muda do viveiro do parque, plantada na primeira chuva.');

await pagina.click('button:has-text("Salvar na coleção")');
await pagina.waitForFunction(() => location.hash.startsWith('#/planta/'), null, { timeout: 10000 });
conferir(true, 'salvou e navegou para a ficha');

/* ------------------------------------------------------ 4. ficha --------- */
console.log('\n3. Ficha da planta');
await pagina.waitForSelector('.dados');
const textoFicha = await pagina.locator('#app').innerText();
conferir(textoFicha.includes('Handroanthus impetiginosus'), 'nome científico na ficha');
conferir(textoFicha.includes('Canteiro da frente'), 'canteiro na ficha');
conferir(textoFicha.includes('identificada'), 'status identificada');
conferir((await pagina.locator('.galeria img').count()) === 1, 'foto guardada na ficha');
await pagina.screenshot({ path: `${SAIDA}/tela-ficha.png` });

/* -------------------------------------- 5. segunda planta sem nome ------- */
console.log('\n4. Planta sem nome (o caso que motivou o app)');
await pagina.click('#abas a[data-aba="nova"]');
await pagina.waitForSelector('text=1. Fotos');
await pagina.setInputFiles('input[type=file][capture]', {
  name: 'desconhecida.jpg', mimeType: 'image/jpeg', buffer: jpeg,
});
await pagina.waitForSelector('.galeria img');
await pagina.fill('input[placeholder="ex.: canteiro da frente"]', 'Fundo perto da mangueira');
await pagina.click('button:has-text("Salvar na coleção")');
await pagina.waitForFunction(() => location.hash.startsWith('#/planta/'), null, { timeout: 10000 });
const textoSemNome = await pagina.locator('#app').innerText();
conferir(textoSemNome.includes('a identificar'), 'planta sem nome fica como "a identificar"');
conferir(textoSemNome.includes('Identificar'), 'painel de identificação disponível na ficha');

/* ------------------------------------------------- 6. busca e filtros ---- */
console.log('\n5. Coleção, busca e filtros');
await pagina.click('#abas a[data-aba="colecao"]');
await pagina.waitForSelector('.grade');
conferir(await pagina.locator('.ficha').count() === 2, 'duas plantas na grade');

await pagina.fill('input[type=search]', 'bignon');
await pagina.waitForTimeout(200);
conferir(await pagina.locator('.ficha').count() === 1, 'busca por família filtra');

await pagina.fill('input[type=search]', 'IPE');   // sem acento e em maiúscula
await pagina.waitForTimeout(200);
conferir(await pagina.locator('.ficha').count() === 1, 'busca ignora acento e caixa');

await pagina.fill('input[type=search]', '');
await pagina.click('.filtros button:has-text("Sem nome")');
await pagina.waitForTimeout(200);
conferir(await pagina.locator('.ficha').count() === 1, 'filtro "Sem nome" isola a pendente');
await pagina.click('.filtros button:has-text("Cerrado")');
await pagina.waitForTimeout(200);
conferir(await pagina.locator('.ficha').count() === 1,
  'filtro Cerrado reconhece o gênero nativo digitado à mão');
await pagina.click('.filtros button:has-text("Todas")');
await pagina.waitForTimeout(200);
await pagina.screenshot({ path: `${SAIDA}/tela-colecao.png` });

/* -------------------------------------------------------- 7. croqui ------ */
console.log('\n6. Croqui do terreno');
await pagina.click('#abas a[data-aba="mapa"]');
await pagina.waitForSelector('.croqui-caixa');
conferir(/ainda fora do croqui/i.test(await pagina.locator('#app').innerText()),
  'lista de plantas sem posição');

await pagina.click('.lista-simples a:has-text("Marcar")');
await pagina.waitForSelector('text=Toque no ponto do terreno');
const caixa = await pagina.locator('.croqui-caixa').boundingBox();
await pagina.mouse.click(caixa.x + caixa.width * 0.3, caixa.y + caixa.height * 0.6);
await pagina.waitForFunction(() => location.hash.startsWith('#/planta/'), null, { timeout: 8000 });
conferir((await pagina.locator('#app').innerText()).includes('marcada na planta baixa'),
  'posição gravada e refletida na ficha');

await pagina.click('#abas a[data-aba="mapa"]');
await pagina.waitForSelector('.croqui-caixa');
conferir(await pagina.locator('.pino').count() === 1, 'pino desenhado no croqui');
await pagina.screenshot({ path: `${SAIDA}/tela-mapa.png` });

/* ------------------------------------------------------- 8. ajustes ------ */
console.log('\n7. Ajustes');
await pagina.click('#abas a[data-aba="ajustes"]');
await pagina.waitForSelector('.numeros');
const textoAjustes = await pagina.locator('#app').innerText();
conferir(/2\s*\n?plantas/.test(textoAjustes) || textoAjustes.includes('plantas'), 'resumo numérico aparece');
conferir(textoAjustes.includes('Canteiro da frente'), 'canteiros listados');
conferir(textoAjustes.includes('Você ainda não fez nenhum backup'), 'aviso de backup pendente');

await pagina.fill('input[type=password]', '2b10FAKEKEY');
await pagina.click('button:has-text("Salvar chave")');
await pagina.waitForTimeout(300);
await pagina.reload({ waitUntil: 'networkidle' });
await pagina.waitForSelector('.numeros');
conferir(await pagina.inputValue('input[type=password]') === '2b10FAKEKEY', 'chave persiste após recarregar');
await pagina.screenshot({ path: `${SAIDA}/tela-ajustes.png` });

/* -------------------------------------------- 9. persistência e backup --- */
console.log('\n8. Persistência e backup');
const backup = await pagina.evaluate(async () => {
  const mod = await import('./js/backup.js');
  const dados = await mod.gerarBackup();
  return {
    plantas: dados.plantas.length,
    fotos: dados.fotos.length,
    temImagem: Boolean(dados.fotos[0]?.imagem),
    vazouChave: JSON.stringify(dados).includes('2b10FAKEKEY'),
  };
});
conferir(backup.plantas === 2, `backup contém as 2 plantas`);
conferir(backup.fotos === 2, `backup contém as 2 fotos`);
conferir(backup.temImagem, 'fotos serializadas em base64');
conferir(!backup.vazouChave, 'chave da API não vai no backup');

/* ------------------------------------------------------- 10. offline ----- */
console.log('\n9. Offline');
await pagina.evaluate(() => navigator.serviceWorker.ready);
await contexto.setOffline(true);
await pagina.goto(`${BASE}/index.html#/colecao`, { waitUntil: 'domcontentloaded' });
await pagina.waitForSelector('.grade, .vazio', { timeout: 10000 });
conferir(await pagina.locator('.ficha').count() === 2, 'app abre e lista as plantas sem rede');
await contexto.setOffline(false);

/* --------------------------------------------------------- resultado ----- */
const errosReais = errosConsole.filter((e) => !/favicon|manifest|Failed to load resource/i.test(e));
console.log('\nErros de console:', errosReais.length ? errosReais : 'nenhum');
if (errosReais.length) falhas.push('erros de console');

console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nTUDO PASSOU');

await navegador.close();
process.exit(falhas.length ? 1 : 0);
