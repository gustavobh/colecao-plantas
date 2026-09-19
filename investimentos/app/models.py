"""Modelo de dados da carteira.

Duas regras guiam o desenho e valem a pena estarem escritas aqui:

1. Movimentacao e um livro-razao append-only. Nada que entrou e apagado porque
   uma API parou de devolver. Conectores de Open Finance omitem transacoes
   antigas de forma silenciosa, entao ausencia nunca significa estorno.
2. Posicao nao e armazenada, e derivada. O saldo de cada ativo sai da soma das
   movimentacoes, de modo que corrigir um lancamento antigo conserta todo o
   historico sem migracao.
"""
from __future__ import annotations

import hashlib
from datetime import date, datetime, timezone
from decimal import Decimal
from enum import Enum
from typing import Optional

from sqlmodel import Field, SQLModel, UniqueConstraint


def agora() -> datetime:
    return datetime.now(timezone.utc)


class TipoAtivo(str, Enum):
    ACAO = "ACAO"
    FII = "FII"
    ETF_BR = "ETF_BR"
    ETF_US = "ETF_US"
    STOCK_US = "STOCK_US"
    REIT_US = "REIT_US"
    BDR = "BDR"
    RENDA_FIXA = "RENDA_FIXA"
    TESOURO = "TESOURO"
    FUNDO = "FUNDO"
    CRIPTO = "CRIPTO"
    OUTRO = "OUTRO"


class TipoMovimento(str, Enum):
    # Patrimonio
    COMPRA = "COMPRA"
    VENDA = "VENDA"
    APLICACAO = "APLICACAO"          # aporte em renda fixa / fundo
    RESGATE = "RESGATE"
    TRANSFERENCIA = "TRANSFERENCIA"  # entrada ou saida de custodia

    # Proventos em dinheiro
    DIVIDENDO = "DIVIDENDO"
    JCP = "JCP"
    RENDIMENTO = "RENDIMENTO"        # distribuicao de FII
    AMORTIZACAO = "AMORTIZACAO"      # FII devolvendo principal
    JUROS = "JUROS"                  # cupom de renda fixa / tesouro

    # Eventos que mexem na quantidade, nao no caixa
    BONIFICACAO = "BONIFICACAO"
    DESDOBRAMENTO = "DESDOBRAMENTO"
    GRUPAMENTO = "GRUPAMENTO"
    SUBSCRICAO = "SUBSCRICAO"
    FRACAO = "FRACAO"

    # Custos
    TAXA = "TAXA"
    IMPOSTO = "IMPOSTO"

    OUTRO = "OUTRO"


#: Proventos que representam remuneracao de fato e entram no calculo de yield.
PROVENTOS_RENDA = frozenset(
    {TipoMovimento.DIVIDENDO, TipoMovimento.JCP, TipoMovimento.RENDIMENTO, TipoMovimento.JUROS}
)

#: Amortizacao pinga no caixa igual a um provento, so que e devolucao de
#: principal: entra no fluxo recebido e fica fora do yield, senao o FII parece
#: pagar muito mais do que paga.
PROVENTOS_CAIXA = PROVENTOS_RENDA | {TipoMovimento.AMORTIZACAO}

#: Movimentos que alteram a quantidade custodiada.
MOVIMENTOS_QUANTIDADE = frozenset(
    {
        TipoMovimento.COMPRA,
        TipoMovimento.VENDA,
        TipoMovimento.APLICACAO,
        TipoMovimento.RESGATE,
        TipoMovimento.TRANSFERENCIA,
        TipoMovimento.BONIFICACAO,
        TipoMovimento.DESDOBRAMENTO,
        TipoMovimento.GRUPAMENTO,
        TipoMovimento.SUBSCRICAO,
        TipoMovimento.FRACAO,
    }
)

#: Sinal aplicado a quantidade de cada tipo de movimento.
SINAL_QUANTIDADE: dict[TipoMovimento, int] = {
    TipoMovimento.COMPRA: 1,
    TipoMovimento.APLICACAO: 1,
    TipoMovimento.BONIFICACAO: 1,
    TipoMovimento.DESDOBRAMENTO: 1,
    TipoMovimento.SUBSCRICAO: 1,
    TipoMovimento.VENDA: -1,
    TipoMovimento.RESGATE: -1,
    TipoMovimento.GRUPAMENTO: -1,
    TipoMovimento.FRACAO: -1,
}


