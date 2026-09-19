"""Derivacao da posicao a partir do livro-razao.

O preco medio segue a regra brasileira: venda nao altera o preco medio, apenas
reduz a quantidade e realiza lucro contra o medio vigente. Desdobramento e
grupamento mexem na quantidade sem tocar no custo total, que e justamente o que
faz o preco medio cair ou subir na proporcao certa.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Iterable, Optional

from sqlmodel import Session, select

from app.config import config
from app.models import (
    IndicadorEconomico,
    PROVENTOS_CAIXA,
    PROVENTOS_RENDA,
    Ativo,
    Conta,
    Cotacao,
    Movimentacao,
    TipoAtivo,
    TipoMovimento,
)

CENTAVO = Decimal("0.01")
OITO = Decimal("0.00000001")


def _q(valor: Decimal, casas: Decimal = CENTAVO) -> Decimal:
    return Decimal(valor).quantize(casas)


@dataclass
class Posicao:
    """Posicao consolidada de um ativo."""

    ativo_id: int
    ticker: str
    nome: Optional[str]
    tipo: TipoAtivo
    moeda: str

    quantidade: Decimal = Decimal(0)
    custo_total: Decimal = Decimal(0)
    lucro_realizado: Decimal = Decimal(0)
    proventos_recebidos: Decimal = Decimal(0)
    proventos_renda: Decimal = Decimal(0)
    amortizacoes: Decimal = Decimal(0)

    preco_atual: Optional[Decimal] = None
    data_preco: Optional[date] = None
    primeira_compra: Optional[date] = None
    ultimo_provento: Optional[date] = None
    contas: set[str] = field(default_factory=set)
    #: True quando alguma entrada veio sem custo conhecido (transferencia de
    #: custodia, por exemplo). O preco medio fica subestimado nesse caso.
    custo_incompleto: bool = False
    #: Quanto vale 1 unidade da moeda do ativo na moeda base. Um ETF americano
    #: em carteira so pode ser somado ao resto depois de passar por aqui.
    taxa_base: Decimal = Decimal(1)

    @property
    def custo_total_base(self) -> Decimal:
        return _q(self.custo_total * self.taxa_base)

    @property
    def valor_atual_base(self) -> Optional[Decimal]:
        valor = self.valor_atual
        return None if valor is None else _q(valor * self.taxa_base)

    @property
    def proventos_base(self) -> Decimal:
        return _q(self.proventos_recebidos * self.taxa_base)

    @property
    def proventos_renda_base(self) -> Decimal:
        return _q(self.proventos_renda * self.taxa_base)

    @property
    def lucro_realizado_base(self) -> Decimal:
        return _q(self.lucro_realizado * self.taxa_base)

    @property
    def preco_medio(self) -> Decimal:
        if self.quantidade <= 0:
            return Decimal(0)
        return _q(self.custo_total / self.quantidade, OITO)

    @property
    def valor_atual(self) -> Optional[Decimal]:
        if self.preco_atual is None:
            return None
        return _q(self.quantidade * self.preco_atual)

    @property
    def lucro_nao_realizado(self) -> Optional[Decimal]:
        valor = self.valor_atual
        if valor is None:
            return None
        return _q(valor - self.custo_total)

    @property
    def rentabilidade(self) -> Optional[Decimal]:
        """Variacao percentual do preco, sem contar provento."""
        lucro = self.lucro_nao_realizado
        if lucro is None or self.custo_total <= 0:
            return None
        return _q(lucro / self.custo_total * 100, Decimal("0.0001"))

    @property
    def retorno_total(self) -> Optional[Decimal]:
        """Rentabilidade somando valorizacao, provento e lucro ja realizado."""
        lucro = self.lucro_nao_realizado
        if lucro is None or self.custo_total <= 0:
            return None
        total = lucro + self.proventos_renda + self.lucro_realizado
        return _q(total / self.custo_total * 100, Decimal("0.0001"))

    @property
    def yield_on_cost(self) -> Optional[Decimal]:
        """Provento acumulado sobre o custo da posicao atual.

        Amortizacao fica de fora porque e devolucao de principal, nao renda.
        """
        if self.custo_total <= 0:
            return None
        return _q(self.proventos_renda / self.custo_total * 100, Decimal("0.0001"))


def taxas_cambio(sessao: Session) -> dict[str, Decimal]:
    """Ultima taxa conhecida de cada moeda estrangeira contra a moeda base.

    Sem PTAX gravada a taxa fica em 1, o que mantem o numero errado em vez de
    quebrar o painel. `ResumoCarteira.cambio_ausente` denuncia o caso.
    """
    taxas: dict[str, Decimal] = {config.moeda_base: Decimal(1)}
    for indicador in sessao.exec(
        select(IndicadorEconomico)
        .where(IndicadorEconomico.codigo.like("PTAX_%"))
        .order_by(IndicadorEconomico.data)
    ).all():
        taxas[indicador.codigo.removeprefix("PTAX_")] = indicador.valor
    return taxas


def _cotacoes_recentes(sessao: Session) -> dict[int, tuple[Decimal, date]]:
    """Ultima cotacao conhecida de cada ativo."""
    saida: dict[int, tuple[Decimal, date]] = {}
    for cot in sessao.exec(select(Cotacao).order_by(Cotacao.data)).all():
        saida[cot.ativo_id] = (cot.fechamento, cot.data)
    return saida


def calcular_posicoes(
    sessao: Session,
    *,
    ate: Optional[date] = None,
    incluir_zeradas: bool = False,
) -> list[Posicao]:
    """Roda o livro-razao em ordem cronologica e devolve a posicao por ativo."""
    ativos = {a.id: a for a in sessao.exec(select(Ativo)).all()}
    contas = {c.id: c.nome for c in sessao.exec(select(Conta)).all()}

    consulta = select(Movimentacao).order_by(Movimentacao.data, Movimentacao.id)
    if ate:
        consulta = consulta.where(Movimentacao.data <= ate)

    posicoes: dict[int, Posicao] = {}
    for mov in sessao.exec(consulta).all():
        if mov.ativo_id is None:
            continue
        ativo = ativos.get(mov.ativo_id)
        if ativo is None:
            continue

        pos = posicoes.get(mov.ativo_id)
        if pos is None:
            pos = Posicao(
                ativo_id=ativo.id,
                ticker=ativo.ticker,
                nome=ativo.nome,
                tipo=ativo.tipo,
                moeda=ativo.moeda,
            )
            posicoes[mov.ativo_id] = pos

        pos.contas.add(contas.get(mov.conta_id, "?"))
        _aplicar(pos, mov)

    precos = _cotacoes_recentes(sessao)
    taxas = taxas_cambio(sessao)
    for pos in posicoes.values():
        preco = precos.get(pos.ativo_id)
        if preco:
            pos.preco_atual, pos.data_preco = preco
        pos.taxa_base = taxas.get(pos.moeda, Decimal(1))

    saida = list(posicoes.values())
    if not incluir_zeradas:
        saida = [p for p in saida if p.quantidade > 0]
    saida.sort(key=lambda p: (p.valor_atual or p.custo_total), reverse=True)
    return saida


def _aplicar(pos: Posicao, mov: Movimentacao) -> None:
    """Aplica um lancamento sobre a posicao acumulada."""
    tipo = mov.tipo
    quantidade = Decimal(mov.quantidade or 0)
    valor = Decimal(mov.valor_liquido or 0)

    if tipo in PROVENTOS_CAIXA:
        pos.proventos_recebidos += valor
        if tipo in PROVENTOS_RENDA:
            pos.proventos_renda += valor
        else:
            # Amortizacao devolve principal, entao reduz o custo da posicao.
            pos.amortizacoes += valor
            pos.custo_total = max(Decimal(0), pos.custo_total - valor)
        if pos.ultimo_provento is None or mov.data > pos.ultimo_provento:
            pos.ultimo_provento = mov.data
        return

    if tipo in (TipoMovimento.COMPRA, TipoMovimento.APLICACAO, TipoMovimento.SUBSCRICAO):
        pos.quantidade += quantidade
        pos.custo_total += valor
        if pos.primeira_compra is None:
            pos.primeira_compra = mov.data
        return

    if tipo in (TipoMovimento.VENDA, TipoMovimento.RESGATE):
        if pos.quantidade <= 0:
            # Venda sem posicao registrada significa historico incompleto.
            pos.custo_incompleto = True
            pos.lucro_realizado += valor
            return
        vendida = min(quantidade, pos.quantidade)
        medio = pos.custo_total / pos.quantidade
        custo_baixado = medio * vendida
        pos.custo_total -= custo_baixado
        pos.quantidade -= vendida
        pos.lucro_realizado += valor - custo_baixado
        return

    if tipo == TipoMovimento.TRANSFERENCIA_ENTRADA:
        pos.quantidade += quantidade
        if valor > 0:
            pos.custo_total += valor
        else:
            # Entrou papel sem custo informado: o preco medio fica otimista e o
            # painel precisa avisar em vez de mentir.
            pos.custo_incompleto = True
        if pos.primeira_compra is None:
            pos.primeira_compra = mov.data
        return

    if tipo == TipoMovimento.TRANSFERENCIA_SAIDA:
        if pos.quantidade > 0:
            saida = min(quantidade, pos.quantidade)
            medio = pos.custo_total / pos.quantidade
            pos.custo_total -= medio * saida
            pos.quantidade -= saida
        return

    if tipo == TipoMovimento.BONIFICACAO:
        # Bonificacao entra com o custo declarado pela empresa, que costuma ser
        # zero. Quantidade sobe, custo quase nao muda, preco medio cai.
        pos.quantidade += quantidade
        pos.custo_total += valor
        return

    if tipo == TipoMovimento.DESDOBRAMENTO:
        pos.quantidade += quantidade
        return

    if tipo in (TipoMovimento.GRUPAMENTO, TipoMovimento.FRACAO):
        pos.quantidade = max(Decimal(0), pos.quantidade - quantidade)
        return

    if tipo in (TipoMovimento.TAXA, TipoMovimento.IMPOSTO):
        pos.custo_total += valor
        return


@dataclass
class ResumoCarteira:
    valor_investido: Decimal = Decimal(0)
    valor_atual: Decimal = Decimal(0)
    lucro_nao_realizado: Decimal = Decimal(0)
    lucro_realizado: Decimal = Decimal(0)
    proventos_total: Decimal = Decimal(0)
    proventos_12m: Decimal = Decimal(0)
    quantidade_ativos: int = 0
    sem_cotacao: list[str] = field(default_factory=list)
    #: Moedas presentes na carteira sem taxa de conversao conhecida.
    cambio_ausente: list[str] = field(default_factory=list)
    por_tipo: dict[str, dict] = field(default_factory=dict)

    @property
    def rentabilidade(self) -> Optional[Decimal]:
        if self.valor_investido <= 0:
            return None
        return _q(self.lucro_nao_realizado / self.valor_investido * 100, Decimal("0.0001"))

    @property
    def yield_on_cost(self) -> Optional[Decimal]:
        if self.valor_investido <= 0:
            return None
        return _q(self.proventos_12m / self.valor_investido * 100, Decimal("0.0001"))


def resumir(posicoes: Iterable[Posicao], *, proventos_12m: Decimal = Decimal(0)) -> ResumoCarteira:
    """Consolida a carteira e a quebra por classe de ativo."""
    resumo = ResumoCarteira(proventos_12m=proventos_12m)
    por_tipo: dict[str, dict] = defaultdict(
        lambda: {"custo": Decimal(0), "valor": Decimal(0), "proventos": Decimal(0), "ativos": 0}
    )

    faltando_cambio: set[str] = set()
    for pos in posicoes:
        resumo.quantidade_ativos += 1
        # Tudo daqui para baixo esta na moeda base, senao dolar e real se
        # somariam como se valessem a mesma coisa.
        resumo.valor_investido += pos.custo_total_base
        resumo.lucro_realizado += pos.lucro_realizado_base
        resumo.proventos_total += pos.proventos_base

        if pos.moeda != config.moeda_base and pos.taxa_base == 1:
            faltando_cambio.add(pos.moeda)

        valor = pos.valor_atual_base
        if valor is None:
            # Sem cotacao, o custo e a melhor estimativa disponivel.
            valor = pos.custo_total_base
            resumo.sem_cotacao.append(pos.ticker)
        resumo.valor_atual += valor

        chave = pos.tipo.value
        por_tipo[chave]["custo"] += pos.custo_total_base
        por_tipo[chave]["valor"] += valor
        por_tipo[chave]["proventos"] += pos.proventos_base
        por_tipo[chave]["ativos"] += 1

    resumo.cambio_ausente = sorted(faltando_cambio)

    resumo.lucro_nao_realizado = _q(resumo.valor_atual - resumo.valor_investido)
    total = resumo.valor_atual or Decimal(1)
    resumo.por_tipo = {
        chave: {
            **{k: _q(v) if isinstance(v, Decimal) else v for k, v in dados.items()},
            "percentual": _q(dados["valor"] / total * 100, Decimal("0.01")),
        }
        for chave, dados in sorted(por_tipo.items(), key=lambda kv: kv[1]["valor"], reverse=True)
    }
    return resumo
