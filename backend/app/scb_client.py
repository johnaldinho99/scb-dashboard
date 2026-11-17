"""Thin async client for SCB's PxWebApi v2 (https://statistikdatabasen.scb.se/api/v2).

SCB allows 30 calls per 10 seconds per IP, so concurrency is capped and HTTP 429
responses are retried with a back-off.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

log = logging.getLogger(__name__)

BASE_URL = "https://statistikdatabasen.scb.se/api/v2"


class ScbError(RuntimeError):
    """Raised when SCB cannot deliver a table."""


class ScbClient:
    def __init__(
        self,
        base_url: str = BASE_URL,
        lang: str = "sv",
        timeout: float = 30.0,
        max_concurrency: int = 4,
        max_retries: int = 3,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.lang = lang
        self.max_retries = max_retries
        self._semaphore = asyncio.Semaphore(max_concurrency)
        self._client = httpx.AsyncClient(
            timeout=timeout,
            transport=transport,
            headers={"User-Agent": "scb-dashboard/1.0 (local demo)"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def fetch_table(self, table_id: str, selection: dict[str, list[str]]) -> dict:
        """Fetch a table as JSON-stat2.

        ``selection`` maps variable code -> value codes. SCB selection expressions
        such as ``"*"``, ``"top(5)"`` or ``"from(2000)"`` are allowed. Variables that
        can be eliminated may be left out to get SCB's total.
        """
        url = f"{self.base_url}/tables/{table_id}/data"
        params = {"lang": self.lang, "outputFormat": "json-stat2"}
        body = {"selection": [{"variableCode": k, "valueCodes": v} for k, v in selection.items()]}

        for attempt in range(1, self.max_retries + 1):
            try:
                async with self._semaphore:
                    resp = await self._client.post(url, params=params, json=body)
            except httpx.HTTPError as exc:
                if attempt == self.max_retries:
                    raise ScbError(f"Kunde inte nå SCB ({table_id}): {exc}") from exc
                await asyncio.sleep(attempt)
                continue

            if resp.status_code == 429 and attempt < self.max_retries:
                log.warning("SCB rate limit hit for %s, retrying (attempt %s)", table_id, attempt)
                await asyncio.sleep(2 * attempt)
                continue
            if resp.status_code >= 400:
                raise ScbError(f"SCB svarade {resp.status_code} för {table_id}: {resp.text[:200]}")
            return resp.json()

        raise ScbError(f"SCB svarade inte för {table_id} efter {self.max_retries} försök")
