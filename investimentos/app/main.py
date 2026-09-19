"""Aplicacao FastAPI.

Sobe com:

    uvicorn app.main:app --reload

O painel fica em http://127.0.0.1:8000 e a documentacao da API em /docs.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import RAIZ
from app.db import criar_tabelas
from app.routers import dados, painel, proventos

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

WEB = RAIZ / "web"


@asynccontextmanager
async def ciclo_de_vida(_: FastAPI):
    criar_tabelas()
    yield


app = FastAPI(
    title="Gestao de Investimentos",
    description=(
        "Carteira de acoes, FIIs, renda fixa e ETFs com foco em proventos. "
        "Dados vem do Open Finance (Meu Pluggy), do Excel da B3 e de APIs publicas "
        "de cotacao."
    ),
    version="0.1.0",
    lifespan=ciclo_de_vida,
)

app.include_router(painel.router)
app.include_router(proventos.router)
app.include_router(dados.router)


@app.get("/saude", tags=["infra"])
def saude() -> dict:
    return {"status": "ok"}


if WEB.exists():
    app.mount("/estatico", StaticFiles(directory=WEB), name="estatico")

    @app.get("/", include_in_schema=False)
    def raiz() -> FileResponse:
        return FileResponse(WEB / "index.html")
