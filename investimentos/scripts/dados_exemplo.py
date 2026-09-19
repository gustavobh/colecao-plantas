"""Popula o banco com uma carteira ficticia, para conhecer o app sem expor dado real.

Rode com:

    python scripts/dados_exemplo.py          # cria o banco de demonstracao
    python scripts/dados_exemplo.py --limpar # apaga tudo antes de recriar

A carteira imita o perfil comum de investidor brasileiro: acoes pagadoras, FIIs
de tijolo e papel, ETF no Brasil e nos EUA, e renda fixa em duas instituicoes.
Os proventos seguem o ritmo real de cada classe, que e o que faz o grafico
mensal ter a cara certa: FII paga todo mes, acao paga em bloco, ETF americano
paga a cada trimestre.
"""
from __future__ import annotations

import argparse
import random
import sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlmodel import Session, delete, select  # noqa: E402

from app.db import criar_tabelas, engine, obter_ou_criar_ativo, obter_ou_criar_conta, registrar_movimentacao  # noqa: E402
from app.models import (  # noqa: E402
    Ativo,
    Conta,
    Cotacao,
    Fonte,
    IndicadorEconomico,
    Instituicao,
    LogSincronizacao,
    Movimentacao,
    PosicaoInformada,
    ProventoAnunciado,
    TipoAtivo,
    TipoMovimento,
)

SEMENTE = 20260919
HOJE = date(2026, 9, 19)

# ticker, nome, tipo, conta, quantidade, preco de compra, cotacao atual,
# provento por cota, ritmo de pagamento
CARTEIRA = [
    # (ticker, nome, tipo, conta, qtd, custo_unit, preco_hoje, provento_cota, ritmo)
    ("ITSA4", "ITAUSA S.A.", TipoAtivo.ACAO, "B3 via Nubank", 1200, "9.42", "11.87", "0.19", "trimestral"),
    ("BBAS3", "BANCO DO BRASIL S.A.", TipoAtivo.ACAO, "B3 via Nubank", 400, "26.10", "28.94", "0.78", "trimestral"),
    ("TAEE11", "TAESA S.A.", TipoAtivo.ACAO, "B3 via Nubank", 300, "34.85", "37.20", "0.94", "semestral"),
    ("PETR4", "PETROLEO BRASILEIRO S.A.", TipoAtivo.ACAO, "B3 via Inter", 250, "33.70", "38.15", "1.42", "trimestral"),
    ("VALE3", "VALE S.A.", TipoAtivo.ACAO, "B3 via Inter", 180, "61.20", "58.40", "1.85", "semestral"),
    ("MXRF11", "MAXI RENDA FII", TipoAtivo.FII, "B3 via Nubank", 900, "10.18", "10.42", "0.10", "mensal"),
    ("HGLG11", "CSHG LOGISTICA FII", TipoAtivo.FII, "B3 via Nubank", 110, "158.40", "164.90", "1.15", "mensal"),
    ("KNRI11", "KINEA RENDA IMOBILIARIA FII", TipoAtivo.FII, "B3 via Inter", 95, "152.70", "149.30", "0.95", "mensal"),
    ("XPML11", "XP MALLS FII", TipoAtivo.FII, "B3 via Inter", 140, "104.60", "112.10", "0.86", "mensal"),
    ("BOVA11", "ISHARES IBOVESPA ETF", TipoAtivo.ETF_BR, "B3 via Nubank", 60, "118.30", "134.75", "0.00", "nenhum"),
    ("IVVB11", "ISHARES SP500 ETF", TipoAtivo.ETF_BR, "B3 via Nubank", 45, "342.00", "398.60", "0.00", "nenhum"),
    ("VOO", "VANGUARD S&P 500 ETF", TipoAtivo.ETF_US, "Avenue", 12, "442.00", "588.00", "1.78", "trimestral"),
    ("SCHD", "SCHWAB US DIVIDEND EQUITY ETF", TipoAtivo.ETF_US, "Avenue", 200, "25.60", "29.15", "0.27", "trimestral"),
]

RENDA_FIXA = [
    ("CDB INTER 110% CDI 2028", TipoAtivo.RENDA_FIXA, "Inter", "12000.00", "13840.00", "juros_semestral", "310.00"),
    ("TESOURO SELIC 2029", TipoAtivo.TESOURO, "B3 via Nubank", "8000.00", "9120.00", "nenhum", "0"),
    ("CDB NUBANK 102% CDI", TipoAtivo.RENDA_FIXA, "Nubank", "5500.00", "6180.00", "nenhum", "0"),
]

