"""Preco medio, eventos societarios e conversao de moeda."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.carteira import calcular_posicoes, resumir
from app.db import obter_ou_criar_ativo, obter_ou_criar_conta, registrar_movimentacao
from app.models import IndicadorEconomico, Movimentacao, TipoAtivo, TipoMovimento


def lancar(sessao, ticker, tipo, dia, *, qtd="0", valor="0", moeda="BRL", tipo_ativo=None):
    conta = obter_ou_criar_conta(sessao, "Teste")
    ativo = obter_ou_criar_ativo(sessao, ticker, tipo=tipo_ativo, moeda=moeda)
    mov = Movimentacao(
        data=dia,
        conta_id=conta.id,
        ativo_id=ativo.id,
        tipo=tipo,
        quantidade=Decimal(qtd),
        valor_bruto=Decimal(valor),
        valor_liquido=Decimal(valor),
        moeda=moeda,
    )
    inserido = registrar_movimentacao(sessao, mov)
    sessao.commit()
    return inserido


def posicao_de(sessao, ticker):
    return next(p for p in calcular_posicoes(sessao, incluir_zeradas=True) if p.ticker == ticker)


def test_preco_medio_de_duas_compras(sessao):
    lancar(sessao, "PETR4", TipoMovimento.COMPRA, date(2026, 1, 5), qtd="100", valor="3000")
    lancar(sessao, "PETR4", TipoMovimento.COMPRA, date(2026, 2, 5), qtd="100", valor="4000")

    pos = posicao_de(sessao, "PETR4")
    assert pos.quantidade == Decimal(200)
    assert pos.preco_medio == Decimal("35.00000000")


def test_venda_nao_altera_preco_medio(sessao):
    """Regra brasileira: venda baixa custo pelo medio e o medio fica igual."""
    lancar(sessao, "VALE3", TipoMovimento.COMPRA, date(2026, 1, 5), qtd="100", valor="5000")
    lancar(sessao, "VALE3", TipoMovimento.COMPRA, date(2026, 2, 5), qtd="100", valor="7000")
    lancar(sessao, "VALE3", TipoMovimento.VENDA, date(2026, 3, 5), qtd="50", valor="3500")

    pos = posicao_de(sessao, "VALE3")
    assert pos.quantidade == Decimal(150)
    assert pos.preco_medio == Decimal("60.00000000")
    # Vendeu 50 a 70 com medio de 60, entao realizou 500.
    assert pos.lucro_realizado == Decimal("500")


def test_desdobramento_derruba_o_preco_medio_sem_mexer_no_custo(sessao):
    lancar(sessao, "ITSA4", TipoMovimento.COMPRA, date(2026, 1, 5), qtd="100", valor="1000")
    # Desdobramento 1:1 entrega mais 100 papeis sem custo nenhum.
    lancar(sessao, "ITSA4", TipoMovimento.DESDOBRAMENTO, date(2026, 6, 1), qtd="100")

    pos = posicao_de(sessao, "ITSA4")
    assert pos.quantidade == Decimal(200)
    assert pos.custo_total == Decimal("1000")
    assert pos.preco_medio == Decimal("5.00000000")


def test_grupamento_sobe_o_preco_medio(sessao):
    lancar(sessao, "OIBR3", TipoMovimento.COMPRA, date(2026, 1, 5), qtd="1000", valor="1000")
    lancar(sessao, "OIBR3", TipoMovimento.GRUPAMENTO, date(2026, 6, 1), qtd="900")

    pos = posicao_de(sessao, "OIBR3")
    assert pos.quantidade == Decimal(100)
    assert pos.preco_medio == Decimal("10.00000000")


def test_amortizacao_reduz_custo_e_fica_fora_do_yield(sessao):
    """O ponto que mais engana em carteira de FII."""
    lancar(sessao, "MXRF11", TipoMovimento.COMPRA, date(2026, 1, 5), qtd="1000", valor="10000",
           tipo_ativo=TipoAtivo.FII)
    lancar(sessao, "MXRF11", TipoMovimento.RENDIMENTO, date(2026, 2, 15), valor="100")
    lancar(sessao, "MXRF11", TipoMovimento.AMORTIZACAO, date(2026, 3, 15), valor="500")

    pos = posicao_de(sessao, "MXRF11")
    assert pos.proventos_recebidos == Decimal("600")   # tudo que pingou no caixa
    assert pos.proventos_renda == Decimal("100")        # so o que e renda
    assert pos.amortizacoes == Decimal("500")
    assert pos.custo_total == Decimal("9500")           # principal devolvido
    # Yield olha so a renda: 100 sobre 9500, e nao 600.
    assert pos.yield_on_cost == Decimal("1.0526")


def test_jcp_entra_liquido_do_imposto(sessao):
    conta = obter_ou_criar_conta(sessao, "Teste")
    ativo = obter_ou_criar_ativo(sessao, "BBAS3")
    registrar_movimentacao(
        sessao,
        Movimentacao(
            data=date(2026, 5, 10), conta_id=conta.id, ativo_id=ativo.id,
            tipo=TipoMovimento.JCP, valor_bruto=Decimal("1000"),
            ir_retido=Decimal("150"), valor_liquido=Decimal("850"),
        ),
    )
    sessao.commit()
    assert posicao_de(sessao, "BBAS3").proventos_renda == Decimal("850")


def test_transferencia_sem_custo_marca_posicao_como_incompleta(sessao):
    lancar(sessao, "WEGE3", TipoMovimento.TRANSFERENCIA_ENTRADA, date(2026, 1, 5), qtd="100")
    pos = posicao_de(sessao, "WEGE3")
    assert pos.quantidade == Decimal(100)
    assert pos.custo_incompleto is True


def test_venda_sem_posicao_nao_quebra(sessao):
    """Historico parcial e o caso normal de quem so importou o ultimo ano."""
    lancar(sessao, "MGLU3", TipoMovimento.VENDA, date(2026, 3, 5), qtd="100", valor="900")
    pos = posicao_de(sessao, "MGLU3")
    assert pos.quantidade == Decimal(0)
    assert pos.custo_incompleto is True


def test_dolar_e_convertido_antes_de_somar(sessao):
    lancar(sessao, "PETR4", TipoMovimento.COMPRA, date(2026, 1, 5), qtd="100", valor="3000")
    lancar(sessao, "VOO", TipoMovimento.COMPRA, date(2026, 1, 5), qtd="10", valor="5000",
           moeda="USD", tipo_ativo=TipoAtivo.ETF_US)
    sessao.add(IndicadorEconomico(codigo="PTAX_USD", data=date(2026, 1, 5), valor=Decimal("5")))
    sessao.commit()

    consolidado = resumir(calcular_posicoes(sessao))
    # 3000 em reais mais 5000 dolares a 5,00 dao 28000, nao 8000.
    assert consolidado.valor_investido == Decimal("28000.00")
    assert consolidado.cambio_ausente == []


def test_moeda_sem_taxa_e_denunciada(sessao):
    lancar(sessao, "VOO", TipoMovimento.COMPRA, date(2026, 1, 5), qtd="10", valor="5000",
           moeda="USD", tipo_ativo=TipoAtivo.ETF_US)
    consolidado = resumir(calcular_posicoes(sessao))
    assert consolidado.cambio_ausente == ["USD"]


def test_importacao_repetida_nao_duplica(sessao):
    assert lancar(sessao, "PETR4", TipoMovimento.DIVIDENDO, date(2026, 5, 10), valor="120") is True
    assert lancar(sessao, "PETR4", TipoMovimento.DIVIDENDO, date(2026, 5, 10), valor="120") is False
    assert posicao_de(sessao, "PETR4").proventos_renda == Decimal("120")
