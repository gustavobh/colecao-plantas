"""Endpoints de visao geral da carteira."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select

from app.carteira import calcular_posicoes, resumir
from app.config import config
from app.db import get_session
from app.models import Ativo, Conta, Movimentacao
from app.proventos import projetar_12m

router = APIRouter(prefix="/api", tags=["painel"])


def _posicao_json(pos) -> dict:
    return {
        "ativo_id": pos.ativo_id,
        "ticker": pos.ticker,
        "nome": pos.nome,
        "tipo": pos.tipo.value,
        "moeda": pos.moeda,
        "quantidade": pos.quantidade,
        "preco_medio": pos.preco_medio,
        "preco_atual": pos.preco_atual,
        "data_preco": pos.data_preco,
        "custo_total": pos.custo_total.quantize(Decimal("0.01")),
        "valor_atual": pos.valor_atual,
        "taxa_base": pos.taxa_base,
        "custo_total_base": pos.custo_total_base,
        "valor_atual_base": pos.valor_atual_base,
        "proventos_base": pos.proventos_base,
        "lucro_nao_realizado": pos.lucro_nao_realizado,
        "rentabilidade": pos.rentabilidade,
        "retorno_total": pos.retorno_total,
        "proventos_recebidos": pos.proventos_recebidos.quantize(Decimal("0.01")),
        "proventos_renda": pos.proventos_renda.quantize(Decimal("0.01")),
        "yield_on_cost": pos.yield_on_cost,
        "ultimo_provento": pos.ultimo_provento,
        "primeira_compra": pos.primeira_compra,
        "contas": sorted(pos.contas),
        "custo_incompleto": pos.custo_incompleto,
    }


@router.get("/resumo")
def resumo(sessao: Session = Depends(get_session)) -> dict:
    """Numeros de topo do painel."""
    posicoes = calcular_posicoes(sessao)
    consolidado = resumir(posicoes, proventos_12m=projetar_12m(sessao))
    return {
        "valor_investido": consolidado.valor_investido.quantize(Decimal("0.01")),
        "valor_atual": consolidado.valor_atual.quantize(Decimal("0.01")),
        "lucro_nao_realizado": consolidado.lucro_nao_realizado,
        "lucro_realizado": consolidado.lucro_realizado.quantize(Decimal("0.01")),
        "rentabilidade": consolidado.rentabilidade,
        "proventos_total": consolidado.proventos_total.quantize(Decimal("0.01")),
        "proventos_12m": consolidado.proventos_12m,
        "yield_on_cost": consolidado.yield_on_cost,
        "quantidade_ativos": consolidado.quantidade_ativos,
        "sem_cotacao": consolidado.sem_cotacao,
        "cambio_ausente": consolidado.cambio_ausente,
        "moeda_base": config.moeda_base,
        "por_tipo": consolidado.por_tipo,
    }


@router.get("/posicoes")
def posicoes(
    tipo: Optional[str] = Query(None, description="Filtra por classe de ativo"),
    incluir_zeradas: bool = Query(False),
    sessao: Session = Depends(get_session),
) -> list[dict]:
    resultado = calcular_posicoes(sessao, incluir_zeradas=incluir_zeradas)
    if tipo:
        resultado = [p for p in resultado if p.tipo.value == tipo.upper()]
    return [_posicao_json(p) for p in resultado]


@router.get("/posicoes/{ticker}")
def posicao_detalhe(ticker: str, sessao: Session = Depends(get_session)) -> dict:
    ticker = ticker.upper()
    alvo = next((p for p in calcular_posicoes(sessao, incluir_zeradas=True) if p.ticker == ticker), None)
    if alvo is None:
        return {"erro": f"{ticker} nao encontrado na carteira"}

    movimentos = sessao.exec(
        select(Movimentacao, Conta)
        .join(Ativo, Movimentacao.ativo_id == Ativo.id)
        .join(Conta, Movimentacao.conta_id == Conta.id)
        .where(Ativo.ticker == ticker)
        .order_by(Movimentacao.data.desc())
    ).all()

    return {
        **_posicao_json(alvo),
        "movimentacoes": [
            {
                "id": m.id,
                "data": m.data,
                "tipo": m.tipo.value,
                "quantidade": m.quantidade,
                "preco_unitario": m.preco_unitario,
                "valor_liquido": m.valor_liquido,
                "moeda": m.moeda,
                "conta": c.nome,
                "fonte": m.fonte.value,
                "descricao": m.descricao,
            }
            for m, c in movimentos
        ],
    }


@router.get("/contas")
def contas(sessao: Session = Depends(get_session)) -> list[dict]:
    return [
        {
            "id": c.id,
            "nome": c.nome,
            "instituicao": c.instituicao.value,
            "sincronizada": bool(c.pluggy_item_id),
            "ativa": c.ativa,
        }
        for c in sessao.exec(select(Conta).order_by(Conta.nome)).all()
    ]


@router.get("/divergencias")
def divergencias(sessao: Session = Depends(get_session)) -> list[dict]:
    """Onde o livro-razao discorda da posicao que a instituicao reporta.

    Divergencia quase sempre significa import faltando, e e a forma mais rapida
    de descobrir que falta um pedaco do historico.
    """
    from app.models import PosicaoInformada

    calculadas = {p.ticker: p for p in calcular_posicoes(sessao, incluir_zeradas=True)}
    ativos = {a.id: a for a in sessao.exec(select(Ativo)).all()}

    ultimas: dict[tuple[int, int], PosicaoInformada] = {}
    for informada in sessao.exec(select(PosicaoInformada).order_by(PosicaoInformada.data)).all():
        ultimas[(informada.conta_id, informada.ativo_id)] = informada

    saida = []
    for (_conta_id, ativo_id), informada in ultimas.items():
        ativo = ativos.get(ativo_id)
        if ativo is None:
            continue
        calculada = calculadas.get(ativo.ticker)
        quantidade_calculada = calculada.quantidade if calculada else Decimal(0)
        diferenca = Decimal(informada.quantidade) - quantidade_calculada
        if abs(diferenca) > Decimal("0.00000001"):
            saida.append(
                {
                    "ticker": ativo.ticker,
                    "quantidade_calculada": quantidade_calculada,
                    "quantidade_informada": informada.quantidade,
                    "diferenca": diferenca,
                    "data_referencia": informada.data,
                    "fonte": informada.fonte.value,
                }
            )
    return sorted(saida, key=lambda d: abs(d["diferenca"]), reverse=True)
