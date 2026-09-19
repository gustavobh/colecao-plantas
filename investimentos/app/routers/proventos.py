"""Endpoints de acompanhamento de proventos."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session

from app import proventos as servico
from app.carteira import calcular_posicoes
from app.db import get_session

router = APIRouter(prefix="/api/proventos", tags=["proventos"])


@router.get("/resumo")
def resumo(sessao: Session = Depends(get_session)) -> dict:
    dados = servico.resumir(sessao)
    return {
        "total_geral": dados.total_geral,
        "total_12m": dados.total_12m,
        "renda_12m": dados.renda_12m,
        "total_ano": dados.total_ano,
        "total_mes": dados.total_mes,
        "media_mensal_12m": dados.media_mensal_12m,
        "melhor_mes": dados.melhor_mes,
        "melhor_mes_valor": dados.melhor_mes_valor,
        "meses_com_pagamento": dados.meses_com_pagamento,
        "ativos_pagadores": dados.ativos_pagadores,
        "projecao_12m": dados.projecao_12m,
        "crescimento_12m": dados.crescimento_12m,
    }


@router.get("/mensal")
def mensal(
    meses: int = Query(24, ge=1, le=240),
    sessao: Session = Depends(get_session),
) -> list[dict]:
    return [
        {
            "mes": m.mes,
            "total": m.total,
            "renda": m.renda,
            "amortizacao": m.amortizacao,
            "pagamentos": m.quantidade_pagamentos,
            "por_tipo": m.por_tipo,
        }
        for m in servico.serie_mensal(sessao, meses=meses)
    ]


@router.get("/por-ativo")
def por_ativo(
    meses: Optional[int] = Query(None, ge=1, le=240, description="Janela; vazio traz tudo"),
    sessao: Session = Depends(get_session),
) -> list[dict]:
    desde = servico._meses_atras(date.today().replace(day=1), meses - 1) if meses else None
    itens = servico.por_ativo(sessao, desde=desde)

    # Yield on cost precisa do custo da posicao, que mora no modulo de carteira.
    custos = {p.ticker: p.custo_total for p in calcular_posicoes(sessao, incluir_zeradas=True)}
    saida = []
    for item in itens:
        custo = custos.get(item.ticker, Decimal(0))
        saida.append(
            {
                "ticker": item.ticker,
                "nome": item.nome,
                "tipo": item.tipo.value,
                "total": item.total,
                "renda": item.renda,
                "amortizacao": item.amortizacao,
                "pagamentos": item.pagamentos,
                "primeiro": item.primeiro,
                "ultimo": item.ultimo,
                "participacao": item.participacao,
                "por_tipo": item.por_tipo,
                "yield_on_cost": (
                    (item.renda / custo * 100).quantize(Decimal("0.01")) if custo > 0 else None
                ),
            }
        )
    return saida


@router.get("/por-classe")
def por_classe(
    meses: Optional[int] = Query(None, ge=1, le=240),
    sessao: Session = Depends(get_session),
) -> dict[str, Decimal]:
    desde = servico._meses_atras(date.today().replace(day=1), meses - 1) if meses else None
    return servico.por_tipo_ativo(sessao, desde=desde)


@router.get("/por-conta")
def por_conta(
    meses: Optional[int] = Query(None, ge=1, le=240),
    sessao: Session = Depends(get_session),
) -> dict[str, Decimal]:
    desde = servico._meses_atras(date.today().replace(day=1), meses - 1) if meses else None
    return servico.por_conta(sessao, desde=desde)


@router.get("/calendario")
def calendario(sessao: Session = Depends(get_session)) -> list[dict]:
    quantidades = {p.ativo_id: p.quantidade for p in calcular_posicoes(sessao)}
    return [
        {
            "ticker": e.ticker,
            "nome": e.nome,
            "tipo": e.tipo,
            "data_com": e.data_com,
            "data_pagamento": e.data_pagamento,
            "valor_por_cota": e.valor_por_cota,
            "quantidade": e.quantidade,
            "valor_estimado": e.valor_estimado,
            "ja_tem_direito": e.ja_tem_direito,
        }
        for e in servico.calendario(sessao, quantidades=quantidades)
    ]
