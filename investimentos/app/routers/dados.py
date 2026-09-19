"""Endpoints de entrada de dados: import de arquivo, sincronizacao e lancamento manual."""
from __future__ import annotations

import io
import logging
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlmodel import Session, select

from app.carteira import calcular_posicoes
from app.config import config
from app.db import get_session, obter_ou_criar_ativo, obter_ou_criar_conta, registrar_movimentacao
from app.fontes import bcb, brapi, yahoo
from app.importadores import b3_movimentacao
from app.models import (
    Ativo,
    Cotacao,
    Fonte,
    Instituicao,
    LogSincronizacao,
    Movimentacao,
    ProventoAnunciado,
    TipoAtivo,
    TipoMovimento,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["dados"])

#: Classes cotadas em bolsa brasileira, atendidas pela brapi.
TIPOS_BR = {TipoAtivo.ACAO, TipoAtivo.FII, TipoAtivo.ETF_BR, TipoAtivo.BDR}
#: Classes cotadas fora do Brasil, atendidas pelo Yahoo.
TIPOS_US = {TipoAtivo.ETF_US, TipoAtivo.STOCK_US, TipoAtivo.REIT_US}


def _registrar_log(sessao: Session, origem: str, *, sucesso: bool, novos: int, ignorados: int, msg: str) -> None:
    sessao.add(
        LogSincronizacao(
            origem=origem,
            concluido_em=datetime.now(timezone.utc),
            sucesso=sucesso,
            registros_novos=novos,
            registros_ignorados=ignorados,
            mensagem=msg[:500],
        )
    )
    sessao.commit()


@router.post("/importar/b3")
async def importar_b3(
    arquivo: UploadFile = File(..., description="Excel de Movimentacao da Area do Investidor"),
    sessao: Session = Depends(get_session),
) -> dict:
    """Importa o Excel de Movimentacao da B3. Reimportar o mesmo arquivo e seguro."""
    if not arquivo.filename or not arquivo.filename.lower().endswith((".xlsx", ".xls")):
        raise HTTPException(400, "Envie o arquivo .xlsx exportado pela Area do Investidor da B3.")

    conteudo = await arquivo.read()
    try:
        resultado = b3_movimentacao.importar(sessao, io.BytesIO(conteudo))
    except Exception as erro:  # openpyxl falha de varias formas em arquivo torto
        log.exception("import da B3 falhou")
        _registrar_log(sessao, "b3_movimentacao", sucesso=False, novos=0, ignorados=0, msg=str(erro))
        raise HTTPException(400, f"Nao consegui ler a planilha: {erro}") from erro

    _registrar_log(
        sessao,
        "b3_movimentacao",
        sucesso=True,
        novos=resultado.novos,
        ignorados=resultado.ignorados,
        msg=resultado.resumo(),
    )
    return {
        "arquivo": arquivo.filename,
        "linhas_lidas": resultado.linhas_lidas,
        "novos": resultado.novos,
        "duplicados": resultado.duplicados,
        "ignorados": resultado.ignorados,
        "avisos": resultado.avisos,
        "resumo": resultado.resumo(),
    }


@router.post("/sincronizar/pluggy")
def sincronizar_pluggy(sessao: Session = Depends(get_session)) -> dict:
    """Puxa as conexoes do Meu Pluggy (B3, Nubank, Inter e o que mais estiver ligado)."""
    if not config.pluggy_configurado:
        raise HTTPException(
            400,
            "Pluggy nao configurado. Crie a conta gratuita em https://meu.pluggy.ai, "
            "conecte suas instituicoes e coloque PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no .env.",
        )

    from app.conectores.pluggy import ErroPluggy, sincronizar

    try:
        resultado = sincronizar(sessao)
    except ErroPluggy as erro:
        _registrar_log(sessao, "pluggy", sucesso=False, novos=0, ignorados=0, msg=str(erro))
        raise HTTPException(502, str(erro)) from erro

    _registrar_log(
        sessao, "pluggy", sucesso=True, novos=resultado.novos, ignorados=resultado.duplicados, msg=resultado.resumo()
    )
    return {
        "conexoes": resultado.itens,
        "novos": resultado.novos,
        "duplicados": resultado.duplicados,
        "posicoes": resultado.posicoes,
        "avisos": resultado.avisos,
        "resumo": resultado.resumo(),
    }


