/* Ajustes: chave do Pl@ntNet, canteiros, backup e o resumo da coleção.
 *
 * O bloco de backup fica em destaque de propósito. Como não há servidor, o
 * Safari é o único lugar onde seus dados existem; se você limpar dados do site
 * ou trocar de iPhone sem exportar, acabou. Melhor incomodar aqui do que
 * consolar depois.
 */

import * as bd from '../db.js';
import { exportar, exportarPlanilha, importar } from '../backup.js';
import { formatarTamanho } from '../imagem.js';
import {
  h, limpar, definirTopo, avisar, confirmar, carregando, dataCurta, tempoRelativo,
} from '../ui.js';

async function usoDeArmazenamento() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usado: usage || 0, cota: quota || 0 };
  } catch {
    return null;
  }
}

export default async function telaAjustes(app, estado, { irPara }) {
  definirTopo({ titulo: 'Ajustes' });
  limpar(app).append(carregando());

  const [plantas, fotos, config, uso] = await Promise.all([
    bd.listarPlantas(),
    bd.listarTodasFotos(),
    bd.lerTodaConfig(),
    usoDeArmazenamento(),
  ]);

  const identificadas = plantas.filter((p) => p.status === 'identificada').length;
  const nativas = plantas.filter((p) => p.cerrado === true).length;
  const familias = new Set(plantas.map((p) => p.familia).filter(Boolean)).size;

  /* ------------------------------------------------------------- chave --- */

  const campoChave = h('input', {
    type: 'password',
    value: config.chavePlantnet || '',
    placeholder: '2b10...',
    autocapitalize: 'none', autocorrect: 'off', spellcheck: false,
  });

  const blocoChave = h('section', { class: 'secao' },
    h('h2', null, 'Identificação por foto'),
    h('div', { class: 'cartao' },
      h('label', { class: 'campo' },
        h('span', null, 'Chave da API do Pl@ntNet'),
        campoChave,
        h('div', { class: 'dica' },
          'Grátis para uso pessoal: crie a conta em my.plantnet.org, seção "API", e cole a chave aqui. '
          + 'Ela fica só neste aparelho e não entra nos backups.'),
      ),
      h('div', { class: 'botoes' },
        h('button', {
          type: 'button', class: 'botao',
          onclick: async () => {
            await bd.gravarConfig('chavePlantnet', campoChave.value.trim());
            avisar(campoChave.value.trim() ? 'Chave salva.' : 'Chave removida.');
          },
        }, 'Salvar chave'),
        h('a', {
          class: 'botao botao--claro', href: 'https://my.plantnet.org/', target: '_blank', rel: 'noopener',
        }, 'Abrir o Pl@ntNet'),
      ),
    ),
  );

  /* ---------------------------------------------------------- canteiros -- */

  const zonasAtuais = [...new Set([
    ...(config.zonas || []),
    ...plantas.map((p) => p.zona).filter(Boolean),
  ])].sort();

  const novaZona = h('input', { type: 'text', placeholder: 'ex.: canteiro dos fundos' });

  const listaZonas = h('ul', { class: 'lista-simples' });

  function desenharZonas() {
    limpar(listaZonas);
    if (!zonasAtuais.length) {
      listaZonas.append(h('li', null, h('span', { class: 'dica' }, 'Nenhum canteiro cadastrado ainda.')));
      return;
    }
    for (const z of zonasAtuais) {
      const emUso = plantas.filter((p) => p.zona === z).length;
      listaZonas.append(h('li', null,
        h('span', null, z, ' ', h('span', { class: 'dica' }, `${emUso} planta(s)`)),
        emUso === 0
          ? h('button', {
            type: 'button', class: 'botao botao--perigo botao--pequeno',
            onclick: async () => {
              const restante = zonasAtuais.filter((x) => x !== z);
              await bd.gravarConfig('zonas', restante);
              zonasAtuais.splice(0, zonasAtuais.length, ...restante);
              desenharZonas();
            },
          }, 'Remover')
          : null,
      ));
    }
  }

  const blocoZonas = h('section', { class: 'secao' },
    h('h2', null, 'Canteiros do terreno'),
    h('div', { class: 'cartao' },
      h('p', { class: 'dica' },
        'Dividir os 1000 m² em áreas com nome é o que substitui o GPS na hora de achar a planta: '
        + '"frente", "lateral da garagem", "fundo perto da mangueira".'),
      listaZonas,
      h('div', { class: 'botoes', style: { marginTop: '12px' } },
        novaZona,
        h('button', {
          type: 'button', class: 'botao botao--pequeno',
          onclick: async () => {
            const nome = novaZona.value.trim();
            if (!nome || zonasAtuais.includes(nome)) return;
            zonasAtuais.push(nome);
            zonasAtuais.sort();
            await bd.gravarConfig('zonas', zonasAtuais);
            novaZona.value = '';
            desenharZonas();
          },
        }, 'Adicionar'),
      ),
    ),
  );
  desenharZonas();

  /* ------------------------------------------------------------ backup --- */

  const ultimo = config.ultimoBackup;
  const diasSemBackup = ultimo
    ? Math.floor((Date.now() - new Date(ultimo).getTime()) / 86400000)
    : null;
  const atrasado = plantas.length > 0 && (ultimo === undefined || ultimo === null || diasSemBackup > 30);

  const entradaImportar = h('input', {
    type: 'file', accept: 'application/json,.json', class: 'oculto',
    onchange: async (e) => {
      const arquivo = e.target.files?.[0];
      e.target.value = '';
      if (!arquivo) return;
      if (!confirmar('Restaurar este backup por cima da coleção atual?')) return;
      try {
        const r = await importar(arquivo);
        avisar(`Restaurado: ${r.plantas} planta(s) e ${r.fotos} foto(s).`);
        irPara('#/ajustes', { recarregar: true });
      } catch (err) {
        avisar(err.message || 'Falha ao restaurar.', 'erro', 6);
      }
    },
  });

  const blocoBackup = h('section', { class: 'secao' },
    h('h2', null, 'Backup'),
    h('div', { class: 'cartao' },
      h('p', { class: 'dica' },
        ultimo
          ? `Último backup: ${dataCurta(ultimo)} (${tempoRelativo(ultimo)}).`
          : 'Você ainda não fez nenhum backup.'),
      atrasado
        ? h('p', { style: { color: 'var(--alerta)', fontSize: '.88rem' } },
          'A coleção mora só neste iPhone. Limpar os dados do Safari, trocar de aparelho '
          + 'ou desinstalar o app apaga tudo. Exporte e guarde no iCloud Drive.')
        : null,
      h('div', { class: 'botoes' },
        h('button', {
          type: 'button', class: 'botao',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              const r = await exportar();
              if (r.via !== 'cancelado') avisar(`Backup gerado (${formatarTamanho(r.bytes)}).`);
            } catch (err) {
              avisar(err.message || 'Falha ao exportar.', 'erro');
            } finally {
              e.target.disabled = false;
            }
          },
        }, 'Exportar backup'),
        h('button', {
          type: 'button', class: 'botao botao--claro',
          onclick: () => entradaImportar.click(),
        }, 'Restaurar backup'),
      ),
      h('div', { class: 'botoes', style: { marginTop: '8px' } },
        h('button', {
          type: 'button', class: 'botao botao--claro botao--bloco',
          onclick: async () => {
            const r = await exportarPlanilha();
            if (r.via !== 'cancelado') avisar(`Planilha com ${r.linhas} planta(s) gerada.`);
          },
        }, 'Exportar planilha (CSV)'),
      ),
      entradaImportar,
    ),
  );

  /* ------------------------------------------------------------ resumo --- */

  const blocoResumo = h('section', { class: 'secao' },
    h('h2', null, 'Sua coleção'),
    h('div', { class: 'cartao' },
      h('div', { class: 'numeros' },
        h('div', { class: 'numero' }, h('strong', null, String(plantas.length)), h('span', null, 'plantas')),
        h('div', { class: 'numero' }, h('strong', null, String(identificadas)), h('span', null, 'identificadas')),
        h('div', { class: 'numero' }, h('strong', null, String(nativas)), h('span', null, 'do Cerrado')),
        h('div', { class: 'numero' }, h('strong', null, String(familias)), h('span', null, 'famílias')),
        h('div', { class: 'numero' }, h('strong', null, String(fotos.length)), h('span', null, 'fotos')),
      ),
      uso
        ? h('p', { class: 'dica', style: { marginTop: '12px' } },
          `Ocupando ${formatarTamanho(uso.usado)} do espaço que o Safari reservou para o app`
          + (uso.cota ? ` (limite aproximado de ${formatarTamanho(uso.cota)}).` : '.'))
        : null,
    ),
  );

  /* ---------------------------------------------------------- instalar --- */

  const instalado = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;

  const blocoInstalar = instalado ? null : h('section', { class: 'secao' },
    h('h2', null, 'Instalar no iPhone'),
    h('div', { class: 'cartao' },
      h('p', { class: 'dica', style: { margin: 0 } },
        'No Safari, toque em Compartilhar › "Adicionar à Tela de Início". '
        + 'Instalado, o app abre em tela cheia, funciona offline e o iOS deixa de apagar os dados '
        + 'por falta de uso — o que ele faz com sites comuns depois de alguns dias parado.'),
    ),
  );

  /* ------------------------------------------------------------ perigo --- */

  const blocoPerigo = h('section', { class: 'secao' },
    h('h2', null, 'Zona de risco'),
    h('button', {
      type: 'button', class: 'botao botao--perigo botao--bloco',
      onclick: async () => {
        if (!confirmar('Apagar TODAS as plantas, fotos e ajustes deste aparelho?')) return;
        if (!confirmar('Tem certeza mesmo? Sem backup exportado, não há como voltar atrás.')) return;
        await bd.limparTudo();
        avisar('Tudo apagado.');
        irPara('#/colecao', { recarregar: true });
      },
    }, 'Apagar tudo'),
  );

  limpar(app).append(
    blocoResumo, blocoChave, blocoZonas, blocoBackup, blocoInstalar, blocoPerigo,
    h('p', { class: 'dica', style: { textAlign: 'center', marginTop: '20px' } },
      'Suas fotos e coordenadas ficam neste aparelho. Só sai daqui a imagem que você manda '
      + 'identificar, e ela vai para o Pl@ntNet sem nada que te identifique.'),
  );

  void estado;
}
