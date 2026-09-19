/* Painel da carteira. JavaScript puro, SVG desenhado a mao, sem dependencia. */

const NS = "http://www.w3.org/2000/svg";

const dinheiro = new Intl.NumberFormat("pt-BR", {
  style: "currency", currency: "BRL", maximumFractionDigits: 2,
});
const dinheiroCurto = new Intl.NumberFormat("pt-BR", {
  style: "currency", currency: "BRL", maximumFractionDigits: 0,
});
const numero = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 8 });
const percentual = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

const NOME_CLASSE = {
  ACAO: "Ações", FII: "FIIs", ETF_BR: "ETFs Brasil", ETF_US: "ETFs EUA",
  STOCK_US: "Ações EUA", REIT_US: "REITs", BDR: "BDRs",
  RENDA_FIXA: "Renda fixa", TESOURO: "Tesouro Direto", FUNDO: "Fundos",
  CRIPTO: "Cripto", OUTRO: "Outros",
};

const NOME_PROVENTO = {
  DIVIDENDO: "Dividendo", JCP: "JCP", RENDIMENTO: "Rendimento",
  AMORTIZACAO: "Amortização", JUROS: "Juros",
};

/* Cor lida do CSS, para o grafico acompanhar a troca de tema. */
const cor = (slot) =>
  getComputedStyle(document.documentElement).getPropertyValue(`--${slot}`).trim();

const el = (id) => document.getElementById(id);

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  return node;
}

/* Retangulo com as duas pontas de fora arredondadas e a base encostada no eixo. */
function barra(x, y, largura, altura, raio, orientacao = "vertical") {
  const r = Math.min(raio, largura / 2, altura);
  if (altura <= 0 || largura <= 0) return "";
  if (orientacao === "vertical") {
    return `M${x},${y + altura} L${x},${y + r} Q${x},${y} ${x + r},${y}` +
           ` L${x + largura - r},${y} Q${x + largura},${y} ${x + largura},${y + r}` +
           ` L${x + largura},${y + altura} Z`;
  }
  const rh = Math.min(raio, altura / 2, largura);
  return `M${x},${y} L${x + largura - rh},${y} Q${x + largura},${y} ${x + largura},${y + rh}` +
         ` L${x + largura},${y + altura - rh} Q${x + largura},${y + altura} ${x + largura - rh},${y + altura}` +
         ` L${x},${y + altura} Z`;
}

function escalaBonita(maximo, divisoes = 4) {
  if (maximo <= 0) return { topo: 1, passo: 0.25 };
  const cru = maximo / divisoes;
  const magnitude = Math.pow(10, Math.floor(Math.log10(cru)));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((p) => p >= cru) ?? magnitude * 10;
  return { topo: Math.ceil(maximo / passo) * passo, passo };
}

function rotuloMes(chave) {
  const [ano, mes] = chave.split("-");
  return `${MESES[Number(mes) - 1]}/${ano.slice(2)}`;
}

/* ---------- Dica flutuante ---------- */

const dica = el("dica");

function mostrarDica(evento, titulo, linhas) {
  dica.innerHTML =
    `<div class="titulo">${titulo}</div><dl>` +
    linhas.map(([rot, val, c]) =>
      `<dt>${c ? `<i style="background:${c}"></i>` : ""}${rot}</dt><dd>${val}</dd>`
    ).join("") + "</dl>";
  dica.classList.add("visivel");
  moverDica(evento);
}

function moverDica(evento) {
  dica.style.left = `${evento.clientX}px`;
  dica.style.top = `${evento.clientY - 12}px`;
}

const esconderDica = () => dica.classList.remove("visivel");

function ligarDica(alvo, titulo, linhas) {
  alvo.addEventListener("mouseenter", (e) => mostrarDica(e, titulo, linhas));
  alvo.addEventListener("mousemove", moverDica);
  alvo.addEventListener("mouseleave", esconderDica);
}

/* ---------- Grafico: proventos por mes ---------- */

