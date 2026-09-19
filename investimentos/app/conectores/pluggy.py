"""Conector do Meu Pluggy (Open Finance).

O fluxo e o descrito em https://meu.pluggy.ai/api-guide:

    POST /auth  {clientId, clientSecret}  ->  {apiKey}
    GET  /items                           ->  conexoes do titular
    GET  /investments?itemId=...          ->  posicao por ativo
    GET  /investments/{id}/transactions   ->  compras, vendas e proventos

Duas particularidades do servico moldam este codigo:

1. Ha relato consistente de transacoes que aparecem numa chamada e somem na
   seguinte. Por isso a sincronizacao so insere; nada e apagado por ausencia.
2. O campo `transactions` embutido no objeto Investment esta deprecado para
   aplicacoes criadas depois de marco de 2023, entao o detalhamento vem do
   endpoint dedicado e o embutido fica so como plano B.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Optional

import httpx
from sqlmodel import Session

from app.config import config
from app.db import obter_ou_criar_ativo, obter_ou_criar_conta, registrar_movimentacao
from app.models import (
    Fonte,
    Instituicao,
    Movimentacao,
    PosicaoInformada,
    TipoAtivo,
    TipoMovimento,
)

log = logging.getLogger(__name__)

BASE = "https://api.pluggy.ai"

#: type/subtype da Pluggy mapeados para o tipo interno de ativo.
MAPA_TIPO_ATIVO: dict[str, TipoAtivo] = {
    "EQUITY": TipoAtivo.ACAO,
    "ETF": TipoAtivo.ETF_BR,
    "FIXED_INCOME": TipoAtivo.RENDA_FIXA,
    "MUTUAL_FUND": TipoAtivo.FUNDO,
    "COE": TipoAtivo.OUTRO,
    "SECURITY": TipoAtivo.OUTRO,
    "OTHER": TipoAtivo.OUTRO,
}

MAPA_SUBTIPO_ATIVO: dict[str, TipoAtivo] = {
    "STOCK": TipoAtivo.ACAO,
    "ETF": TipoAtivo.ETF_BR,
    "REAL_ESTATE_FUND": TipoAtivo.FII,
    "BDR": TipoAtivo.BDR,
    "TREASURY": TipoAtivo.TESOURO,
    "TREASURY_BOND": TipoAtivo.TESOURO,
    "CDB": TipoAtivo.RENDA_FIXA,
    "LCI": TipoAtivo.RENDA_FIXA,
    "LCA": TipoAtivo.RENDA_FIXA,
    "DEBENTURES": TipoAtivo.RENDA_FIXA,
    "CRI": TipoAtivo.RENDA_FIXA,
    "CRA": TipoAtivo.RENDA_FIXA,
    "STOCK_FUND": TipoAtivo.FUNDO,
    "MULTIMARKET_FUND": TipoAtivo.FUNDO,
    "FIXED_INCOME_FUND": TipoAtivo.FUNDO,
    "RETIREMENT": TipoAtivo.OUTRO,
}

#: type da transacao de investimento mapeado para o tipo interno.
MAPA_TIPO_MOVIMENTO: dict[str, TipoMovimento] = {
    "BUY": TipoMovimento.COMPRA,
    "SELL": TipoMovimento.VENDA,
    "TRANSFER_IN": TipoMovimento.TRANSFERENCIA,
    "TRANSFER_OUT": TipoMovimento.TRANSFERENCIA,
    "TRANSFER": TipoMovimento.TRANSFERENCIA,
    "DIVIDEND": TipoMovimento.DIVIDENDO,
    "INTEREST_ON_EQUITY": TipoMovimento.JCP,
    "JCP": TipoMovimento.JCP,
    "INCOME": TipoMovimento.RENDIMENTO,
    "YIELD": TipoMovimento.RENDIMENTO,
    "AMORTIZATION": TipoMovimento.AMORTIZACAO,
    "INTEREST": TipoMovimento.JUROS,
    "COUPON": TipoMovimento.JUROS,
    "TAX": TipoMovimento.IMPOSTO,
    "FEE": TipoMovimento.TAXA,
    "SPLIT": TipoMovimento.DESDOBRAMENTO,
    "BONUS": TipoMovimento.BONIFICACAO,
    "SUBSCRIPTION": TipoMovimento.SUBSCRICAO,
}


def _dec(valor: Any) -> Decimal:
    if valor is None:
        return Decimal(0)
    try:
        return Decimal(str(valor))
    except Exception:
        return Decimal(0)


def _data(valor: Any) -> Optional[date]:
    if not valor:
        return None
    texto = str(valor)
    for formato in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
        try:
            return datetime.strptime(texto, formato).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(texto.replace("Z", "+00:00")).date()
    except ValueError:
        return None


class ErroPluggy(RuntimeError):
    pass


class ClientePluggy:
    """Cliente HTTP fino sobre a API da Pluggy, com a API key em cache."""

    def __init__(self, client_id: str = "", client_secret: str = "", timeout: float = 30.0):
        self.client_id = client_id or config.pluggy_client_id
        self.client_secret = client_secret or config.pluggy_client_secret
        if not (self.client_id and self.client_secret):
            raise ErroPluggy(
                "PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET nao configurados. "
                "Pegue os dois no Dashboard do Meu Pluggy e coloque no .env."
            )
        self._api_key: Optional[str] = None
        self._http = httpx.Client(base_url=BASE, timeout=timeout)

    def __enter__(self) -> "ClientePluggy":
        return self

    def __exit__(self, *_: Any) -> None:
        self._http.close()

    @property
    def api_key(self) -> str:
        if self._api_key is None:
            resposta = self._http.post(
                "/auth",
                json={"clientId": self.client_id, "clientSecret": self.client_secret},
            )
            if resposta.status_code != 200:
                raise ErroPluggy(f"Falha na autenticacao ({resposta.status_code}): {resposta.text[:200]}")
            self._api_key = resposta.json()["apiKey"]
        return self._api_key

    def _get(self, caminho: str, **params: Any) -> dict:
        resposta = self._http.get(
            caminho,
            params={k: v for k, v in params.items() if v is not None},
            headers={"X-API-KEY": self.api_key},
        )
        if resposta.status_code == 403:
            # API key expira. Uma renovacao e tentativa extra resolvem.
            self._api_key = None
            resposta = self._http.get(
                caminho,
                params={k: v for k, v in params.items() if v is not None},
                headers={"X-API-KEY": self.api_key},
            )
        if resposta.status_code >= 400:
            raise ErroPluggy(f"GET {caminho} falhou ({resposta.status_code}): {resposta.text[:200]}")
        return resposta.json()

    def _paginar(self, caminho: str, **params: Any) -> list[dict]:
        """Percorre todas as paginas de um endpoint de listagem."""
        itens: list[dict] = []
        pagina = 1
        while True:
            dados = self._get(caminho, page=pagina, pageSize=500, **params)
            resultados = dados.get("results", [])
            itens.extend(resultados)
            total_paginas = dados.get("totalPages", 1) or 1
            if pagina >= total_paginas or not resultados:
                break
            pagina += 1
        return itens

    def items(self) -> list[dict]:
        return self._paginar("/items")

    def investimentos(self, item_id: str) -> list[dict]:
        return self._paginar("/investments", itemId=item_id)

    def transacoes_investimento(self, investimento_id: str) -> list[dict]:
        return self._paginar(f"/investments/{investimento_id}/transactions")


@dataclass
class ResultadoSync:
    novos: int = 0
    duplicados: int = 0
    posicoes: int = 0
    itens: int = 0
    avisos: list[str] = field(default_factory=list)

    def resumo(self) -> str:
        return (
            f"{self.itens} conexoes, {self.novos} movimentacoes novas, "
            f"{self.duplicados} ja existentes, {self.posicoes} posicoes atualizadas"
        )


def _instituicao_de(nome: str) -> Instituicao:
    n = (nome or "").upper()
    if "NU" in n or "NUBANK" in n or "NUINVEST" in n:
        return Instituicao.NUBANK
    if "INTER" in n:
        return Instituicao.INTER
    if "B3" in n or "CEI" in n:
        return Instituicao.B3
    return Instituicao.OUTRA


def _identifica_ativo(inv: dict) -> tuple[str, str]:
    """Descobre ticker e nome de um investimento da Pluggy.

    `code` costuma trazer o ticker em renda variavel e vir vazio em renda fixa,
    onde o nome do papel e a unica identificacao estavel.
    """
    codigo = (inv.get("code") or "").strip().upper()
    nome = (inv.get("name") or "").strip()
    isin = (inv.get("isin") or "").strip().upper()
    if codigo:
        return codigo, nome or codigo
    if nome:
        return nome.upper()[:60], nome
    return (isin or f"PLUGGY-{inv.get('id', '')[:8]}"), nome or "Sem nome"


def sincronizar(sessao: Session, cliente: Optional[ClientePluggy] = None) -> ResultadoSync:
    """Puxa investimentos e transacoes de todas as conexoes do titular."""
    resultado = ResultadoSync()
    proprio = cliente is None
    cliente = cliente or ClientePluggy()
    try:
        for item in cliente.items():
            resultado.itens += 1
            item_id = item.get("id")
            conector = item.get("connector") or {}
            nome_conector = conector.get("name") or "Pluggy"
            conta = obter_ou_criar_conta(
                sessao,
                nome_conector,
                instituicao=_instituicao_de(nome_conector),
                pluggy_item_id=item_id,
            )

            try:
                investimentos = cliente.investimentos(item_id)
            except ErroPluggy as erro:
                resultado.avisos.append(f"{nome_conector}: {erro}")
                continue

            for inv in investimentos:
                ticker, nome = _identifica_ativo(inv)
                tipo = MAPA_SUBTIPO_ATIVO.get(
                    (inv.get("subtype") or "").upper()
                ) or MAPA_TIPO_ATIVO.get((inv.get("type") or "").upper())
                moeda = inv.get("currencyCode") or "BRL"
                ativo = obter_ou_criar_ativo(
                    sessao, ticker, nome=nome, tipo=tipo, moeda=moeda, isin=inv.get("isin")
                )

                # Posicao reportada, usada so para conferencia contra o razao.
                data_ref = _data(inv.get("date")) or date.today()
                quantidade = _dec(inv.get("quantity"))
                saldo = _dec(inv.get("balance"))
                if quantidade or saldo:
                    _grava_posicao(sessao, conta.id, ativo.id, data_ref, quantidade, saldo, moeda)
                    resultado.posicoes += 1

                transacoes = _transacoes_do_investimento(cliente, inv, resultado)
                for transacao in transacoes:
                    if _grava_transacao(sessao, conta.id, ativo.id, transacao, moeda, resultado):
                        resultado.novos += 1
                    else:
                        resultado.duplicados += 1

        sessao.commit()
    finally:
        if proprio:
            cliente._http.close()

    resultado.avisos = sorted(set(resultado.avisos))
    return resultado


def _transacoes_do_investimento(
    cliente: ClientePluggy, inv: dict, resultado: ResultadoSync
) -> list[dict]:
    """Busca no endpoint dedicado e cai para o campo embutido se ele falhar."""
    try:
        transacoes = cliente.transacoes_investimento(inv["id"])
        if transacoes:
            return transacoes
    except ErroPluggy as erro:
        resultado.avisos.append(f"transacoes de {inv.get('name')}: {erro}")
    return inv.get("transactions") or []


def _grava_posicao(
    sessao: Session,
    conta_id: int,
    ativo_id: int,
    data_ref: date,
    quantidade: Decimal,
    saldo: Decimal,
    moeda: str,
) -> None:
    from sqlmodel import select

    existente = sessao.exec(
        select(PosicaoInformada).where(
            PosicaoInformada.conta_id == conta_id,
            PosicaoInformada.ativo_id == ativo_id,
            PosicaoInformada.data == data_ref,
        )
    ).first()
    if existente:
        existente.quantidade = quantidade
        existente.valor_bruto = saldo
        sessao.add(existente)
        return
    sessao.add(
        PosicaoInformada(
            conta_id=conta_id,
            ativo_id=ativo_id,
            data=data_ref,
            quantidade=quantidade,
            valor_bruto=saldo,
            moeda=moeda,
            fonte=Fonte.PLUGGY,
        )
    )


def _grava_transacao(
    sessao: Session,
    conta_id: int,
    ativo_id: int,
    transacao: dict,
    moeda: str,
    resultado: ResultadoSync,
) -> bool:
    data_mov = _data(transacao.get("date") or transacao.get("tradeDate"))
    if data_mov is None:
        return False

    bruto = (transacao.get("type") or "").upper()
    tipo = MAPA_TIPO_MOVIMENTO.get(bruto)
    if tipo is None:
        # movementType diz o sentido (CREDIT/DEBIT) e salva o caso do tipo novo.
        sentido = (transacao.get("movementType") or "").upper()
        if sentido == "CREDIT":
            tipo = TipoMovimento.COMPRA
        elif sentido == "DEBIT":
            tipo = TipoMovimento.VENDA
        else:
            tipo = TipoMovimento.OUTRO
        if bruto:
            resultado.avisos.append(f'Tipo de transacao nao mapeado: "{bruto}"')

    despesas = transacao.get("expenses") or {}
    ir = _dec(despesas.get("incomeTax"))
    bruto_valor = abs(_dec(transacao.get("amount") or transacao.get("value")))
    liquido = abs(_dec(transacao.get("netAmount"))) or (bruto_valor - ir)

    mov = Movimentacao(
        data=data_mov,
        conta_id=conta_id,
        ativo_id=ativo_id,
        tipo=tipo,
        quantidade=abs(_dec(transacao.get("quantity"))),
        preco_unitario=_dec(transacao.get("value")) or None,
        valor_bruto=bruto_valor,
        ir_retido=ir,
        valor_liquido=liquido,
        moeda=transacao.get("currencyCode") or moeda,
        fonte=Fonte.PLUGGY,
        id_externo=str(transacao.get("id") or "") or None,
        descricao=transacao.get("description"),
    )
    return registrar_movimentacao(sessao, mov)
