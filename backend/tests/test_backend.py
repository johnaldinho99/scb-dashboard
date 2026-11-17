import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app.datasets import DATASETS, build_national, build_regional, load_dataset, region_level
from backend.app.jsonstat import dimension_labels, to_rows
from backend.app.main import app
from backend.app.scb_client import ScbClient, ScbError


def jsonstat(dims: dict[str, dict[str, str]], values, updated="2026-01-01T08:00:00Z") -> dict:
    """Build a minimal JSON-stat2 dataset. dims: {dim_id: {code: label}} in order."""
    return {
        "version": "2.0",
        "class": "dataset",
        "updated": updated,
        "id": list(dims),
        "size": [len(v) for v in dims.values()],
        "dimension": {
            d: {"category": {"index": {c: i for i, c in enumerate(cats)}, "label": cats}} for d, cats in dims.items()
        },
        "value": values,
    }


# ---- jsonstat ---------------------------------------------------------------


def test_to_rows_is_row_major():
    ds = jsonstat({"Region": {"00": "Riket", "01": "Stockholms län"}, "Tid": {"2023": "2023", "2024": "2024"}}, [1, 2, 3, 4])
    rows = to_rows(ds)
    assert rows == [
        {"Region": "00", "Tid": "2023", "value": 1},
        {"Region": "00", "Tid": "2024", "value": 2},
        {"Region": "01", "Tid": "2023", "value": 3},
        {"Region": "01", "Tid": "2024", "value": 4},
    ]


def test_to_rows_handles_sparse_values_and_labels():
    ds = jsonstat({"Tid": {"2023": "2023", "2024": "2024"}}, {"1": 7})
    assert [r["value"] for r in to_rows(ds)] == [None, 7]
    assert dimension_labels(ds, "Tid") == {"2023": "2023", "2024": "2024"}


def test_to_rows_rejects_wrong_length():
    ds = jsonstat({"Tid": {"2023": "2023", "2024": "2024"}}, [1])
    with pytest.raises(ValueError):
        to_rows(ds)


# ---- transformations --------------------------------------------------------


@pytest.mark.parametrize(
    "code,level",
    [("00", "riket"), ("01", "lan"), ("0114", "kommun"), ("0010", None), ("RIKS1", None)],
)
def test_region_level(code, level):
    assert region_level(code) == level


def test_build_regional_merges_tables_and_trims_empty_periods():
    regions = {"00": "Riket", "01": "Stockholms län", "0114": "Upplands Väsby", "0010": "Stor-Stockholm"}
    old = jsonstat({"Region": regions, "Tid": {"2023": "2023", "2024": "2024"}}, [10, 11, 5, 6, 1, 2, 99, 99])
    new = jsonstat({"Region": regions, "Tid": {"2025": "2025", "2026": "2026"}}, [12, None, 7, None, 3, None, 99, None])
    out = build_regional(DATASETS["befolkning"], [old, new])

    assert out["periods"] == ["2023", "2024", "2025"]  # 2026 is empty everywhere -> dropped
    assert out["series"]["00"] == [10, 11, 12]
    assert out["series"]["0114"] == [1, 2, 3]
    assert "0010" not in out["series"]  # aggregate regions are filtered out
    by_code = {r["code"]: r for r in out["regions"]}
    assert by_code["00"]["name"] == "Sverige"
    assert by_code["0114"]["parent"] == "01"
    assert by_code["01"]["parent"] == "00"


def test_build_regional_lan_level_excludes_kommuner():
    ds = jsonstat({"Region": {"00": "Riket", "01": "Stockholms län", "0114": "Upplands Väsby"}, "Tid": {"2024": "2024"}}, [1, 2, 3])
    out = build_regional(DATASETS["bostadspriser"], [ds])
    assert set(out["series"]) == {"00", "01"}


def test_build_national_uses_configured_labels_and_order():
    ds = jsonstat(
        {"ContentsCode": {"00000806": "Månadsförändring", "00000804": "Årsförändring"}, "Tid": {"2026M09": "", "2026M10": ""}},
        [0.1, 0.2, 1.0, 0.9],
    )
    out = build_national(DATASETS["kpi"], [ds])
    assert [s["key"] for s in out["seriesInfo"]] == ["00000804", "00000806"]
    assert out["seriesInfo"][0]["default"] is True
    assert out["series"]["00000804"] == [1.0, 0.9]


# ---- client + end-to-end with a mocked SCB ---------------------------------


def test_load_dataset_with_mocked_scb():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.url.path, json.loads(request.content)))
        ds = jsonstat({"Region": {"00": "Riket", "01": "Stockholms län"}, "Tid": {"2024": "2024"}}, [300.0, 350.0])
        return httpx.Response(200, json=ds)

    async def run():
        client = ScbClient(transport=httpx.MockTransport(handler))
        try:
            return await load_dataset(client, "inkomst")
        finally:
            await client.aclose()

    out = asyncio.run(run())
    assert calls[0][0].endswith("/tables/TAB3554/data")
    assert {"variableCode": "Alder", "valueCodes": ["tot20+"]} in calls[0][1]["selection"]
    assert out["series"]["01"] == [350.0]
    assert out["id"] == "inkomst" and out["fetchedAt"]


def test_client_raises_scb_error_on_http_error():
    async def run():
        client = ScbClient(transport=httpx.MockTransport(lambda r: httpx.Response(400, text="bad")), max_retries=1)
        try:
            await client.fetch_table("TAB1", {})
        finally:
            await client.aclose()

    with pytest.raises(ScbError):
        asyncio.run(run())


def test_api_lists_datasets_and_404s_unknown():
    with TestClient(app) as client:
        resp = client.get("/api/datasets")
        assert resp.status_code == 200
        assert {d["id"] for d in resp.json()} == set(DATASETS)
        assert client.get("/api/datasets/finns-inte").status_code == 404