function desenharMensal(dados) {
  const svg = el("grafico-mensal");
  svg.innerHTML = "";
  if (!dados.length) return;

  const L = 58, R = 12, T = 14, B = 30;
  const largura = Math.max(svg.clientWidth || 860, 360);
  const altura = 250;
  const plotW = largura - L - R;
  const plotH = altura - T - B;

  svg.setAttribute("viewBox", `0 0 ${largura} ${altura}`);
  svg.setAttribute("height", altura);

  const maximo = Math.max(...dados.map((d) => d.total), 0);
  const { topo, passo } = escalaBonita(maximo);
  const y = (v) => T + plotH - (v / topo) * plotH;

  /* Grade recuada, desenhada antes das marcas. */
  for (let v = 0; v <= topo + 1e-9; v += passo) {
    svg.appendChild(svgEl("line", {
      class: "grade", x1: L, x2: L + plotW, y1: y(v), y2: y(v),
      opacity: v === 0 ? 1 : 0.45,
    }));
    const texto = svgEl("text", { class: "eixo", x: L - 8, y: y(v) + 4, "text-anchor": "end" });
    texto.textContent = dinheiroCurto.format(v);
    svg.appendChild(texto);
  }

  const passoX = plotW / dados.length;
  const larguraBarra = Math.min(26, passoX * 0.64);
  const corRenda = cor("series-1");
  const corAmort = cor("series-2");

  dados.forEach((mes, i) => {
    const x = L + passoX * i + (passoX - larguraBarra) / 2;
    const grupo = svgEl("g", { class: "alvo" });

    /* Empilhamento de baixo para cima, com 2px de respiro entre os segmentos. */
    let base = y(0);
    const segmentos = [
      { valor: mes.renda, cor: corRenda },
      { valor: mes.amortizacao, cor: corAmort },
    ].filter((s) => s.valor > 0);

    segmentos.forEach((seg, indice) => {
      const alturaSeg = (seg.valor / topo) * plotH - (indice > 0 ? 2 : 0);
      if (alturaSeg <= 0) return;
      const topoSeg = base - alturaSeg;
      const ehTopo = indice === segmentos.length - 1;
      grupo.appendChild(svgEl("path", {
        class: "marca",
        d: ehTopo
          ? barra(x, topoSeg, larguraBarra, alturaSeg, 4)
          : `M${x},${topoSeg} h${larguraBarra} v${alturaSeg} h${-larguraBarra} Z`,
        fill: seg.cor,
      }));
      base = topoSeg - 2;
    });

    /* Area de captura maior que a barra, para o hover nao exigir pontaria. */
    const captura = svgEl("rect", {
      x: L + passoX * i, y: T, width: passoX, height: plotH, fill: "transparent",
    });
    grupo.appendChild(captura);

    const linhas = [["Total", dinheiro.format(mes.total)]];
    if (mes.renda > 0) linhas.unshift(["Renda", dinheiro.format(mes.renda), corRenda]);
    if (mes.amortizacao > 0) linhas.splice(-1, 0, ["Amortização", dinheiro.format(mes.amortizacao), corAmort]);
    if (mes.pagamentos) linhas.push(["Créditos", String(mes.pagamentos)]);
    ligarDica(grupo, rotuloMes(mes.mes), linhas);

    /* Rotulo de mes a cada tres, senao o eixo vira borrao. */
    if (i % 3 === 0 || i === dados.length - 1) {
      const texto = svgEl("text", {
        class: "eixo", x: L + passoX * i + passoX / 2, y: altura - 10, "text-anchor": "middle",
      });
      texto.textContent = rotuloMes(mes.mes);
      svg.appendChild(texto);
    }
    svg.appendChild(grupo);
  });

  el("legenda-mensal").innerHTML =
    `<span><i style="background:${corRenda}"></i>Renda (dividendo, JCP, rendimento, juros)</span>` +
    `<span><i style="background:${corAmort}"></i>Amortização (devolução de principal)</span>`;

  el("tabela-mensal").innerHTML =
    "<thead><tr><th>Mês</th><th>Renda</th><th>Amortização</th><th>Total</th><th>Créditos</th></tr></thead><tbody>" +
    dados.filter((m) => m.total > 0).reverse().map((m) =>
      `<tr><td>${rotuloMes(m.mes)}</td><td>${dinheiro.format(m.renda)}</td>` +
      `<td>${dinheiro.format(m.amortizacao)}</td><td>${dinheiro.format(m.total)}</td>` +
      `<td>${m.pagamentos}</td></tr>`
    ).join("") + "</tbody>";
}