CONTAS = {
    "B3 via Nubank": Instituicao.NUBANK,
    "B3 via Inter": Instituicao.INTER,
    "Nubank": Instituicao.NUBANK,
    "Inter": Instituicao.INTER,
    "Avenue": Instituicao.OUTRA,
}

#: Meses em que cada ritmo paga. FII paga todo mes; acao concentra em blocos.
MESES_DO_RITMO = {
    "mensal": set(range(1, 13)),
    "trimestral": {3, 6, 9, 12},
    "semestral": {5, 11},
    "nenhum": set(),
}


def _tipo_provento(tipo_ativo: TipoAtivo, mes: int) -> TipoMovimento:
    if tipo_ativo == TipoAtivo.FII:
        # Um mes por ano vem como amortizacao, que e o que acontece de verdade
        # e e justamente o caso que o painel precisa separar do rendimento.
        return TipoMovimento.AMORTIZACAO if mes == 12 else TipoMovimento.RENDIMENTO
    if tipo_ativo in (TipoAtivo.ETF_US, TipoAtivo.STOCK_US):
        return TipoMovimento.DIVIDENDO
    # Acao brasileira alterna dividendo e JCP.
    return TipoMovimento.JCP if mes in (6, 12) else TipoMovimento.DIVIDENDO


def limpar(sessao: Session) -> None:
    for tabela in (
        Movimentacao, Cotacao, ProventoAnunciado, PosicaoInformada,
        IndicadorEconomico, LogSincronizacao, Ativo, Conta,
    ):
        sessao.exec(delete(tabela))
    sessao.commit()