@router.post("/sincronizar/cotacoes")
def sincronizar_cotacoes(sessao: Session = Depends(get_session)) -> dict:
    """Atualiza o preco de todos os ativos em carteira.

    Cada fonte falha de forma independente: brapi fora do ar nao impede a
    atualizacao dos ativos americanos.
    """
    posicoes = calcular_posicoes(sessao)
    ativos = {p.ticker: p for p in posicoes}
    hoje = date.today()

    br = [p.ticker for p in posicoes if p.tipo in TIPOS_BR]
    us = [p.ticker for p in posicoes if p.tipo in TIPOS_US]

    precos: dict[str, Decimal] = {}
    avisos: list[str] = []

    if br:
        try:
            precos.update(brapi.cotacoes(br))
        except brapi.ErroBrapi as erro:
            avisos.append(str(erro))
    if us:
        try:
            precos.update(yahoo.cotacoes(us))
        except yahoo.ErroYahoo as erro:
            avisos.append(str(erro))

    atualizados = 0
    for ticker, preco in precos.items():
        pos = ativos.get(ticker)
        if pos is None:
            continue
        existente = sessao.exec(
            select(Cotacao).where(Cotacao.ativo_id == pos.ativo_id, Cotacao.data == hoje)
        ).first()
        if existente:
            existente.fechamento = preco
            sessao.add(existente)
        else:
            sessao.add(
                Cotacao(
                    ativo_id=pos.ativo_id,
                    data=hoje,
                    fechamento=preco,
                    moeda=pos.moeda,
                    fonte="brapi" if pos.tipo in TIPOS_BR else "yahoo",
                )
            )
        atualizados += 1

    sem_preco = sorted(set(br + us) - set(precos))
    if sem_preco:
        avisos.append(f"Sem cotacao para: {', '.join(sem_preco)}")

    sessao.commit()
    _registrar_log(sessao, "cotacoes", sucesso=True, novos=atualizados, ignorados=len(sem_preco), msg="; ".join(avisos))
    return {"atualizados": atualizados, "sem_cotacao": sem_preco, "avisos": avisos}


@router.post("/sincronizar/proventos")
def sincronizar_proventos(sessao: Session = Depends(get_session)) -> dict:
    """Baixa o historico de provento por cota, que alimenta calendario e projecao."""
    posicoes = calcular_posicoes(sessao)
    novos = 0
    avisos: list[str] = []

    for pos in posicoes:
        if pos.tipo in TIPOS_BR:
            try:
                lista = brapi.proventos(pos.ticker)
            except brapi.ErroBrapi as erro:
                avisos.append(f"{pos.ticker}: {erro}")
                continue
        elif pos.tipo in TIPOS_US:
            lista = [
                {**p, "tipo": TipoMovimento.DIVIDENDO}
                for p in yahoo.proventos(pos.ticker)
            ]
        else:
            continue

        for item in lista:
            tipo = item.get("tipo") or TipoMovimento.DIVIDENDO
            existente = sessao.exec(
                select(ProventoAnunciado).where(
                    ProventoAnunciado.ativo_id == pos.ativo_id,
                    ProventoAnunciado.data_com == item.get("data_com"),
                    ProventoAnunciado.tipo == tipo,
                    ProventoAnunciado.valor_por_cota == item["valor_por_cota"],
                )
            ).first()
            if existente:
                continue
            sessao.add(
                ProventoAnunciado(
                    ativo_id=pos.ativo_id,
                    tipo=tipo,
                    data_com=item.get("data_com"),
                    data_pagamento=item.get("data_pagamento"),
                    valor_por_cota=item["valor_por_cota"],
                    moeda=item.get("moeda", "BRL"),
                    fonte="brapi" if pos.tipo in TIPOS_BR else "yahoo",
                )
            )
            novos += 1

    sessao.commit()
    _registrar_log(sessao, "proventos", sucesso=True, novos=novos, ignorados=0, msg="; ".join(avisos))
    return {"novos": novos, "avisos": avisos}


