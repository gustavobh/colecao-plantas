/* Backup e restauração.
 *
 * Sem servidor, o dado mora só no Safari do seu iPhone. Trocar de aparelho,
 * limpar dados do site ou desinstalar o PWA apaga tudo. Por isso o backup não é
 * um extra escondido: a tela de Ajustes cobra quando o último é antigo.
 *
 * O arquivo é um JSON único com as fotos em base64 dentro. Fica grande (uma
 * coleção de 150 plantas com 3 fotos cada dá uns 60 MB), mas é um arquivo só,
 * que o iOS salva no Arquivos/iCloud pelo botão de compartilhar, e que se lê
 * sem nenhuma ferramenta especial daqui a dez anos.
 */

import * as bd from './db.js';
import { blobParaBase64, base64ParaBlob } from './imagem.js';

const FORMATO = 'colecao-plantas/1';

export async function gerarBackup() {
  const [plantas, fotos, config] = await Promise.all([
    bd.listarPlantas(),
    bd.listarTodasFotos(),
    bd.lerTodaConfig(),
  ]);

  const fotosSerializadas = [];
  for (const f of fotos) {
    fotosSerializadas.push({
      id: f.id,
      plantaId: f.plantaId,
      orgao: f.orgao,
      nota: f.nota,
      criadoEm: f.criadoEm,
      imagem: f.imagem ? await blobParaBase64(f.imagem) : null,
      miniatura: f.miniatura ? await blobParaBase64(f.miniatura) : null,
    });
  }

  // A chave da API é credencial: não vai no arquivo que você manda por e-mail.
  const configLimpa = { ...config };
  delete configLimpa.chavePlantnet;
  if (configLimpa.croquiImagem instanceof Blob) {
    configLimpa.croquiImagem = {
      __blob: await blobParaBase64(configLimpa.croquiImagem),
      tipo: configLimpa.croquiImagem.type || 'image/jpeg',
    };
  }

  return {
    formato: FORMATO,
    geradoEm: new Date().toISOString(),
    plantas,
    fotos: fotosSerializadas,
    config: configLimpa,
  };
}

function nomeDoArquivo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `colecao-plantas-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
}

/**
 * Entrega o arquivo ao iOS. Preferimos a folha de compartilhamento, que deixa
 * salvar direto no Arquivos/iCloud — o download comum dentro de um PWA
 * instalado às vezes some sem aviso.
 */
export async function exportar() {
  const dados = await gerarBackup();
  const texto = JSON.stringify(dados);
  const blob = new Blob([texto], { type: 'application/json' });
  const nome = nomeDoArquivo();
  const arquivo = new File([blob], nome, { type: 'application/json' });

  if (navigator.canShare?.({ files: [arquivo] })) {
    try {
      await navigator.share({ files: [arquivo], title: 'Backup da coleção' });
      await bd.gravarConfig('ultimoBackup', new Date().toISOString());
      return { via: 'compartilhamento', bytes: blob.size };
    } catch (e) {
      if (e.name === 'AbortError') return { via: 'cancelado', bytes: blob.size };
      /* segue para o download */
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  await bd.gravarConfig('ultimoBackup', new Date().toISOString());
  return { via: 'download', bytes: blob.size };
}

/**
 * Restaura por cima do que existe. Plantas com o mesmo id são substituídas;
 * as que só existem no aparelho continuam. É o comportamento que evita perder
 * dado quando você restaura um backup antigo por engano.
 */
export async function importar(arquivo) {
  const texto = await arquivo.text();
  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    throw new Error('Esse arquivo não é um backup válido.');
  }
  if (!dados || !String(dados.formato || '').startsWith('colecao-plantas/')) {
    throw new Error('Arquivo de outro formato. Escolha um backup gerado por este app.');
  }

  let plantas = 0;
  let fotos = 0;

  for (const p of dados.plantas || []) {
    if (!p?.id) continue;
    await bd.salvarPlanta({ ...bd.plantaVazia(), ...p });
    plantas++;
  }

  for (const f of dados.fotos || []) {
    if (!f?.id || !f.plantaId) continue;
    const foto = {
      id: f.id,
      plantaId: f.plantaId,
      orgao: f.orgao || 'auto',
      nota: f.nota || '',
      criadoEm: f.criadoEm || new Date().toISOString(),
      imagem: f.imagem ? base64ParaBlob(f.imagem) : null,
      miniatura: f.miniatura ? base64ParaBlob(f.miniatura) : null,
    };
    const conexao = await bd.abrir();
    await new Promise((ok, erro) => {
      const tx = conexao.transaction('fotos', 'readwrite');
      tx.objectStore('fotos').put(foto);
      tx.oncomplete = ok;
      tx.onerror = () => erro(tx.error);
    });
    fotos++;
  }

  for (const [chave, valor] of Object.entries(dados.config || {})) {
    if (chave === 'chavePlantnet') continue;
    if (valor && typeof valor === 'object' && valor.__blob) {
      await bd.gravarConfig(chave, base64ParaBlob(valor.__blob, valor.tipo));
    } else {
      await bd.gravarConfig(chave, valor);
    }
  }

  return { plantas, fotos };
}

/* --------------------------------------------------------------- lista --- */

function celula(valor) {
  const t = String(valor ?? '').replace(/"/g, '""');
  return /[",;\n]/.test(t) ? `"${t}"` : t;
}

/** Uma planilha simples da coleção — para imprimir, mandar pro paisagista etc. */
export async function exportarPlanilha() {
  const plantas = await bd.listarPlantas();
  const colunas = ['Apelido', 'Espécie', 'Família', 'Nomes populares', 'Zona',
    'Status', 'Cerrado', 'Plantada em', 'GPS', 'Notas'];
  const linhas = plantas.map((p) => [
    p.apelido, p.especie, p.familia, (p.nomesPopulares || []).join(' / '), p.zona,
    p.status, p.cerrado === true ? 'sim' : p.cerrado === false ? 'não' : '',
    p.plantadaEm, p.gps ? `${p.gps.lat}, ${p.gps.lon}` : '', p.notas,
  ]);

  const csv = '﻿' + [colunas, ...linhas]
    .map((l) => l.map(celula).join(';'))
    .join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const nome = nomeDoArquivo().replace('.json', '.csv');
  const arquivo = new File([blob], nome, { type: 'text/csv' });

  if (navigator.canShare?.({ files: [arquivo] })) {
    try {
      await navigator.share({ files: [arquivo], title: 'Coleção de plantas' });
      return { via: 'compartilhamento', linhas: plantas.length };
    } catch (e) {
      if (e.name === 'AbortError') return { via: 'cancelado', linhas: plantas.length };
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { via: 'download', linhas: plantas.length };
}
