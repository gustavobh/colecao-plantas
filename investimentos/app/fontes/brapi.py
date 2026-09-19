"""Cotacoes e historico de proventos de ativos da B3, via brapi.dev.

O plano gratuito exige token desde 2024 (cadastro em brapi.dev/dashboard).
Sem token a API responde 401, e o app segue funcionando: cotacao fica com o
ultimo valor conhecido no banco e o painel avisa que o preco esta defasado.
"""
from __future__ import annotations

import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Iterable, Optional

import httpx

from app.config import config
from app.models import TipoMovimento

log = logging.getLogger(__name__)
BASE = "https://brapi.dev/api"

#: Rotulo do provento na brapi mapeado para o tipo interno.
MAPA_LABEL: dict[str, TipoMovimento] = {
    "DIVIDENDO": TipoMovimento.DIVIDENDO,
    "DIVIDEND": TipoMovimento.DIVIDENDO,
    "JRS CAP PROPRIO": TipoMovimento.JCP,
    "JUROS SOBRE CAPITAL PROPRIO": TipoMovimento.JCP,
    "JCP": TipoMovimento.JCP,
    "RENDIMENTO": TipoMovimento.RENDIMENTO,
    "AMORTIZACAO": TipoMovimento.AMORTIZACAO,
    "AMORTIZACAO RF": TipoMovimento.AMORTIZACAO,
}


class ErroBrapi(RuntimeError):
    pass


def _data(valor: Any) -> Optional[date]:
    if not valor:
        return None
    texto = str(valor)
    for formato in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(texto, formato).date()
        except ValueError:
            continue
    return None


def _tipo_provento(label: Any) -> TipoMovimento:
    chave = str(label or "").strip().upper()
    return MAPA_LABEL.get(chave, TipoMovimento.DIVIDENDO)


def consultar(tickers: Iterable[str], *, com_proventos: bool = False, timeout: float = 20.0) -> list[dict]:
    """Consulta ate 20 tickers por chamada, que e o limite do plano gratuito."""
    lista = [t.strip().upper() for t in tickers if t and t.strip()]
    if not lista:
        return []

    resultados: list[dict] = []
    for inicio in range(0, len(lista), 20):
        lote = lista[inicio : inicio + 20]
        params: dict[str, Any] = {}
        if config.brapi_token:
            params["token"] = config.brapi_token
        if com_proventos:
            params["dividends"] = "true"
        try:
            resposta = httpx.get(f"{BASE}/quote/{','.join(lote)}", params=params, timeout=timeout)
        except httpx.HTTPError as erro:
            raise ErroBrapi(f"brapi inacessivel: {erro}") from erro

        if resposta.status_code == 401:
            raise ErroBrapi(
                "brapi recusou a chamada (401). Cadastre um token gratuito em "
                "https://brapi.dev/dashboard e coloque em BRAPI_TOKEN no .env."
            )
        if resposta.status_code >= 400:
            raise ErroBrapi(f"brapi devolveu {resposta.status_code}: {resposta.text[:160]}")
        resultados.extend(resposta.json().get("results", []))
    return resultados


def cotacoes(tickers: Iterable[str]) -> dict[str, Decimal]:
    """Preco atual por ticker. Tickers sem resposta simplesmente nao aparecem."""
    saida: dict[str, Decimal] = {}
    for item in consultar(tickers):
        preco = item.get("regularMarketPrice")
        if preco is not None:
            saida[str(item["symbol"]).upper()] = Decimal(str(preco))
    return saida


def proventos(ticker: str) -> list[dict]:
    """Historico de proventos por cota declarados para o papel.

    Devolve dicionarios com tipo, data_com, data_pagamento e valor_por_cota.
    """
    resultados = consultar([ticker], com_proventos=True)
    if not resultados:
        return []

    dados = (resultados[0].get("dividendsData") or {}).get("cashDividends") or []
    saida: list[dict] = []
    for registro in dados:
        valor = registro.get("rate")
        if valor is None:
            continue
        saida.append(
            {
                "tipo": _tipo_provento(registro.get("label")),
                "data_com": _data(registro.get("lastDatePrior")),
                "data_pagamento": _data(registro.get("paymentDate")),
                "valor_por_cota": Decimal(str(valor)),
                "moeda": "BRL",
            }
        )
    return saida
