"""Cotacoes e dividendos de ativos negociados fora do Brasil, via Yahoo Finance.

Cobre ETF e acao americana, que e o que a brapi nao alcanca. A API publica do
grafico devolve preco e eventos de dividendo na mesma chamada.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Iterable, Optional

import httpx

log = logging.getLogger(__name__)
BASE = "https://query1.finance.yahoo.com/v8/finance/chart"

#: O Yahoo recusa chamada sem user agent de navegador.
CABECALHOS = {"User-Agent": "Mozilla/5.0 (compativel; gestao-investimentos/0.1)"}


class ErroYahoo(RuntimeError):
    pass


def _timestamp_para_data(ts: int) -> date:
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).date()


def _consultar(simbolo: str, *, intervalo: str = "1d", periodo: str = "1d", eventos: str = "") -> dict:
    params = {"interval": intervalo, "range": periodo}
    if eventos:
        params["events"] = eventos
    try:
        resposta = httpx.get(
            f"{BASE}/{simbolo}", params=params, headers=CABECALHOS, timeout=20.0, follow_redirects=True
        )
    except httpx.HTTPError as erro:
        raise ErroYahoo(f"Yahoo inacessivel: {erro}") from erro
    if resposta.status_code >= 400:
        raise ErroYahoo(f"Yahoo devolveu {resposta.status_code} para {simbolo}")

    corpo = resposta.json().get("chart") or {}
    if corpo.get("error"):
        raise ErroYahoo(f"Yahoo: {corpo['error']}")
    resultados = corpo.get("result") or []
    if not resultados:
        raise ErroYahoo(f"Sem dados para {simbolo}")
    return resultados[0]


def cotacoes(simbolos: Iterable[str]) -> dict[str, Decimal]:
    """Preco atual por simbolo. Falha de um simbolo nao derruba os outros."""
    saida: dict[str, Decimal] = {}
    for simbolo in simbolos:
        simbolo = simbolo.strip().upper()
        if not simbolo:
            continue
        try:
            meta = _consultar(simbolo).get("meta") or {}
        except ErroYahoo as erro:
            log.warning("cotacao de %s falhou: %s", simbolo, erro)
            continue
        preco = meta.get("regularMarketPrice")
        if preco is not None:
            saida[simbolo] = Decimal(str(preco))
    return saida


def moeda_de(simbolo: str) -> Optional[str]:
    try:
        return (_consultar(simbolo).get("meta") or {}).get("currency")
    except ErroYahoo:
        return None


def proventos(simbolo: str, *, periodo: str = "10y") -> list[dict]:
    """Dividendos pagos por acao, com data de pagamento."""
    try:
        resultado = _consultar(simbolo, periodo=periodo, eventos="div")
    except ErroYahoo as erro:
        log.warning("proventos de %s falharam: %s", simbolo, erro)
        return []

    dividendos = ((resultado.get("events") or {}).get("dividends") or {}).values()
    moeda = (resultado.get("meta") or {}).get("currency") or "USD"
    return [
        {
            "tipo": None,  # o chamador decide: DIVIDENDO para acao, RENDIMENTO para REIT
            "data_com": None,  # o Yahoo nao devolve ex-date nesse endpoint
            "data_pagamento": _timestamp_para_data(d["date"]),
            "valor_por_cota": Decimal(str(d["amount"])),
            "moeda": moeda,
        }
        for d in dividendos
        if d.get("amount") is not None and d.get("date")
    ]