/* ---------- Graficos de barra horizontal ---------- */

function desenharBarrasHorizontais(svgId, itens, { coresPorItem = false, formato = dinheiro } = {}) {
  const svg = el(svgId);
  svg.innerHTML = "";
  if (!itens.length) {
    svg.setAttribute("height", 60);
    const texto = svgEl("text", { class: "eixo", x: 10, y: 34 });
    texto.textContent = "Sem dados ainda.";
    svg.appendChild(texto);
    return;
  }

  const alturaLinha = 30, T = 6;
  const largura = Math.max(svg.clientWidth || 520, 320);
  const altura = itens.length * alturaLinha + T * 2;
  const rotuloW = 104;
  const valorW = 116;
  const plotW = largura - rotuloW - valorW;

  svg.setAttribute("viewBox", `0 0 ${largura} ${altura}`);
  svg.setAttribute("height", altura);

  const maximo = Math.max(...itens.map((i) => i.valor), 0) || 1;

  itens.forEach((item, i) => {
    const y = T + i * alturaLinha;
    const alturaBarra = 15;
    const comprimento = Math.max((item.valor / maximo) * plotW, item.valor > 0 ? 3 : 0);
    const c = coresPorItem ? cor(`series-${(i % 6) + 1}`) : cor("series-1");
    const grupo = svgEl("g", { class: "alvo" });

    const rotulo = svgEl("text", {
      class: "rotulo-direto", x: rotuloW - 10, y: y + alturaBarra + 1, "text-anchor": "end",
    });
    rotulo.textContent = item.rotulo;
    grupo.appendChild(rotulo);

    grupo.appendChild(svgEl("path", {
      class: "marca",
      d: barra(rotuloW, y + 5, comprimento, alturaBarra, 4, "horizontal"),
      fill: c,
    }));

    /* Rotulo direto no valor: exigido pela regra de alivio de contraste e,
       de quebra, dispensa o leitor de estimar comprimento de barra. */
    const valor = svgEl("text", {
      class: "rotulo-direto", x: rotuloW + comprimento + 9, y: y + alturaBarra + 1,
    });
    valor.textContent = item.sufixo
      ? `${formato.format(item.valor)}  ${item.sufixo}`
      : formato.format(item.valor);
    grupo.appendChild(valor);

    grupo.appendChild(svgEl("rect", {
      x: 0, y, width: largura, height: alturaLinha, fill: "transparent",
    }));
    ligarDica(grupo, item.rotulo, item.detalhes || [["Valor", formato.format(item.valor), c]]);
    svg.appendChild(grupo);
  });
}

/* ---------- Tiles ---------- */

function sinal(valor) {
  return valor > 0 ? "positivo" : valor < 0 ? "negativo" : "";
}

function renderizarTiles(resumo, proventos) {
  const tiles = [
    {
      rotulo: "Patrimônio",
      valor: dinheiro.format(resumo.valor_atual),
      nota: resumo.rentabilidade === null
        ? "sem cotação para parte da carteira"
        : `<span class="${sinal(resumo.lucro_nao_realizado)}">${
            resumo.lucro_nao_realizado >= 0 ? "+" : ""
          }${dinheiro.format(resumo.lucro_nao_realizado)} (${percentual.format(resumo.rentabilidade)}%)</span>`,
    },
    {
      rotulo: "Proventos 12 meses",
      valor: dinheiro.format(proventos.total_12m),
      nota: proventos.crescimento_12m === null
        ? `${proventos.ativos_pagadores} ativos pagaram`
        : `<span class="${sinal(proventos.crescimento_12m)}">${
            proventos.crescimento_12m >= 0 ? "+" : ""
          }${percentual.format(proventos.crescimento_12m)}% vs. 12 meses anteriores</span>`,
    },
    {
      rotulo: "Média mensal",
      valor: dinheiro.format(proventos.media_mensal_12m),
      nota: proventos.melhor_mes
        ? `melhor mês: ${rotuloMes(proventos.melhor_mes)}, ${dinheiro.format(proventos.melhor_mes_valor)}`
        : "sem histórico",
    },
    {
      rotulo: "Yield on cost",
      valor: resumo.yield_on_cost === null ? "—" : `${percentual.format(resumo.yield_on_cost)}%`,
      nota: "renda de 12 meses sobre o custo da carteira",
    },
    {
      rotulo: "Recebido este ano",
      valor: dinheiro.format(proventos.total_ano),
      nota: `${proventos.meses_com_pagamento} dos últimos 12 meses com crédito`,
    },
  ];

  el("tiles").innerHTML = tiles.map((t) =>
    `<div class="tile"><div class="rotulo">${t.rotulo}</div>` +
    `<div class="valor">${t.valor}</div><div class="nota">${t.nota}</div></div>`
  ).join("");
}