class Instituicao(str, Enum):
    B3 = "B3"
    NUBANK = "NUBANK"
    INTER = "INTER"
    MANUAL = "MANUAL"
    OUTRA = "OUTRA"


class Fonte(str, Enum):
    """De onde o lancamento veio. Decide precedencia quando ha conflito."""

    MANUAL = "MANUAL"                # digitado, tem a ultima palavra
    B3_MOVIMENTACAO = "B3_MOVIMENTACAO"
    B3_POSICAO = "B3_POSICAO"
    PLUGGY = "PLUGGY"
    CSV = "CSV"


class Ativo(SQLModel, table=True):
    """Um papel. O ticker e a chave natural, normalizado em maiusculas."""

    __tablename__ = "ativo"

    id: Optional[int] = Field(default=None, primary_key=True)
    ticker: str = Field(index=True, unique=True)
    nome: Optional[str] = None
    tipo: TipoAtivo = Field(default=TipoAtivo.OUTRO, index=True)
    isin: Optional[str] = Field(default=None, index=True)
    moeda: str = Field(default="BRL")
    segmento: Optional[str] = None
    cnpj: Optional[str] = None
    #: Renda fixa precisa de vencimento e indexador para marcacao.
    vencimento: Optional[date] = None
    indexador: Optional[str] = None      # CDI, IPCA, PREFIXADO, SELIC
    taxa_contratada: Optional[Decimal] = Field(default=None, max_digits=12, decimal_places=6)
    criado_em: datetime = Field(default_factory=agora)


class Conta(SQLModel, table=True):
    """Onde o ativo esta custodiado. Uma conta por instituicao de origem."""

    __tablename__ = "conta"

    id: Optional[int] = Field(default=None, primary_key=True)
    nome: str = Field(index=True, unique=True)
    instituicao: Instituicao = Field(default=Instituicao.OUTRA)
    #: itemId da Pluggy, quando a conta for sincronizada por Open Finance.
    pluggy_item_id: Optional[str] = Field(default=None, index=True)
    moeda: str = Field(default="BRL")
    ativa: bool = Field(default=True)
    criado_em: datetime = Field(default_factory=agora)


