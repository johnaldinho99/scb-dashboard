"""FastAPI app: a small JSON API over SCB plus the static dashboard frontend.

Run from the repo root:
    uvicorn backend.app.main:app --reload
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.staticfiles import StaticFiles

from .datasets import DATASETS, load_dataset
from .scb_client import ScbClient, ScbError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.scb = ScbClient()
    yield
    await app.state.scb.aclose()


app = FastAPI(title="SCB Dashboard API", version="1.0.0", lifespan=lifespan)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/api/datasets")
async def list_datasets() -> list[dict]:
    """Catalogue of available datasets (metadata only, no SCB call)."""
    return [d.meta() for d in DATASETS.values()]


@app.get("/api/datasets/{dataset_id}")
async def get_dataset(dataset_id: str, response: Response) -> dict:
    """Fetch a dataset live from SCB. Not cached, so a page reload always shows the latest data."""
    if dataset_id not in DATASETS:
        raise HTTPException(status_code=404, detail=f"Okänt dataset: {dataset_id}")
    try:
        payload = await load_dataset(app.state.scb, dataset_id)
    except ScbError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    response.headers["Cache-Control"] = "no-store"
    return payload


# Mounted last so /api routes take precedence.
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