@router.post("/sincronizar/cambio")
def sincronizar_cambio(sessao: Session = Depends(get_session)) -> dict:
    """Guarda a PTAX do dia, usada para consolidar a parte em dolar."""
    from app.models import IndicadorEconomico

    cotacao = bcb.cotacao_dolar()
    if cotacao is None:
        raise HTTPException(502, "Banco Central nao respondeu com a PTAX.")

    hoje = date.today()
    existente = sessao.exec(
        select(IndicadorEconomico).where(
            IndicadorEconomico.codigo == "PTAX_USD", IndicadorEconomico.data == hoje
        )
    ).first()
    if existente:
        existente.valor = cotacao
        sessao.add(existente)
    else:
        sessao.add(IndicadorEconomico(codigo="PTAX_USD", data=hoje, valor=cotacao))
    sessao.commit()
    return {"ptax_usd": cotacao, "data": hoje}


class LancamentoManual(BaseModel):
    data: date
    ticker: str
    tipo: TipoMovimento
    conta: str = "Manual"
    quantidade: Decimal = Decimal(0)
    preco_unitario: Optional[Decimal] = None
    valor_liquido: Decimal = Decimal(0)
    ir_retido: Decimal = Decimal(0)
    moeda: str = "BRL"
    nome_ativo: Optional[str] = None
    tipo_ativo: Optional[TipoAtivo] = None
    observacao: Optional[str] = None


@router.post("/movimentacoes")
def criar_movimentacao(corpo: LancamentoManual, sessao: Session = Depends(get_session)) -> dict:
    """Lancamento digitado a mao, para o que nenhuma fonte automatica traz."""
    conta = obter_ou_criar_conta(sessao, corpo.conta, instituicao=Instituicao.MANUAL)
    ativo = obter_ou_criar_ativo(
        sessao, corpo.ticker, nome=corpo.nome_ativo, tipo=corpo.tipo_ativo, moeda=corpo.moeda
    )

    valor = corpo.valor_liquido
    if valor == 0 and corpo.quantidade and corpo.preco_unitario:
        valor = (corpo.quantidade * corpo.preco_unitario).quantize(Decimal("0.01"))

    mov = Movimentacao(
        data=corpo.data,
        conta_id=conta.id,
        ativo_id=ativo.id,
        tipo=corpo.tipo,
        quantidade=corpo.quantidade,
        preco_unitario=corpo.preco_unitario,
        valor_bruto=valor + corpo.ir_retido,
        ir_retido=corpo.ir_retido,
        valor_liquido=valor,
        moeda=corpo.moeda,
        fonte=Fonte.MANUAL,
        observacao=corpo.observacao,
    )
    inserido = registrar_movimentacao(sessao, mov)
    sessao.commit()
    return {"criado": inserido, "id": mov.id, "duplicado": not inserido}


@router.delete("/movimentacoes/{movimentacao_id}")
def remover_movimentacao(movimentacao_id: int, sessao: Session = Depends(get_session)) -> dict:
    """Remove um lancamento. Unica porta de saida do livro-razao, e so manual."""
    mov = sessao.get(Movimentacao, movimentacao_id)
    if mov is None:
        raise HTTPException(404, "Movimentacao nao encontrada.")
    sessao.delete(mov)
    sessao.commit()
    return {"removido": movimentacao_id}


@router.get("/sincronizacoes")
def historico_sincronizacoes(sessao: Session = Depends(get_session)) -> list[dict]:
    registros = sessao.exec(
        select(LogSincronizacao).order_by(LogSincronizacao.iniciado_em.desc()).limit(20)
    ).all()
    return [
        {
            "origem": r.origem,
            "quando": r.concluido_em or r.iniciado_em,
            "sucesso": r.sucesso,
            "novos": r.registros_novos,
            "mensagem": r.mensagem,
        }
        for r in registros
    ]


@router.get("/config")
def estado_configuracao() -> dict:
    """O painel usa isso para avisar o que falta configurar."""
    return {
        "pluggy": config.pluggy_configurado,
        "brapi_token": bool(config.brapi_token),
        "moeda_base": config.moeda_base,
    }
