"""Dataset catalogue and transformation from SCB tables to dashboard payloads.

Each dashboard dataset is defined declaratively: which SCB table(s) to query,
with what selection, and how to shape the result. Two kinds exist:

* ``regional`` - one value per region and period. Region codes follow SCB:
  ``00`` = Sverige, two digits = län, four digits = kommun.
* ``national`` - only for Sverige; instead several named series (e.g. goods vs services).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

from .jsonstat import dimension_labels, to_rows
from .scb_client import ScbClient

Kind = Literal["regional", "national"]
Level = Literal["lan", "kommun"]

TABLE_URL = "https://www.statistikdatabasen.scb.se/pxweb/sv/ssd/{table}"


@dataclass(frozen=True)
class Source:
    table: str
    selection: dict[str, list[str]]


@dataclass(frozen=True)
class Dataset:
    id: str
    title: str
    short_title: str
    description: str
    unit: str
    decimals: int
    frequency: Literal["år", "kvartal", "månad"]
    kind: Kind
    sources: tuple[Source, ...]
    level: Level | None = None  # finest regional level (regional datasets only)
    region_dim: str = "Region"
    series_dim: str | None = None  # national datasets: dimension that defines the series
    series_labels: dict[str, str] = field(default_factory=dict)
    default_series: tuple[str, ...] = ()

    def meta(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "shortTitle": self.short_title,
            "description": self.description,
            "unit": self.unit,
            "decimals": self.decimals,
            "frequency": self.frequency,
            "kind": self.kind,
            "level": self.level,
            "sources": [{"table": s.table, "url": TABLE_URL.format(table=s.table)} for s in self.sources],
        }


ALL = ["*"]

DATASETS: dict[str, Dataset] = {
    d.id: d
    for d in [
        Dataset(
            id="befolkning",
            title="Folkmängd",
            short_title="Befolkning",
            description="Antal invånare den 31 december.",
            unit="invånare",
            decimals=0,
            frequency="år",
            kind="regional",
            level="kommun",
            # SCB split the series into two tables in 2025.
            sources=(
                Source("TAB5169", {"Region": ALL, "Forandringar": ["100"], "Period": ["hel"], "ContentsCode": ALL, "Tid": ALL}),
                Source("TAB6481", {"Region": ALL, "Forandringar": ["100"], "Period": ["hel"], "ContentsCode": ALL, "Tid": ALL}),
            ),
        ),
        Dataset(
            id="inkomst",
            title="Medianinkomst",
            short_title="Inkomst",
            description="Median av sammanräknad förvärvsinkomst, personer 20 år och äldre, tusen kronor.",
            unit="tkr",
            decimals=1,
            frequency="år",
            kind="regional",
            level="kommun",
            sources=(
                Source("TAB3554", {"Region": ALL, "Alder": ["tot20+"], "ContentsCode": ["HE0110J8"], "Tid": ALL}),
            ),
        ),
        Dataset(
            id="arbetsloshet",
            title="Arbetslöshet",
            short_title="Arbetslöshet",
            description="Andel arbetslösa 20–65 år enligt BAS (preliminär registerstatistik), procent.",
            unit="%",
            decimals=1,
            frequency="månad",
            kind="regional",
            level="kommun",
            sources=(
                Source("TAB5663", {"Region": ALL, "NyckeltalSCB": ["BAS03"], "ContentsCode": ["000007AN"], "Tid": ALL}),
            ),
        ),
        Dataset(
            id="bostadspriser",
            title="Småhuspriser",
            short_title="Bostadspriser",
            description="Genomsnittligt köpeskilling för sålda permanenta småhus, tusen kronor.",
            unit="tkr",
            decimals=0,
            frequency="år",
            kind="regional",
            level="lan",
            sources=(Source("TAB1166", {"Region": ALL, "ContentsCode": ["BO0501O4"], "Tid": ALL}),),
        ),
        Dataset(
            id="byggande",
            title="Nybyggda lägenheter",
            short_title="Bostadsbyggande",
            description="Antal färdigställda lägenheter i nybyggda hus (flerbostadshus och småhus).",
            unit="lägenheter",
            decimals=0,
            frequency="år",
            kind="regional",
            level="kommun",
            sources=(Source("TAB4195", {"Region": ALL, "ContentsCode": ["0000005Q"], "Tid": ALL}),),
        ),
        Dataset(
            id="kpi",
            title="Inflation (KPI)",
            short_title="Inflation",
            description="Förändring av konsumentprisindex (KPI), procent.",
            unit="%",
            decimals=1,
            frequency="månad",
            kind="national",
            series_dim="ContentsCode",
            series_labels={"00000804": "Årsförändring", "00000806": "Månadsförändring"},
            default_series=("00000804",),
            sources=(Source("TAB6596", {"ContentsCode": ["00000804", "00000806"], "Tid": ALL}),),
        ),
        Dataset(
            id="konsumtion",
            title="Hushållens konsumtion",
            short_title="Konsumtion",
            description="Hushållens konsumtionsutgifter per kvartal, fasta priser (referensår 2025), miljoner kronor.",
            unit="mnkr",
            decimals=0,
            frequency="kvartal",
            kind="national",
            series_dim="Varaktighet",
            series_labels={
                "HUST": "Totalt",
                "1100": "Varor",
                "1200": "Tjänster",
                "1131": "Livsmedel och drycker",
                "1210": "Boende (hyror)",
                "1111": "Bilar",
            },
            default_series=("1100", "1200"),
            sources=(
                Source(
                    "TAB3106",
                    {
                        "Varaktighet": ["HUST", "1100", "1200", "1131", "1210", "1111"],
                        "ContentsCode": ["NR0103B0"],
                        "Tid": ALL,
                    },
                ),
            ),
        ),
    ]
}


# ---------------------------------------------------------------------------
# Transformation
# ---------------------------------------------------------------------------


def region_level(code: str) -> str | None:
    """Classify an SCB region code. Aggregates such as '0010' (Stor-Stockholm) or 'RIKS1' return None."""
    if code == "00":
        return "riket"
    if len(code) == 2 and code.isdigit():
        return "lan"
    if len(code) == 4 and code.isdigit() and not code.startswith("00"):
        return "kommun"
    return None


def _sort_periods(periods: set[str]) -> list[str]:
    # SCB period codes (2024, 2024K1, 2024M01) sort correctly as strings.
    return sorted(periods)


def _trim_empty_periods(periods: list[str], series: dict[str, list]) -> tuple[list[str], dict[str, list]]:
    """Drop periods where every series is missing (e.g. a year that has not been published yet)."""
    keep = [i for i, _ in enumerate(periods) if any(vals[i] is not None for vals in series.values())]
    return [periods[i] for i in keep], {k: [vals[i] for i in keep] for k, vals in series.items()}


def _clean(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def build_regional(dataset: Dataset, tables: list[dict]) -> dict:
    """Merge one or more SCB tables into {regions, periods, series[regionCode]}."""
    values: dict[tuple[str, str], float | None] = {}
    names: dict[str, str] = {}
    allowed = {"riket", "lan"} | ({"kommun"} if dataset.level == "kommun" else set())

    for ds in tables:  # later tables win on overlap (newer data)
        names.update(dimension_labels(ds, dataset.region_dim))
        for row in to_rows(ds):
            code = row[dataset.region_dim]
            if region_level(code) not in allowed:
                continue
            v = _clean(row["value"])
            if v is not None or (code, row["Tid"]) not in values:
                values[(code, row["Tid"])] = v

    periods = _sort_periods({p for _, p in values})
    codes = sorted({c for c, _ in values})
    series = {c: [values.get((c, p)) for p in periods] for c in codes}
    periods, series = _trim_empty_periods(periods, series)

    regions = []
    for code in codes:
        level = region_level(code)
        regions.append(
            {
                "code": code,
                "name": "Sverige" if level == "riket" else names.get(code, code),
                "level": level,
                "parent": None if level == "riket" else ("00" if level == "lan" else code[:2]),
            }
        )
    return {"periods": periods, "regions": regions, "series": series}


def build_national(dataset: Dataset, tables: list[dict]) -> dict:
    """Build {periods, seriesInfo, series[key]} for a dataset without regional breakdown."""
    values: dict[tuple[str, str], float | None] = {}
    labels: dict[str, str] = {}
    order: list[str] = []
    for ds in tables:
        dim_labels = dimension_labels(ds, dataset.series_dim)
        labels.update(dim_labels)
        order.extend(k for k in dim_labels if k not in order)
        for row in to_rows(ds):
            values[(row[dataset.series_dim], row["Tid"])] = _clean(row["value"])

    periods = _sort_periods({p for _, p in values})
    keys = [k for k in (dataset.series_labels or order) if k in order]
    series = {k: [values.get((k, p)) for p in periods] for k in keys}
    periods, series = _trim_empty_periods(periods, series)
    info = [
        {"key": k, "label": dataset.series_labels.get(k, labels.get(k, k)), "default": k in dataset.default_series}
        for k in keys
    ]
    return {"periods": periods, "seriesInfo": info, "series": series}


async def load_dataset(client: ScbClient, dataset_id: str) -> dict:
    """Fetch a dataset live from SCB and return the dashboard payload."""
    dataset = DATASETS[dataset_id]
    tables = await asyncio.gather(*(client.fetch_table(s.table, s.selection) for s in dataset.sources))
    body = build_regional(dataset, tables) if dataset.kind == "regional" else build_national(dataset, tables)
    updated = [t.get("updated") for t in tables if t.get("updated")]
    return {
        **dataset.meta(),
        **body,
        "scbUpdated": max(updated) if updated else None,
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