/* ---------- Tabelas ---------- */

function renderizarPosicoes(posicoes) {
  const tabela = el("tabela-posicoes");
  if (!posicoes.length) {
    tabela.innerHTML = `<tbody><tr><td class="vazio">Nenhuma posição ainda. Importe o Excel da B3 ou sincronize o Open Finance.</td></tr></tbody>`;
    return;
  }

  tabela.innerHTML =
    "<thead><tr><th>Ativo</th><th>Classe</th><th>Qtd.</th><th>Preço médio</th>" +
    '<th>Cotação</th><th>Valor atual</th><th>Resultado</th>' +
    '<th title="Proventos recebidos desde a primeira compra.">Proventos acum.</th>' +
    '<th title="Proventos acumulados divididos pelo custo atual da posição.">YoC acum.</th>' +
    "</tr></thead><tbody>" +
    posicoes.map((p) => {
      const lucro = p.lucro_nao_realizado;
      const alerta = p.custo_incompleto
        ? ` <span class="etiqueta" title="Entrou papel sem custo informado, então o preço médio está subestimado.">custo parcial</span>`
        : "";
      return `<tr>
        <td><span class="ticker">${p.ticker}</span>${alerta}<span class="sub">${p.nome || ""}</span></td>
        <td><span class="etiqueta">${NOME_CLASSE[p.tipo] || p.tipo}</span></td>
        <td>${numero.format(p.quantidade)}</td>
        <td>${dinheiro.format(p.preco_medio)}</td>
        <td>${p.preco_atual === null ? "—" : dinheiro.format(p.preco_atual)}</td>
        <td>${p.valor_atual === null ? "—" : dinheiro.format(p.valor_atual)}</td>
        <td class="${sinal(lucro)}">${
          lucro === null ? "—"
            : `${lucro >= 0 ? "+" : ""}${dinheiro.format(lucro)}<span class="sub">${percentual.format(p.rentabilidade)}%</span>`
        }</td>
        <td>${dinheiro.format(p.proventos_recebidos)}</td>
        <td>${p.yield_on_cost === null ? "—" : `${percentual.format(p.yield_on_cost)}%`}</td>
      </tr>`;
    }).join("") + "</tbody>";
}

function renderizarPagadores(itens) {
  const tabela = el("tabela-pagadores");
  if (!itens.length) {
    tabela.innerHTML = `<tbody><tr><td class="vazio">Nenhum provento registrado ainda.</td></tr></tbody>`;
    return;
  }
  tabela.innerHTML =
    "<thead><tr><th>Ativo</th><th>Classe</th><th>Renda</th><th>Amortização</th>" +
    '<th>Total</th><th>Créditos</th><th>Participação</th>' +
    '<th title="Renda dos últimos 12 meses dividida pelo custo da posição.">YoC 12m</th>' +
    "<th>Último</th></tr></thead><tbody>" +
    itens.map((i) => `<tr>
      <td><span class="ticker">${i.ticker}</span><span class="sub">${i.nome || ""}</span></td>
      <td><span class="etiqueta">${NOME_CLASSE[i.tipo] || i.tipo}</span></td>
      <td>${dinheiro.format(i.renda)}</td>
      <td>${i.amortizacao > 0 ? dinheiro.format(i.amortizacao) : "—"}</td>
      <td>${dinheiro.format(i.total)}</td>
      <td>${i.pagamentos}</td>
      <td>${percentual.format(i.participacao)}%</td>
      <td>${i.yield_on_cost === null ? "—" : `${percentual.format(i.yield_on_cost)}%`}</td>
      <td>${i.ultimo ? new Date(i.ultimo + "T12:00").toLocaleDateString("pt-BR") : "—"}</td>
    </tr>`).join("") + "</tbody>";
}

