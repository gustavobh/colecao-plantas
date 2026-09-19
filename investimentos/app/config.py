"""Configuracao lida do ambiente, com defaults que funcionam sem nenhum .env."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent


def _carrega_dotenv() -> None:
    """Le o .env da raiz sem depender de biblioteca externa."""
    arquivo = RAIZ / ".env"
    if not arquivo.exists():
        return
    for linha in arquivo.read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if not linha or linha.startswith("#") or "=" not in linha:
            continue
        chave, _, valor = linha.partition("=")
        os.environ.setdefault(chave.strip(), valor.strip())


_carrega_dotenv()


@dataclass(frozen=True)
class Config:
    database_url: str = os.getenv("INV_DATABASE_URL", "sqlite:///dados/carteira.db")
    moeda_base: str = os.getenv("INV_MOEDA_BASE", "BRL")
    pluggy_client_id: str = os.getenv("PLUGGY_CLIENT_ID", "")
    pluggy_client_secret: str = os.getenv("PLUGGY_CLIENT_SECRET", "")
    brapi_token: str = os.getenv("BRAPI_TOKEN", "")

    @property
    def pluggy_configurado(self) -> bool:
        return bool(self.pluggy_client_id and self.pluggy_client_secret)


config = Config()
