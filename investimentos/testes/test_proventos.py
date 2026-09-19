"""Agregacoes de proventos: serie mensal, ranking, resumo e calendario."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app import proventos as servico
from app.db import obter_ou_criar_ativo, obter_ou_criar_conta, registrar_movimentacao
from app.models import IndicadorEconomico, Movimentacao, ProventoAnunciado, TipoAtivo, TipoMovimento

HOJE = date(2026, 9, 19)


def pagar(sessao, ticker, dia, valor, tipo=TipoMovimento.DIVIDENDO, *, moeda="BRL", tipo_ativo=None):
    conta = obter_ou_criar_conta(sessao, "Teste")
    ativo = obter_ou_criar_ativo(sessao, ticker, tipo=tipo_ativo, moeda=moeda)
    registrar_movimentacao(
        sessao,
        Movimentacao(
            data=dia, conta_id=conta.id, ativo_id=ativo.id, tipo=tipo,
            valor_bruto=Decimal(valor), valor_liquido=Decimal(valor), moeda=moeda,
        ),
    )
    sessao.commit()
    return ativo


def test_meses_sem_pagamento_aparecem_zerados(sessao):
    """Sem o zero, o grafico liga meses distantes como se fossem vizinhos."""
    pagar(sessao, "PETR4", date(2026, 7, 10), "100")
    serie = servico.serie_mensal(sessao, meses=6, ate=HOJE)

    assert [m.mes for m in serie] == ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]
    assert [m.total for m in serie] == [Decimal("0.00")] * 3 + [Decimal("100.00"), Decimal("0.00"), Decimal("0.00")]


def test_serie_separa_renda_de_amortizacao(sessao):
    pagar(sessao, "MXRF11", date(2026, 9, 10), "80", TipoMovimento.RENDIMENTO, tipo_ativo=TipoAtivo.FII)
    pagar(sessao, "MXRF11", date(2026, 9, 12), "30", TipoMovimento.AMORTIZACAO, tipo_ativo=TipoAtivo.FII)

    setembro = servico.serie_mensal(sessao, meses=1, ate=HOJE)[0]
    assert setembro.renda == Decimal("80.00")
    assert setembro.amortizacao == Decimal("30.00")
    assert setembro.total == Decimal("110.00")
    assert setembro.quantidade_pagamentos == 2


def test_ranking_ordena_por_total_e_calcula_participacao(sessao):
    pagar(sessao, "PETR4", date(2026, 8, 10), "300")
    pagar(sessao, "ITSA4", date(2026, 8, 10), "100")

    ranking = servico.por_ativo(sessao)
    assert [i.ticker for i in ranking] == ["PETR4", "ITSA4"]
    assert ranking[0].participacao == Decimal("75.00")
    assert ranking[1].participacao == Decimal("25.00")


def test_resumo_separa_renda_de_caixa(sessao):
    pagar(sessao, "HGLG11", date(2026, 8, 10), "200", TipoMovimento.RENDIMENTO, tipo_ativo=TipoAtivo.FII)
    pagar(sessao, "HGLG11", date(2026, 8, 12), "500", TipoMovimento.AMORTIZACAO, tipo_ativo=TipoAtivo.FII)

    resumo = servico.resumir(sessao, hoje=HOJE)
    assert resumo.total_12m == Decimal("700.00")   # tudo que entrou
    assert resumo.renda_12m == Decimal("200.00")   # so a renda
    # A projecao repete a renda, nunca a devolucao de principal.
    assert resumo.projecao_12m == Decimal("200.00")


def test_crescimento_compara_as_duas_janelas_de_doze_meses(sessao):
    pagar(sessao, "TAEE11", date(2024, 12, 10), "100")   # janela anterior
    pagar(sessao, "TAEE11", date(2026, 3, 10), "150")    # janela atual

    resumo = servico.resumir(sessao, hoje=HOJE)
    assert resumo.total_12m == Decimal("150.00")
    assert resumo.crescimento_12m == Decimal("50.00")


def test_media_mensal_divide_por_doze_e_nao_pelos_meses_pagos(sessao):
    """Um unico pagamento de 1200 no ano da media de 100, nao de 1200."""
    pagar(sessao, "VALE3", date(2026, 3, 10), "1200")
    resumo = servico.resumir(sessao, hoje=HOJE)
    assert resumo.media_mensal_12m == Decimal("100.00")


def test_provento_em_dolar_entra_convertido(sessao):
    pagar(sessao, "VOO", date(2026, 8, 10), "100", moeda="USD", tipo_ativo=TipoAtivo.ETF_US)
    sessao.add(IndicadorEconomico(codigo="PTAX_USD", data=date(2026, 8, 10), valor=Decimal("5")))
    sessao.commit()

    resumo = servico.resumir(sessao, hoje=HOJE)
    assert resumo.total_12m == Decimal("500.00")


def test_calendario_marca_quem_ja_tem_direito(sessao):
    ativo = pagar(sessao, "ITSA4", date(2026, 1, 10), "10")
    sessao.add_all([
        ProventoAnunciado(
            ativo_id=ativo.id, tipo=TipoMovimento.DIVIDENDO,
            data_com=date(2026, 9, 15), data_pagamento=date(2026, 10, 20),
            valor_por_cota=Decimal("0.20"),
        ),
        ProventoAnunciado(
            ativo_id=ativo.id, tipo=TipoMovimento.DIVIDENDO,
            data_com=date(2026, 9, 25), data_pagamento=date(2026, 11, 20),
            valor_por_cota=Decimal("0.30"),
        ),
    ])
    sessao.commit()

    eventos = servico.calendario(sessao, hoje=HOJE, quantidades={ativo.id: Decimal(1000)})
    assert [e.ja_tem_direito for e in eventos] == [True, False]
    assert eventos[0].valor_estimado == Decimal("200.00")
    assert eventos[1].valor_estimado == Decimal("300.00")


def test_calendario_ignora_o_que_ja_foi_pago(sessao):
    ativo = pagar(sessao, "BBAS3", date(2026, 1, 10), "10")
    sessao.add(
        ProventoAnunciado(
            ativo_id=ativo.id, tipo=TipoMovimento.DIVIDENDO,
            data_com=date(2026, 5, 1), data_pagamento=date(2026, 6, 1),
            valor_por_cota=Decimal("0.50"),
        )
    )
    sessao.commit()
    assert servico.calendario(sessao, hoje=HOJE) == []