function renderizarCalendario(eventos) {
  const tabela = el("tabela-calendario");
  if (!eventos.length) {
    tabela.innerHTML =
      `<tbody><tr><td class="vazio">Nada anunciado por enquanto. Use "Buscar proventos" para carregar o calendário.</td></tr></tbody>`;
    return;
  }
  tabela.innerHTML =
    "<thead><tr><th>Ativo</th><th>Tipo</th><th>Data-com</th><th>Pagamento</th>" +
    "<th>Por cota</th><th>Quantidade</th><th>Você recebe</th><th></th></tr></thead><tbody>" +
    eventos.map((e) => `<tr>
      <td><span class="ticker">${e.ticker}</span></td>
      <td>${NOME_PROVENTO[e.tipo] || e.tipo}</td>
      <td>${e.data_com ? new Date(e.data_com + "T12:00").toLocaleDateString("pt-BR") : "—"}</td>
      <td>${e.data_pagamento ? new Date(e.data_pagamento + "T12:00").toLocaleDateString("pt-BR") : "—"}</td>
      <td>${dinheiro.format(e.valor_por_cota)}</td>
      <td>${numero.format(e.quantidade)}</td>
      <td>${dinheiro.format(e.valor_estimado)}</td>
      <td>${e.ja_tem_direito ? '<span class="etiqueta">direito garantido</span>' : ""}</td>
    </tr>`).join("") + "</tbody>";
}

/* ---------- Avisos ---------- */

function renderizarAvisos(config, resumo) {
  const lista = [];
  if (!config.pluggy) {
    lista.push({
      classe: "",
      html: "<strong>Open Finance desligado.</strong> Crie a conta gratuita em " +
        '<a href="https://meu.pluggy.ai" target="_blank" rel="noopener">meu.pluggy.ai</a>, ' +
        "conecte B3, Nubank e Inter, e ponha <code>PLUGGY_CLIENT_ID</code> e " +
        "<code>PLUGGY_CLIENT_SECRET</code> no <code>.env</code>. É gratuito para até 5 conexões.",
    });
  }
  if (!config.brapi_token) {
    lista.push({
      classe: "",
      html: "<strong>Cotações sem token.</strong> A brapi.dev exige token no plano gratuito. " +
        'Pegue um em <a href="https://brapi.dev/dashboard" target="_blank" rel="noopener">brapi.dev/dashboard</a> ' +
        "e ponha em <code>BRAPI_TOKEN</code>.",
    });
  }
  if (resumo.sem_cotacao?.length) {
    lista.push({
      classe: "",
      html: `<strong>Sem cotação para ${resumo.sem_cotacao.length} ativo(s):</strong> ` +
        `${resumo.sem_cotacao.join(", ")}. O valor atual deles está considerado igual ao custo.`,
    });
  }
  el("avisos").innerHTML = lista.map((a) =>
    `<div class="aviso ${a.classe}"><div>${a.html}</div></div>`
  ).join("");
}

function mostrarRecado(texto, classe = "ok") {
  const caixa = document.createElement("div");
  caixa.className = `aviso ${classe}`;
  caixa.innerHTML = `<div>${texto}</div>`;
  el("avisos").prepend(caixa);
  setTimeout(() => caixa.remove(), 9000);
}

/* ---------- Carga ---------- */

const buscar = (caminho) => fetch(caminho).then((r) => r.json());

let ultimoEstado = null;