def popular(sessao: Session) -> dict:
    aleatorio = random.Random(SEMENTE)
    inicio = date(HOJE.year - 3, 1, 15)
    contadores = {"compras": 0, "proventos": 0, "ativos": 0}

    for nome_conta, instituicao in CONTAS.items():
        obter_ou_criar_conta(sessao, nome_conta, instituicao=instituicao)

    for ticker, nome, tipo, nome_conta, qtd, custo, preco_hoje, provento_cota, ritmo in CARTEIRA:
        conta = obter_ou_criar_conta(sessao, nome_conta, instituicao=CONTAS[nome_conta])
        moeda = "USD" if tipo == TipoAtivo.ETF_US else "BRL"
        ativo = obter_ou_criar_ativo(sessao, ticker, nome=nome, tipo=tipo, moeda=moeda)
        contadores["ativos"] += 1

        # Tres aportes ao longo do tempo, para o preco medio ter historia.
        parcelas = [Decimal(qtd) * Decimal(f) for f in ("0.5", "0.3", "0.2")]
        for indice, parcela in enumerate(parcelas):
            data_compra = inicio + timedelta(days=indice * 320 + aleatorio.randint(0, 40))
            variacao = Decimal(str(1 + (indice - 1) * 0.06))
            preco = (Decimal(custo) * variacao).quantize(Decimal("0.01"))
            quantidade = parcela.quantize(Decimal("1"))
            if registrar_movimentacao(
                sessao,
                Movimentacao(
                    data=data_compra,
                    conta_id=conta.id,
                    ativo_id=ativo.id,
                    tipo=TipoMovimento.COMPRA,
                    quantidade=quantidade,
                    preco_unitario=preco,
                    valor_bruto=quantidade * preco,
                    valor_liquido=quantidade * preco,
                    moeda=moeda,
                    fonte=Fonte.B3_MOVIMENTACAO if nome_conta.startswith("B3") else Fonte.PLUGGY,
                    descricao="Compra",
                ),
            ):
                contadores["compras"] += 1

        # Proventos mes a mes, respeitando o ritmo da classe.
        if ritmo != "nenhum" and Decimal(provento_cota) > 0:
            meses = MESES_DO_RITMO[ritmo]
            cursor = inicio.replace(day=15)
            while cursor <= HOJE:
                if cursor.month in meses and cursor > inicio + timedelta(days=30):
                    # Quantidade que ja estava em carteira na data do pagamento.
                    detida = sum(
                        (Decimal(qtd) * Decimal(f)).quantize(Decimal("1"))
                        for indice, f in enumerate(("0.5", "0.3", "0.2"))
                        if inicio + timedelta(days=indice * 320) <= cursor
                    )
                    if detida > 0:
                        # Distribuicao oscila, e cresce de leve ao longo do tempo.
                        anos = (cursor - inicio).days / 365
                        fator = Decimal(str(round(aleatorio.uniform(0.82, 1.18) * (1 + 0.05 * anos), 4)))
                        por_cota = (Decimal(provento_cota) * fator).quantize(Decimal("0.0001"))
                        tipo_prov = _tipo_provento(tipo, cursor.month)
                        bruto = (detida * por_cota).quantize(Decimal("0.01"))
                        ir = (bruto * Decimal("0.15")).quantize(Decimal("0.01")) if tipo_prov == TipoMovimento.JCP else Decimal(0)
                        if registrar_movimentacao(
                            sessao,
                            Movimentacao(
                                data=cursor,
                                conta_id=conta.id,
                                ativo_id=ativo.id,
                                tipo=tipo_prov,
                                quantidade=Decimal(0),
                                valor_bruto=bruto,
                                ir_retido=ir,
                                valor_liquido=bruto - ir,
                                moeda=moeda,
                                fonte=Fonte.B3_MOVIMENTACAO if nome_conta.startswith("B3") else Fonte.PLUGGY,
                                descricao=tipo_prov.value.title(),
                            ),
                        ):
                            contadores["proventos"] += 1
                cursor = (cursor.replace(day=28) + timedelta(days=4)).replace(day=15)

        # Cotacao de hoje.
        sessao.add(
            Cotacao(ativo_id=ativo.id, data=HOJE, fechamento=Decimal(preco_hoje), moeda=moeda, fonte="exemplo")
        )

        # Um provento anunciado e ainda nao pago, para o calendario ter conteudo.
        if ritmo in ("mensal", "trimestral") and Decimal(provento_cota) > 0:
            sessao.add(
                ProventoAnunciado(
                    ativo_id=ativo.id,
                    tipo=_tipo_provento(tipo, HOJE.month),
                    data_com=HOJE + timedelta(days=aleatorio.randint(-4, 9)),
                    data_pagamento=HOJE + timedelta(days=aleatorio.randint(12, 34)),
                    valor_por_cota=Decimal(provento_cota),
                    moeda=moeda,
                    fonte="exemplo",
                )
            )

    # Renda fixa: aplicacao unica e cupom quando houver.
    for nome, tipo, nome_conta, aplicado, valor_hoje, ritmo, cupom in RENDA_FIXA:
        conta = obter_ou_criar_conta(sessao, nome_conta, instituicao=CONTAS[nome_conta])
        ativo = obter_ou_criar_ativo(sessao, nome, nome=nome, tipo=tipo, moeda="BRL")
        contadores["ativos"] += 1
        data_aplicacao = inicio + timedelta(days=aleatorio.randint(10, 200))
        registrar_movimentacao(
            sessao,
            Movimentacao(
                data=data_aplicacao,
                conta_id=conta.id,
                ativo_id=ativo.id,
                tipo=TipoMovimento.APLICACAO,
                quantidade=Decimal(1),
                preco_unitario=Decimal(aplicado),
                valor_bruto=Decimal(aplicado),
                valor_liquido=Decimal(aplicado),
                fonte=Fonte.PLUGGY,
                descricao="Aplicacao",
            ),
        )
        contadores["compras"] += 1

        if ritmo == "juros_semestral":
            cursor = data_aplicacao + timedelta(days=180)
            while cursor <= HOJE:
                if registrar_movimentacao(
                    sessao,
                    Movimentacao(
                        data=cursor,
                        conta_id=conta.id,
                        ativo_id=ativo.id,
                        tipo=TipoMovimento.JUROS,
                        quantidade=Decimal(0),
                        valor_bruto=Decimal(cupom),
                        valor_liquido=Decimal(cupom),
                        fonte=Fonte.PLUGGY,
                        descricao="Juros semestrais",
                    ),
                ):
                    contadores["proventos"] += 1
                cursor += timedelta(days=182)

        sessao.add(
            Cotacao(ativo_id=ativo.id, data=HOJE, fechamento=Decimal(valor_hoje), moeda="BRL", fonte="exemplo")
        )

    sessao.add(IndicadorEconomico(codigo="PTAX_USD", data=HOJE, valor=Decimal("5.38")))
    sessao.commit()
    return contadores


def main() -> None:
    analisador = argparse.ArgumentParser(description="Popula o banco com uma carteira de exemplo.")
    analisador.add_argument("--limpar", action="store_true", help="apaga os dados antes de popular")
    argumentos = analisador.parse_args()

    criar_tabelas()
    with Session(engine) as sessao:
        if argumentos.limpar:
            limpar(sessao)
        elif sessao.exec(select(Movimentacao).limit(1)).first():
            print("O banco ja tem dados. Use --limpar para recriar do zero.")
            return
        contadores = popular(sessao)

    print(
        f"Carteira de exemplo criada: {contadores['ativos']} ativos, "
        f"{contadores['compras']} aportes, {contadores['proventos']} proventos."
    )
    print("Suba o painel com: uvicorn app.main:app --reload")


if __name__ == "__main__":
    main()
