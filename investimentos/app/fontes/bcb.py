"""Series do Banco Central (SGS): CDI, SELIC, IPCA e PTAX.

Servem para marcar renda fixa indexada e para converter em reais o que esta em
dolar. A API e aberta, sem cadastro e sem token.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional

import httpx

log = logging.getLogger(__name__)
BASE = "https://api.bcb.gov.br/dados/serie"

#: Codigo de cada serie no SGS do Banco Central.
SERIES = {
    "CDI": 12,        # taxa DI acumulada no dia
    "SELIC": 11,      # taxa Selic diaria
    "SELIC_META": 432,
    "IPCA": 433,      # variacao mensal
    "PTAX_USD": 1,    # dolar comercial, venda
}


class ErroBCB(RuntimeError):
    pass


def serie(codigo: str, *, inicio: Optional[date] = None, fim: Optional[date] = None) -> list[dict]:
    """Baixa uma serie do SGS no periodo pedido."""
    if codigo not in SERIES:
        raise ErroBCB(f"Serie desconhecida: {codigo}. Disponiveis: {', '.join(SERIES)}")

    params = {"formato": "json"}
    if inicio:
        params["dataInicial"] = inicio.strftime("%d/%m/%Y")
    if fim:
        params["dataFinal"] = fim.strftime("%d/%m/%Y")

    try:
        resposta = httpx.get(f"{BASE}/bcdata.sgs.{SERIES[codigo]}/dados", params=params, timeout=30.0)
    except httpx.HTTPError as erro:
        raise ErroBCB(f"Banco Central inacessivel: {erro}") from erro
    if resposta.status_code >= 400:
        raise ErroBCB(f"Banco Central devolveu {resposta.status_code}")

    saida = []
    for registro in resposta.json():
        try:
            saida.append(
                {
                    "data": datetime.strptime(registro["data"], "%d/%m/%Y").date(),
                    "valor": Decimal(str(registro["valor"])),
                }
            )
        except (KeyError, ValueError):
            continue
    return saida


def cotacao_dolar(dia: Optional[date] = None) -> Optional[Decimal]:
    """PTAX de venda do dia pedido, ou do ultimo dia util anterior.

    Fim de semana e feriado nao tem PTAX, entao a janela de 10 dias para tras
    cobre inclusive emenda de feriado.
    """
    dia = dia or date.today()
    try:
        dados = serie("PTAX_USD", inicio=dia - timedelta(days=10), fim=dia)
    except ErroBCB as erro:
        log.warning("PTAX indisponivel: %s", erro)
        return None
    return dados[-1]["valor"] if dados else None
