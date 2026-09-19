"""Importador do Excel de Movimentacao da B3.

A planilha de teste e montada com as mesmas colunas e os mesmos rotulos que a
Area do Investidor exporta, incluindo o formato brasileiro de numero e o traco
que a B3 usa em celula vazia.
"""
from __future__ import annotations

import io
from datetime import date
from decimal import Decimal

from openpyxl import Workbook
from sqlmodel import select

from app.carteira import calcular_posicoes
from app.importadores.b3_movimentacao import importar, separa_produto
from app.models import Movimentacao, TipoMovimento

CABECALHO = [
    "Entrada/Saída", "Data", "Movimentação", "Produto", "Instituição",
    "Quantidade", "Preço unitário", "Valor da Operação",
]

LINHAS = [
    ["Credito", "05/01/2026", "Transferência - Liquidação", "PETR4 - PETROLEO BRASILEIRO S.A.",
     "NU INVEST CORRETORA", 100, "R$ 30,00", "R$ 3.000,00"],
    ["Credito", "10/02/2026", "Dividendo", "PETR4 - PETROLEO BRASILEIRO S.A.",
     "NU INVEST CORRETORA", "-", "-", "R$ 142,00"],
    ["Credito", "15/02/2026", "Juros Sobre Capital Próprio", "BBAS3 - BANCO DO BRASIL S.A.",
     "INTER DTVM", "-", "-", "R$ 85,00"],
    ["Credito", "08/02/2026", "Transferência - Liquidação", "MXRF11 - MAXI RENDA FDO INV IMOB",
     "NU INVEST CORRETORA", 900, "R$ 10,00", "R$ 9.000,00"],
    ["Credito", "20/02/2026", "Rendimento", "MXRF11 - MAXI RENDA FDO INV IMOB",
     "NU INVEST CORRETORA", "-", "-", "R$ 90,00"],
    ["Credito", "20/03/2026", "Amortização", "MXRF11 - MAXI RENDA FDO INV IMOB",
     "NU INVEST CORRETORA", "-", "-", "R$ 40,00"],
    ["Debito", "25/03/2026", "Transferência - Liquidação", "PETR4 - PETROLEO BRASILEIRO S.A.",
     "NU INVEST CORRETORA", 40, "R$ 35,00", "R$ 1.400,00"],
    ["Credito", "01/04/2026", "Desdobro", "PETR4 - PETROLEO BRASILEIRO S.A.",
     "NU INVEST CORRETORA", 60, "-", "-"],
    ["Credito", "10/04/2026", "Bonificação em Ativos", "ITSA4 - ITAUSA S.A.",
     "INTER DTVM", 10, "-", "R$ 0,00"],
]


def planilha(linhas=None, *, com_titulo=False) -> io.BytesIO:
    livro = Workbook()
    aba = livro.active
    if com_titulo:
        # A B3 as vezes exporta com linhas soltas antes da tabela.
        aba.append(["Relatório de Movimentação"])
        aba.append([])
    aba.append(CABECALHO)
    for linha in linhas if linhas is not None else LINHAS:
        aba.append(linha)
    buffer = io.BytesIO()
    livro.save(buffer)
    buffer.seek(0)
    return buffer


def test_le_todas_as_linhas(sessao):
    resultado = importar(sessao, planilha())
    assert resultado.linhas_lidas == len(LINHAS)
    assert resultado.novos == len(LINHAS)
    assert resultado.avisos == []


def test_reimportar_o_mesmo_arquivo_nao_duplica(sessao):
    importar(sessao, planilha())
    segundo = importar(sessao, planilha())
    assert segundo.novos == 0
    assert segundo.duplicados == len(LINHAS)
    assert len(sessao.exec(select(Movimentacao)).all()) == len(LINHAS)


def test_cabecalho_deslocado_e_encontrado(sessao):
    resultado = importar(sessao, planilha(com_titulo=True))
    assert resultado.novos == len(LINHAS)


def test_sentido_decide_compra_ou_venda(sessao):
    importar(sessao, planilha())
    tipos = {
        (m.tipo, m.data)
        for m in sessao.exec(select(Movimentacao)).all()
    }
    assert (TipoMovimento.COMPRA, date(2026, 1, 5)) in tipos
    assert (TipoMovimento.VENDA, date(2026, 3, 25)) in tipos


def test_proventos_viram_os_tipos_certos(sessao):
    importar(sessao, planilha())
    por_tipo = {m.tipo: m.valor_liquido for m in sessao.exec(select(Movimentacao)).all()}
    assert por_tipo[TipoMovimento.DIVIDENDO] == Decimal("142.00")
    assert por_tipo[TipoMovimento.JCP] == Decimal("85.00")
    assert por_tipo[TipoMovimento.RENDIMENTO] == Decimal("90.00")
    assert por_tipo[TipoMovimento.AMORTIZACAO] == Decimal("40.00")


def test_posicao_resultante_bate(sessao):
    importar(sessao, planilha())
    posicoes = {p.ticker: p for p in calcular_posicoes(sessao)}

    # Comprou 100, vendeu 40, desdobrou 60: sobram 120.
    petr = posicoes["PETR4"]
    assert petr.quantidade == Decimal(120)
    # Custo: 3000 menos os 1200 baixados pelo medio de 30 nas 40 vendidas.
    assert petr.custo_total == Decimal("1800")
    assert petr.preco_medio == Decimal("15.00000000")

    mxrf = posicoes["MXRF11"]
    assert mxrf.quantidade == Decimal(900)
    assert mxrf.proventos_renda == Decimal("90.00")
    assert mxrf.amortizacoes == Decimal("40.00")
    # A amortizacao devolveu 40 do principal, entao o custo cai de 9000 para 8960.
    assert mxrf.custo_total == Decimal("8960.00")


def test_instituicao_vira_conta_separada(sessao):
    importar(sessao, planilha())
    posicoes = {p.ticker: p for p in calcular_posicoes(sessao)}
    assert posicoes["PETR4"].contas == {"NU INVEST CORRETORA"}
    assert posicoes["ITSA4"].contas == {"INTER DTVM"}


def test_movimentacao_desconhecida_vira_aviso_sem_travar(sessao):
    linhas = LINHAS + [
        ["Credito", "05/05/2026", "Evento Que Nao Existe", "PETR4 - PETROLEO BRASILEIRO S.A.",
         "NU INVEST CORRETORA", 5, "-", "R$ 50,00"],
    ]
    resultado = importar(sessao, planilha(linhas))
    assert resultado.novos == len(linhas)
    assert any("Evento Que Nao Existe" in a for a in resultado.avisos)


def test_planilha_errada_avisa_em_vez_de_explodir(sessao):
    livro_errado = planilha([["qualquer", "coisa"]])
    import openpyxl
    livro = openpyxl.Workbook()
    livro.active.append(["Coluna A", "Coluna B"])
    buffer = io.BytesIO()
    livro.save(buffer)
    buffer.seek(0)
    resultado = importar(sessao, buffer)
    assert resultado.novos == 0
    assert any("Colunas obrigatorias ausentes" in a for a in resultado.avisos)


def test_separa_produto():
    assert separa_produto("PETR4 - PETROLEO BRASILEIRO S.A.") == ("PETR4", "PETROLEO BRASILEIRO S.A.")
    # Tesouro nao tem ticker; o nome inteiro vira identificador.
    assert separa_produto("Tesouro Selic 2029")[0] == "TESOURO SELIC 2029"
