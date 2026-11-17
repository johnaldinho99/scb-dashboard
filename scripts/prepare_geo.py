"""Download and normalise the Swedish county/municipality GeoJSON used by the map.

Source: https://github.com/okfse/sweden-geojson ("Feel free to reuse").
Output properties are reduced to {"code", "name"} where code matches SCB's
region codes ("01" for counties, "0114" for municipalities). Coordinates are
rounded to keep the files small.

Run from the repo root:  python scripts/prepare_geo.py
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

BASE = "https://raw.githubusercontent.com/okfse/sweden-geojson/master"
OUT_DIR = Path(__file__).resolve().parents[1] / "frontend" / "data"
PRECISION = 4


def fetch(name: str) -> dict:
    with urllib.request.urlopen(f"{BASE}/{name}", timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def round_coords(obj):
    if isinstance(obj, list):
        if obj and isinstance(obj[0], (int, float)):
            return [round(v, PRECISION) for v in obj]
        return [round_coords(o) for o in obj]
    return obj


def normalise(geo: dict, code_of, name_of) -> dict:
    features = []
    for f in geo["features"]:
        features.append(
            {
                "type": "Feature",
                "properties": {"code": code_of(f["properties"]), "name": name_of(f["properties"])},
                "geometry": {
                    "type": f["geometry"]["type"],
                    "coordinates": round_coords(f["geometry"]["coordinates"]),
                },
            }
        )
    features.sort(key=lambda f: f["properties"]["code"])
    return {"type": "FeatureCollection", "features": features}


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    lan = normalise(
        fetch("swedish_regions.geojson"),
        code_of=lambda p: f"{int(p['l_id']):02d}",
        name_of=lambda p: p["name"],
    )
    kommuner = normalise(
        fetch("swedish_municipalities.geojson"),
        code_of=lambda p: str(p["id"]).zfill(4),
        name_of=lambda p: p["kom_namn"],
    )

    for name, data in (("lan.geojson", lan), ("kommuner.geojson", kommuner)):
        path = OUT_DIR / name
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"{path.name}: {len(data['features'])} features, {path.stat().st_size / 1024:.0f} kB")


if __name__ == "__main__":
    main()
