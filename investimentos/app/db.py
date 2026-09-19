"""Conexao com o banco e as operacoes de escrita que precisam ser idempotentes."""
from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, SQLModel, create_engine, select

from app.config import RAIZ, config
from app.models import Ativo, Conta, Instituicao, Movimentacao, TipoAtivo

_url = config.database_url
if _url.startswith("sqlite:///") and not _url.startswith("sqlite:////"):
    destino = RAIZ / _url.removeprefix("sqlite:///")
    destino.parent.mkdir(parents=True, exist_ok=True)
    _url = f"sqlite:///{destino}"

engine = create_engine(_url, echo=False, connect_args={"check_same_thread": False})


def criar_tabelas() -> None:
    SQLModel.metadata.create_all(engine)


def get_session() -> Iterator[Session]:
    with Session(engine) as sessao:
        yield sessao


# --------------------------------------------------------------------------
# Escritas idempotentes
# --------------------------------------------------------------------------

#: Sufixos de ticker da B3 que denunciam o tipo do papel.
_SUFIXO_ACAO = ("3", "4", "5", "6", "7", "8")


def classifica_ticker(ticker: str, nome: str = "") -> TipoAtivo:
    """Chute inicial do tipo do ativo a partir do ticker.

    Serve para o primeiro cadastro nao vir todo como OUTRO. O usuario pode
    corrigir depois pela API, e a correcao nunca e sobrescrita pelo import.
    """
    t = ticker.strip().upper()
    n = (nome or "").upper()

    if t.startswith("TESOURO") or "TESOURO" in n:
        return TipoAtivo.TESOURO
    if any(p in n for p in ("CDB", "LCI", "LCA", "DEBENTURE", "CRI", "CRA", "LETRA FINANCEIRA")):
        return TipoAtivo.RENDA_FIXA
    if t.endswith("11") and ("FII" in n or "FDO" in n or "IMOB" in n or "FUNDO DE INVEST. IMOB" in n):
        return TipoAtivo.FII
    if t.endswith("11B") or t.endswith("11"):
        # 11 sozinho e ambiguo: cobre FII, ETF e unit. Fica como FII quando o
        # nome sugere, senao ETF_BR, que e o segundo caso mais comum.
        return TipoAtivo.ETF_BR if "ETF" in n or "INDEX" in n else TipoAtivo.FII
    if len(t) >= 5 and t[:4].isalpha() and t[4:].isdigit() and t[4] in _SUFIXO_ACAO:
        if t.endswith(("31", "32", "33", "34", "35", "39")):
            return TipoAtivo.BDR
        return TipoAtivo.ACAO
    if t.isalpha() and 1 <= len(t) <= 5:
        # Ticker so com letras e curto e o padrao das bolsas americanas.
        return TipoAtivo.ETF_US if "ETF" in n or "TRUST" in n or "FUND" in n else TipoAtivo.STOCK_US
    return TipoAtivo.OUTRO


def obter_ou_criar_ativo(
    sessao: Session,
    ticker: str,
    *,
    nome: Optional[str] = None,
    tipo: Optional[TipoAtivo] = None,
    moeda: str = "BRL",
    isin: Optional[str] = None,
) -> Ativo:
    ticker = ticker.strip().upper()
    ativo = sessao.exec(select(Ativo).where(Ativo.ticker == ticker)).first()
    if ativo:
        # Completa lacunas sem jamais sobrescrever o que ja tem valor.
        if nome and not ativo.nome:
            ativo.nome = nome
        if isin and not ativo.isin:
            ativo.isin = isin
        if tipo and ativo.tipo == TipoAtivo.OUTRO:
            ativo.tipo = tipo
        sessao.add(ativo)
        return ativo

    ativo = Ativo(
        ticker=ticker,
        nome=nome,
        tipo=tipo or classifica_ticker(ticker, nome or ""),
        moeda=moeda,
        isin=isin,
    )
    sessao.add(ativo)
    sessao.flush()
    return ativo


def obter_ou_criar_conta(
    sessao: Session,
    nome: str,
    *,
    instituicao: Instituicao = Instituicao.OUTRA,
    pluggy_item_id: Optional[str] = None,
    moeda: str = "BRL",
) -> Conta:
    nome = nome.strip()
    conta = sessao.exec(select(Conta).where(Conta.nome == nome)).first()
    if conta:
        if pluggy_item_id and not conta.pluggy_item_id:
            conta.pluggy_item_id = pluggy_item_id
            sessao.add(conta)
        return conta
    conta = Conta(nome=nome, instituicao=instituicao, pluggy_item_id=pluggy_item_id, moeda=moeda)
    sessao.add(conta)
    sessao.flush()
    return conta


def registrar_movimentacao(sessao: Session, mov: Movimentacao) -> bool:
    """Grava a movimentacao se ela ainda nao existir.

    Devolve True quando inseriu e False quando era duplicata. O UniqueConstraint
    em `impressao` e a garantia real; a consulta antes so evita gastar savepoint
    no caminho comum.
    """
    if not mov.impressao:
        mov.impressao = Movimentacao.calcula_impressao(
            conta_id=mov.conta_id,
            ativo_id=mov.ativo_id,
            data=mov.data,
            tipo=mov.tipo,
            quantidade=mov.quantidade,
            valor_liquido=mov.valor_liquido,
            id_externo=mov.id_externo,
        )

    existente = sessao.exec(
        select(Movimentacao).where(Movimentacao.impressao == mov.impressao)
    ).first()
    if existente:
        return False

    if mov.valor_liquido_base is None:
        if mov.moeda == config.moeda_base:
            mov.valor_liquido_base = mov.valor_liquido
        elif mov.taxa_cambio is not None:
            mov.valor_liquido_base = (Decimal(mov.valor_liquido) * Decimal(mov.taxa_cambio)).quantize(
                Decimal("0.00000001")
            )

    sessao.add(mov)
    try:
        sessao.flush()
    except IntegrityError:
        sessao.rollback()
        return False
    return True
