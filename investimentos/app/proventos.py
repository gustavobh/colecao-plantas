"""Tudo que responde a pergunta "quanto eu recebi de provento".

Uma distincao percorre o arquivo inteiro: recebido em caixa nao e a mesma coisa
que renda. Amortizacao de FII cai na conta igual a um rendimento, so que e o
fundo devolvendo principal. Somar as duas coisas infla o yield e faz um fundo
em liquidacao parecer o melhor pagador da carteira.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional

from sqlmodel import Session, select

from app.carteira import taxas_cambio
from app.config import config
from app.models import (
    PROVENTOS_CAIXA,
    PROVENTOS_RENDA,
    Ativo,
    Conta,
    Movimentacao,
    ProventoAnunciado,
    TipoAtivo,
    TipoMovimento,
)

CENTAVO = Decimal("0.01")


def _q(valor: Decimal, casas: Decimal = CENTAVO) -> Decimal:
    return Decimal(valor).quantize(casas)


def _chave_mes(dia: date) -> str:
    return f"{dia.year:04d}-{dia.month:02d}"


def _meses_atras(referencia: date, quantidade: int) -> date:
    ano, mes = referencia.year, referencia.month - quantidade
    while mes <= 0:
        mes += 12
        ano -= 1
    return date(ano, mes, 1)


def valor_base(mov: Movimentacao, taxas: dict[str, Decimal]) -> Decimal:
    """Valor do provento na moeda base da carteira.

    A taxa gravada no lancamento tem prioridade, porque e a do dia em que o
    dinheiro entrou. Quando ela falta, a taxa atual serve de aproximacao: sem
    isso um dividendo em dolar entraria somado como se fosse real.
    """
    if mov.valor_liquido_base is not None:
        return Decimal(mov.valor_liquido_base)
    liquido = Decimal(mov.valor_liquido or 0)
    if mov.moeda == config.moeda_base:
        return liquido
    return liquido * taxas.get(mov.moeda, Decimal(1))


def _consulta_proventos(sessao: Session, *, desde: Optional[date] = None, ate: Optional[date] = None):
    consulta = select(Movimentacao, Ativo).join(Ativo, Movimentacao.ativo_id == Ativo.id)
    consulta = consulta.where(Movimentacao.tipo.in_([t.value for t in PROVENTOS_CAIXA]))
    if desde:
        consulta = consulta.where(Movimentacao.data >= desde)
    if ate:
        consulta = consulta.where(Movimentacao.data <= ate)
    return sessao.exec(consulta.order_by(Movimentacao.data)).all()


# --------------------------------------------------------------------------
# Serie mensal
# --------------------------------------------------------------------------


@dataclass
class MesProvento:
    mes: str
    total: Decimal = Decimal(0)
    renda: Decimal = Decimal(0)
    amortizacao: Decimal = Decimal(0)
    por_tipo: dict[str, Decimal] = field(default_factory=dict)
    quantidade_pagamentos: int = 0


def serie_mensal(sessao: Session, *, meses: int = 24, ate: Optional[date] = None) -> list[MesProvento]:
    """Provento recebido mes a mes, com os meses vazios preenchidos com zero.

    Sem os zeros o grafico mente: um mes sem pagamento some do eixo e a linha
    liga dois meses distantes como se fossem consecutivos.
    """
    ate = ate or date.today()
    inicio = _meses_atras(ate.replace(day=1), meses - 1)

    acumulado: dict[str, MesProvento] = {}
    cursor = inicio
    while cursor <= ate:
        acumulado[_chave_mes(cursor)] = MesProvento(mes=_chave_mes(cursor))
        cursor = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)

    taxas = taxas_cambio(sessao)
    for mov, _ativo in _consulta_proventos(sessao, desde=inicio, ate=ate):
        chave = _chave_mes(mov.data)
        alvo = acumulado.get(chave)
        if alvo is None:
            continue
        valor = valor_base(mov, taxas)
        alvo.total += valor
        alvo.quantidade_pagamentos += 1
        if mov.tipo in PROVENTOS_RENDA:
            alvo.renda += valor
        else:
            alvo.amortizacao += valor
        alvo.por_tipo[mov.tipo.value] = alvo.por_tipo.get(mov.tipo.value, Decimal(0)) + valor

    saida = [acumulado[k] for k in sorted(acumulado)]
    for mes in saida:
        mes.total = _q(mes.total)
        mes.renda = _q(mes.renda)
        mes.amortizacao = _q(mes.amortizacao)
        mes.por_tipo = {k: _q(v) for k, v in sorted(mes.por_tipo.items())}
    return saida


# --------------------------------------------------------------------------
# Ranking por ativo
# --------------------------------------------------------------------------


@dataclass
class ProventoPorAtivo:
    ticker: str
    nome: Optional[str]
    tipo: TipoAtivo
    total: Decimal = Decimal(0)
    renda: Decimal = Decimal(0)
    amortizacao: Decimal = Decimal(0)
    pagamentos: int = 0
    primeiro: Optional[date] = None
    ultimo: Optional[date] = None
    por_tipo: dict[str, Decimal] = field(default_factory=dict)
    #: Preenchido pelo router, que tem acesso ao custo da posicao.
    yield_on_cost: Optional[Decimal] = None
    participacao: Optional[Decimal] = None


def por_ativo(
    sessao: Session, *, desde: Optional[date] = None, ate: Optional[date] = None
) -> list[ProventoPorAtivo]:
    """Quanto cada papel pagou no periodo, do maior para o menor."""
    acumulado: dict[str, ProventoPorAtivo] = {}
    taxas = taxas_cambio(sessao)

    for mov, ativo in _consulta_proventos(sessao, desde=desde, ate=ate):
        alvo = acumulado.get(ativo.ticker)
        if alvo is None:
            alvo = ProventoPorAtivo(ticker=ativo.ticker, nome=ativo.nome, tipo=ativo.tipo)
            acumulado[ativo.ticker] = alvo

        valor = valor_base(mov, taxas)
        alvo.total += valor
        alvo.pagamentos += 1
        if mov.tipo in PROVENTOS_RENDA:
            alvo.renda += valor
        else:
            alvo.amortizacao += valor
        alvo.por_tipo[mov.tipo.value] = alvo.por_tipo.get(mov.tipo.value, Decimal(0)) + valor
        if alvo.primeiro is None or mov.data < alvo.primeiro:
            alvo.primeiro = mov.data
        if alvo.ultimo is None or mov.data > alvo.ultimo:
            alvo.ultimo = mov.data

    total_geral = sum((a.total for a in acumulado.values()), Decimal(0)) or Decimal(1)
    saida = sorted(acumulado.values(), key=lambda a: a.total, reverse=True)
    for item in saida:
        item.participacao = _q(item.total / total_geral * 100, Decimal("0.01"))
        item.total = _q(item.total)
        item.renda = _q(item.renda)
        item.amortizacao = _q(item.amortizacao)
        item.por_tipo = {k: _q(v) for k, v in sorted(item.por_tipo.items())}
    return saida


def por_tipo_ativo(sessao: Session, *, desde: Optional[date] = None) -> dict[str, Decimal]:
    """Provento agrupado por classe (acao, FII, renda fixa, ETF)."""
    acumulado: dict[str, Decimal] = defaultdict(Decimal)
    taxas = taxas_cambio(sessao)
    for mov, ativo in _consulta_proventos(sessao, desde=desde):
        acumulado[ativo.tipo.value] += valor_base(mov, taxas)
    return {k: _q(v) for k, v in sorted(acumulado.items(), key=lambda kv: kv[1], reverse=True)}


def por_conta(sessao: Session, *, desde: Optional[date] = None) -> dict[str, Decimal]:
    """Provento agrupado pela instituicao que creditou."""
    contas = {c.id: c.nome for c in sessao.exec(select(Conta)).all()}
    acumulado: dict[str, Decimal] = defaultdict(Decimal)
    taxas = taxas_cambio(sessao)
    for mov, _ativo in _consulta_proventos(sessao, desde=desde):
        acumulado[contas.get(mov.conta_id, "?")] += valor_base(mov, taxas)
    return {k: _q(v) for k, v in sorted(acumulado.items(), key=lambda kv: kv[1], reverse=True)}


# --------------------------------------------------------------------------
# Resumo e projecao
# --------------------------------------------------------------------------


@dataclass
class ResumoProventos:
    total_geral: Decimal = Decimal(0)
    total_12m: Decimal = Decimal(0)
    renda_12m: Decimal = Decimal(0)
    total_ano: Decimal = Decimal(0)
    total_mes: Decimal = Decimal(0)
    media_mensal_12m: Decimal = Decimal(0)
    melhor_mes: Optional[str] = None
    melhor_mes_valor: Decimal = Decimal(0)
    meses_com_pagamento: int = 0
    ativos_pagadores: int = 0
    projecao_12m: Decimal = Decimal(0)
    crescimento_12m: Optional[Decimal] = None


def resumir(sessao: Session, *, hoje: Optional[date] = None) -> ResumoProventos:
    """Indicadores de topo do painel."""
    hoje = hoje or date.today()
    resumo = ResumoProventos()

    inicio_12m = _meses_atras(hoje.replace(day=1), 11)
    inicio_24m = _meses_atras(hoje.replace(day=1), 23)
    inicio_ano = date(hoje.year, 1, 1)
    inicio_mes = hoje.replace(day=1)

    tickers_pagadores: set[int] = set()
    anterior_12m = Decimal(0)
    taxas = taxas_cambio(sessao)

    for mov, _ativo in _consulta_proventos(sessao):
        valor = valor_base(mov, taxas)
        resumo.total_geral += valor
        if mov.ativo_id:
            tickers_pagadores.add(mov.ativo_id)
        if mov.data >= inicio_12m:
            resumo.total_12m += valor
            if mov.tipo in PROVENTOS_RENDA:
                resumo.renda_12m += valor
        elif mov.data >= inicio_24m:
            anterior_12m += valor
        if mov.data >= inicio_ano:
            resumo.total_ano += valor
        if mov.data >= inicio_mes:
            resumo.total_mes += valor

    resumo.ativos_pagadores = len(tickers_pagadores)

    serie = serie_mensal(sessao, meses=12, ate=hoje)
    com_pagamento = [m for m in serie if m.total > 0]
    resumo.meses_com_pagamento = len(com_pagamento)
    if serie:
        melhor = max(serie, key=lambda m: m.total)
        if melhor.total > 0:
            resumo.melhor_mes = melhor.mes
            resumo.melhor_mes_valor = melhor.total

    # A media divide pelos 12 meses do periodo, nao pelos meses que tiveram
    # pagamento: o que interessa e o fluxo medio de caixa, e mes sem credito
    # tambem e informacao.
    resumo.media_mensal_12m = _q(resumo.total_12m / 12) if resumo.total_12m else Decimal(0)

    if anterior_12m > 0:
        resumo.crescimento_12m = _q(
            (resumo.total_12m - anterior_12m) / anterior_12m * 100, Decimal("0.01")
        )

    resumo.projecao_12m = projetar_12m(sessao, hoje=hoje)

    for campo in ("total_geral", "total_12m", "renda_12m", "total_ano", "total_mes"):
        setattr(resumo, campo, _q(getattr(resumo, campo)))
    return resumo


def projetar_12m(sessao: Session, *, hoje: Optional[date] = None) -> Decimal:
    """Estimativa do que a carteira paga nos proximos 12 meses.

    O metodo e deliberadamente simples: repete o recebido nos ultimos 12 meses,
    descontando amortizacao. Projecao de dividendo com modelo sofisticado da
    uma falsa sensacao de precisao, porque a empresa muda a politica de
    distribuicao quando quiser.
    """
    hoje = hoje or date.today()
    inicio = _meses_atras(hoje.replace(day=1), 11)
    total = Decimal(0)
    taxas = taxas_cambio(sessao)
    for mov, _ativo in _consulta_proventos(sessao, desde=inicio, ate=hoje):
        if mov.tipo in PROVENTOS_RENDA:
            total += valor_base(mov, taxas)
    return _q(total)


# --------------------------------------------------------------------------
# Calendario
# --------------------------------------------------------------------------


@dataclass
class EventoCalendario:
    ticker: str
    nome: Optional[str]
    tipo: str
    data_com: Optional[date]
    data_pagamento: Optional[date]
    valor_por_cota: Decimal
    quantidade: Decimal
    valor_estimado: Decimal
    ja_tem_direito: bool


def calendario(
    sessao: Session, *, hoje: Optional[date] = None, quantidades: Optional[dict[int, Decimal]] = None
) -> list[EventoCalendario]:
    """Proventos anunciados e ainda nao pagos, com o valor que voce vai receber.

    `ja_tem_direito` compara a data-com com hoje: passada a data-com, comprar
    mais nao aumenta o recebimento deste evento.
    """
    hoje = hoje or date.today()
    quantidades = quantidades or {}

    consulta = (
        select(ProventoAnunciado, Ativo)
        .join(Ativo, ProventoAnunciado.ativo_id == Ativo.id)
        .where(
            (ProventoAnunciado.data_pagamento.is_(None)) | (ProventoAnunciado.data_pagamento >= hoje)
        )
        .order_by(ProventoAnunciado.data_pagamento, ProventoAnunciado.data_com)
    )

    saida: list[EventoCalendario] = []
    for anuncio, ativo in sessao.exec(consulta).all():
        quantidade = quantidades.get(ativo.id, Decimal(0))
        saida.append(
            EventoCalendario(
                ticker=ativo.ticker,
                nome=ativo.nome,
                tipo=anuncio.tipo.value,
                data_com=anuncio.data_com,
                data_pagamento=anuncio.data_pagamento,
                valor_por_cota=anuncio.valor_por_cota,
                quantidade=quantidade,
                valor_estimado=_q(quantidade * anuncio.valor_por_cota),
                ja_tem_direito=bool(anuncio.data_com and anuncio.data_com <= hoje),
            )
        )
    return saida


def historico_por_cota(sessao: Session, ativo_id: int) -> list[dict]:
    """Serie de provento por cota de um papel, para ver se a distribuicao cresce."""
    consulta = (
        select(ProventoAnunciado)
        .where(ProventoAnunciado.ativo_id == ativo_id)
        .order_by(ProventoAnunciado.data_pagamento)
    )
    return [
        {
            "tipo": p.tipo.value,
            "data_com": p.data_com,
            "data_pagamento": p.data_pagamento,
            "valor_por_cota": p.valor_por_cota,
        }
        for p in sessao.exec(consulta).all()
    ]