async function carregar() {
  const [config, resumo, proventos, mensal, posicoes, pagadores, calendario] = await Promise.all([
    buscar("/api/config"),
    buscar("/api/resumo"),
    buscar("/api/proventos/resumo"),
    buscar("/api/proventos/mensal?meses=24"),
    buscar("/api/posicoes"),
    buscar("/api/proventos/por-ativo?meses=12"),
    buscar("/api/proventos/calendario"),
  ]);

  ultimoEstado = { resumo, mensal, pagadores };

  el("subtitulo").textContent =
    `${resumo.quantidade_ativos} ativos · ${dinheiro.format(resumo.valor_atual)} · ` +
    `${dinheiro.format(proventos.total_geral)} em proventos desde o início`;

  renderizarAvisos(config, resumo);
  renderizarTiles(resumo, proventos);
  desenharMensal(mensal);

  const alocacao = Object.entries(resumo.por_tipo).map(([tipo, dados]) => ({
    rotulo: NOME_CLASSE[tipo] || tipo,
    valor: dados.valor,
    sufixo: `${percentual.format(dados.percentual)}%`,
    detalhes: [
      ["Valor atual", dinheiro.format(dados.valor)],
      ["Custo", dinheiro.format(dados.custo)],
      ["Proventos", dinheiro.format(dados.proventos)],
      ["Ativos", String(dados.ativos)],
    ],
  }));
  desenharBarrasHorizontais("grafico-alocacao", alocacao, { coresPorItem: true });

  desenharBarrasHorizontais(
    "grafico-pagadores",
    pagadores.slice(0, 8).map((p) => ({
      rotulo: p.ticker,
      valor: p.total,
      detalhes: [
        ["Renda", dinheiro.format(p.renda)],
        ["Amortização", dinheiro.format(p.amortizacao)],
        ["Créditos", String(p.pagamentos)],
        ["Yield on cost", p.yield_on_cost === null ? "—" : `${percentual.format(p.yield_on_cost)}%`],
      ],
    })),
  );

  el("subtitulo-posicao").textContent =
    resumo.sem_cotacao.length
      ? `${posicoes.length} ativos. ${resumo.sem_cotacao.length} sem cotação atualizada.`
      : `${posicoes.length} ativos, todos com cotação.`;

  renderizarPosicoes(posicoes);
  renderizarPagadores(pagadores);
  renderizarCalendario(calendario);
}

/* ---------- Acoes ---------- */

function ligarBotao(id, caminho, aoTerminar) {
  el(id).addEventListener("click", async (evento) => {
    const botao = evento.currentTarget;
    const original = botao.textContent;
    botao.disabled = true;
    botao.textContent = "...";
    try {
      const resposta = await fetch(caminho, { method: "POST" });
      const corpo = await resposta.json();
      if (!resposta.ok) throw new Error(corpo.detail || "falhou");
      mostrarRecado(aoTerminar(corpo));
      await carregar();
    } catch (erro) {
      mostrarRecado(`<strong>Não deu certo.</strong> ${erro.message}`, "erro");
    } finally {
      botao.disabled = false;
      botao.textContent = original;
    }
  });
}

ligarBotao("btn-cotacoes", "/api/sincronizar/cotacoes", (r) =>
  `<strong>${r.atualizados} cotações atualizadas.</strong> ${r.avisos.join(" ")}`);

ligarBotao("btn-proventos", "/api/sincronizar/proventos", (r) =>
  `<strong>${r.novos} proventos anunciados carregados.</strong> ${r.avisos.slice(0, 2).join(" ")}`);

ligarBotao("btn-pluggy", "/api/sincronizar/pluggy", (r) =>
  `<strong>${r.novos} movimentações novas</strong> de ${r.conexoes} conexões. ${r.avisos.slice(0, 2).join(" ")}`);

el("btn-tema").addEventListener("click", () => {
  const atual = document.documentElement.getAttribute("data-tema");
  const proximo = atual === "escuro" ? "claro" : "escuro";
  document.documentElement.setAttribute("data-tema", proximo);
  try { localStorage.setItem("tema", proximo); } catch {}
  /* Os graficos leem a cor do CSS, entao precisam ser redesenhados. */
  if (ultimoEstado) carregar();
});

try {
  const salvo = localStorage.getItem("tema");
  if (salvo) document.documentElement.setAttribute("data-tema", salvo);
} catch {}

let redimensionando;
window.addEventListener("resize", () => {
  clearTimeout(redimensionando);
  redimensionando = setTimeout(() => { if (ultimoEstado) carregar(); }, 200);
});

carregar().catch((erro) => {
  el("subtitulo").textContent = "Não consegui carregar os dados.";
  mostrarRecado(`<strong>Erro ao carregar.</strong> ${erro.message}`, "erro");
});