class Movimentacao(SQLModel, table=True):
    """Um evento no livro-razao.

    `impressao` e o que torna a importacao idempotente: reimportar o mesmo
    Excel da B3 dez vezes nao duplica nada.
    """

    __tablename__ = "movimentacao"
    __table_args__ = (UniqueConstraint("impressao", name="uq_movimentacao_impressao"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    data: date = Field(index=True)
    conta_id: int = Field(foreign_key="conta.id", index=True)
    ativo_id: Optional[int] = Field(default=None, foreign_key="ativo.id", index=True)
    tipo: TipoMovimento = Field(index=True)

    quantidade: Decimal = Field(default=Decimal(0), max_digits=20, decimal_places=8)
    preco_unitario: Optional[Decimal] = Field(default=None, max_digits=20, decimal_places=8)

    #: Valor bruto na moeda original do evento.
    valor_bruto: Decimal = Field(default=Decimal(0), max_digits=20, decimal_places=8)
    #: IR retido na fonte. JCP vem com 15% retido; dividendo, hoje, com zero.
    ir_retido: Decimal = Field(default=Decimal(0), max_digits=20, decimal_places=8)
    #: O que efetivamente pingou na conta.
    valor_liquido: Decimal = Field(default=Decimal(0), max_digits=20, decimal_places=8)

    moeda: str = Field(default="BRL")
    #: Cotacao usada para converter para a moeda base, quando moeda != base.
    taxa_cambio: Optional[Decimal] = Field(default=None, max_digits=20, decimal_places=8)
    valor_liquido_base: Optional[Decimal] = Field(default=None, max_digits=20, decimal_places=8)

    fonte: Fonte = Field(default=Fonte.MANUAL, index=True)
    #: Identificador da transacao no sistema de origem, quando existir.
    id_externo: Optional[str] = Field(default=None, index=True)
    descricao: Optional[str] = None
    observacao: Optional[str] = None

    impressao: str = Field(index=True)
    criado_em: datetime = Field(default_factory=agora)

    @staticmethod
    def calcula_impressao(
        *,
        conta_id: int,
        ativo_id: Optional[int],
        data: date,
        tipo: TipoMovimento,
        quantidade: Decimal,
        valor_liquido: Decimal,
        id_externo: Optional[str] = None,
    ) -> str:
        """Identidade de um lancamento.

        Quando a origem fornece um id proprio, ele manda sozinho. Sem id, a
        combinacao conta/ativo/data/tipo/quantidade/valor identifica o evento.
        Dois proventos identicos no mesmo dia e mesma conta sao, na pratica, o
        mesmo credito lancado duas vezes.
        """
        if id_externo:
            base = f"ext:{conta_id}:{id_externo}"
        else:
            base = "|".join(
                [
                    str(conta_id),
                    str(ativo_id or "-"),
                    data.isoformat(),
                    tipo.value,
                    f"{Decimal(quantidade):.8f}",
                    f"{Decimal(valor_liquido):.8f}",
                ]
            )
        return hashlib.sha256(base.encode("utf-8")).hexdigest()[:32]


class Cotacao(SQLModel, table=True):
    """Preco de fechamento por ativo e data."""

    __tablename__ = "cotacao"
    __table_args__ = (UniqueConstraint("ativo_id", "data", name="uq_cotacao_ativo_data"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    ativo_id: int = Field(foreign_key="ativo.id", index=True)
    data: date = Field(index=True)
    fechamento: Decimal = Field(max_digits=20, decimal_places=8)
    moeda: str = Field(default="BRL")
    fonte: str = Field(default="brapi")
    atualizado_em: datetime = Field(default_factory=agora)


class ProventoAnunciado(SQLModel, table=True):
    """Provento declarado pela empresa ou pelo fundo e ainda nao creditado.

    Alimenta o calendario e a projecao de recebimento. Quando o credito chega,
    vira uma Movimentacao e este registro fica so como historico da data-com.
    """

    __tablename__ = "provento_anunciado"
    __table_args__ = (
        UniqueConstraint("ativo_id", "data_com", "tipo", "valor_por_cota", name="uq_provento_anunciado"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    ativo_id: int = Field(foreign_key="ativo.id", index=True)
    tipo: TipoMovimento = Field(default=TipoMovimento.DIVIDENDO)
    #: Ultimo dia para ter o papel e receber.
    data_com: Optional[date] = Field(default=None, index=True)
    data_pagamento: Optional[date] = Field(default=None, index=True)
    valor_por_cota: Decimal = Field(max_digits=20, decimal_places=8)
    moeda: str = Field(default="BRL")
    fonte: str = Field(default="brapi")
    atualizado_em: datetime = Field(default_factory=agora)


class PosicaoInformada(SQLModel, table=True):
    """Foto da posicao como a instituicao reporta.

    Nao e usada para calcular nada. Serve para o app apontar divergencia entre
    o que o livro-razao diz e o que a corretora diz, que e como se descobre
    importacao faltando.
    """

    __tablename__ = "posicao_informada"
    __table_args__ = (
        UniqueConstraint("conta_id", "ativo_id", "data", name="uq_posicao_informada"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    conta_id: int = Field(foreign_key="conta.id", index=True)
    ativo_id: int = Field(foreign_key="ativo.id", index=True)
    data: date = Field(index=True)
    quantidade: Decimal = Field(max_digits=20, decimal_places=8)
    valor_bruto: Optional[Decimal] = Field(default=None, max_digits=20, decimal_places=8)
    moeda: str = Field(default="BRL")
    fonte: Fonte = Field(default=Fonte.B3_POSICAO)
    atualizado_em: datetime = Field(default_factory=agora)


class IndicadorEconomico(SQLModel, table=True):
    """Series do Banco Central: CDI, SELIC, IPCA e PTAX."""

    __tablename__ = "indicador_economico"
    __table_args__ = (UniqueConstraint("codigo", "data", name="uq_indicador_codigo_data"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    codigo: str = Field(index=True)   # CDI, SELIC, IPCA, PTAX_USD
    data: date = Field(index=True)
    valor: Decimal = Field(max_digits=20, decimal_places=8)
    atualizado_em: datetime = Field(default_factory=agora)


class LogSincronizacao(SQLModel, table=True):
    """Historico de cada sincronizacao, para saber quando algo parou de rodar."""

    __tablename__ = "log_sincronizacao"

    id: Optional[int] = Field(default=None, primary_key=True)
    origem: str = Field(index=True)
    iniciado_em: datetime = Field(default_factory=agora)
    concluido_em: Optional[datetime] = None
    sucesso: bool = Field(default=False)
    registros_novos: int = Field(default=0)
    registros_ignorados: int = Field(default=0)
    mensagem: Optional[str] = None
