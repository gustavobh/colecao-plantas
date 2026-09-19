"""Teste de fumaca da API: todo endpoint de leitura responde em carteira vazia.

Carteira vazia e o estado do primeiro dia de uso, e e onde divisao por zero e
lista vazia costumam derrubar painel.
"""
from __future__ import annotations

import pytest
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine

from app.db import get_session
from app.main import app


@pytest.fixture()
def cliente():
    motor = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(motor)

    def sessao_de_teste():
        with Session(motor) as s:
            yield s

    app.dependency_overrides[get_session] = sessao_de_teste
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.mark.parametrize(
    "caminho",
    [
        "/saude",
        "/api/config",
        "/api/resumo",
        "/api/posicoes",
        "/api/contas",
        "/api/divergencias",
        "/api/sincronizacoes",
        "/api/proventos/resumo",
        "/api/proventos/mensal?meses=12",
        "/api/proventos/por-ativo",
        "/api/proventos/por-classe",
        "/api/proventos/por-conta",
        "/api/proventos/calendario",
    ],
)
def test_endpoint_responde_com_carteira_vazia(cliente, caminho):
    resposta = cliente.get(caminho)
    assert resposta.status_code == 200, resposta.text


def test_resumo_vazio_nao_divide_por_zero(cliente):
    corpo = cliente.get("/api/resumo").json()
    assert corpo["quantidade_ativos"] == 0
    assert corpo["rentabilidade"] is None
    assert corpo["yield_on_cost"] is None


def test_serie_mensal_vazia_ainda_traz_os_meses(cliente):
    corpo = cliente.get("/api/proventos/mensal?meses=12").json()
    assert len(corpo) == 12
    assert all(m["total"] == "0.00" for m in corpo)


def test_lancamento_manual_entra_e_aparece_na_posicao(cliente):
    criado = cliente.post("/api/movimentacoes", json={
        "data": "2026-05-10", "ticker": "petr4", "tipo": "COMPRA",
        "quantidade": "100", "preco_unitario": "30.00", "conta": "Manual",
    })
    assert criado.status_code == 200
    assert criado.json()["criado"] is True

    posicoes = cliente.get("/api/posicoes").json()
    assert len(posicoes) == 1
    assert posicoes[0]["ticker"] == "PETR4"          # normalizado para maiusculas
    assert posicoes[0]["custo_total"] == "3000.00"   # derivado de qtd x preco


def test_lancamento_repetido_e_recusado_como_duplicata(cliente):
    corpo = {"data": "2026-05-10", "ticker": "PETR4", "tipo": "DIVIDENDO", "valor_liquido": "120.00"}
    assert cliente.post("/api/movimentacoes", json=corpo).json()["criado"] is True
    assert cliente.post("/api/movimentacoes", json=corpo).json()["duplicado"] is True


def test_pluggy_sem_credencial_explica_o_que_fazer(cliente):
    resposta = cliente.post("/api/sincronizar/pluggy")
    assert resposta.status_code == 400
    assert "meu.pluggy.ai" in resposta.json()["detail"]


def test_import_recusa_arquivo_que_nao_e_planilha(cliente):
    resposta = cliente.post(
        "/api/importar/b3",
        files={"arquivo": ("extrato.pdf", b"%PDF-1.4", "application/pdf")},
    )
    assert resposta.status_code == 400
