/* Tratamento de imagem antes de guardar.
 *
 * Foto crua de iPhone tem 3–5 MB. Guardar assim estoura a cota do IndexedDB
 * depois de algumas centenas de plantas e deixa o envio para identificação
 * lento no 4G do quintal. Então tudo passa por aqui: reduz para 1600px de lado
 * maior (suficiente para o Pl@ntNet) e gera uma miniatura de 320px para as
 * listagens.
 */

const LADO_MAX = 1600;
const LADO_MINIATURA = 320;
const QUALIDADE = 0.82;

/** Decodifica respeitando a orientação EXIF (foto tirada deitado). */
async function decodificar(origem) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(origem, { imageOrientation: 'from-image' });
    } catch { /* Safari antigo: cai no caminho abaixo */ }
  }
  const url = URL.createObjectURL(origem);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((ok, erro) => {
      img.onload = ok;
      img.onerror = () => erro(new Error('Não consegui ler essa imagem.'));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function dimensoes(bitmap) {
  return {
    largura: bitmap.width || bitmap.naturalWidth,
    altura: bitmap.height || bitmap.naturalHeight,
  };
}

function paraBlob(canvas, qualidade) {
  return new Promise((ok, erro) => {
    canvas.toBlob(
      (b) => (b ? ok(b) : erro(new Error('Falha ao converter a imagem.'))),
      'image/jpeg',
      qualidade,
    );
  });
}

async function redimensionar(bitmap, ladoMax, qualidade) {
  const { largura, altura } = dimensoes(bitmap);
  const escala = Math.min(1, ladoMax / Math.max(largura, altura));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(largura * escala));
  canvas.height = Math.max(1, Math.round(altura * escala));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return paraBlob(canvas, qualidade);
}

/**
 * Recebe o File vindo do <input capture> e devolve os dois blobs prontos.
 * @returns {Promise<{imagem: Blob, miniatura: Blob, largura: number, altura: number}>}
 */
export async function prepararFoto(arquivo) {
  const bitmap = await decodificar(arquivo);
  const { largura, altura } = dimensoes(bitmap);
  const imagem = await redimensionar(bitmap, LADO_MAX, QUALIDADE);
  const miniatura = await redimensionar(bitmap, LADO_MINIATURA, 0.72);
  if (bitmap.close) bitmap.close();
  return { imagem, miniatura, largura, altura };
}

/* URLs de objeto criadas para exibir blobs. Revogamos ao trocar de tela para
 * não vazar memória durante uma sessão longa de catalogação. */
const urlsVivas = new Set();

export function urlDe(blob) {
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  urlsVivas.add(url);
  return url;
}

export function soltarUrls() {
  for (const url of urlsVivas) URL.revokeObjectURL(url);
  urlsVivas.clear();
}

export async function blobParaBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let bin = '';
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + passo));
  }
  return btoa(bin);
}

export function base64ParaBlob(base64, tipo = 'image/jpeg') {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: tipo });
}

export function formatarTamanho(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
