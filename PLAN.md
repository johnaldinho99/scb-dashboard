# PLAN – SCB-dashboard

## Mål
En lokal webbsida som hämtar statistik live från SCB och visar den i en
interaktiv dashboard med klickbar Sverigekarta.

## Beslut
| Område | Val |
|---|---|
| Arkitektur | Python-backend (FastAPI) + statisk frontend (HTML/CSS/JS) |
| Datakälla | SCB PxWebApi v2 (`statistikdatabasen.scb.se/api/v2`), JSON-stat2, ingen API-nyckel |
| Uppdatering | Live – backend frågar SCB vid varje sidladdning (ingen cache) |
| Diagram | ECharts (från CDN) |
| Karta | GeoJSON för län och kommuner (okfse/sweden-geojson), koder = SCB:s regionkoder |
| Språk | UI på svenska, kod och kommentarer på engelska |
| Tester | pytest med mockad SCB (httpx MockTransport) |

## Dataset
| Dashboard | SCB-tabell | Regional nivå | Frekvens |
|---|---|---|---|
| Befolkning | TAB5169 + TAB6481 (sammanslagna) | kommun | år |
| Medianinkomst | TAB3554 | kommun | år |
| Arbetslöshet (BAS) | TAB5663 | kommun | månad |
| Småhuspriser | TAB1166 | län | år |
| Nybyggda lägenheter | TAB4195 | kommun | år |
| Inflation (KPI) | TAB6596 | endast riket | månad |
| Hushållens konsumtion | TAB3106 | endast riket | kvartal |

## Dataflöde
```
SCB API ──JSON-stat2──▶ scb_client.py ──▶ jsonstat.py (platta rader)
        ──▶ datasets.py (filtrera regioner, slå ihop tabeller, pivotera per region/serie)
        ──▶ /api/datasets/{id} ──▶ frontend
```

## Funktioner
- Flikar för alla dataset med senaste värde för Sverige.
- Klickbar karta: län → kommuner (drilldown), vald region markeras.
- KPI-kort: värde, förändring mot föregående period och längre sikt, placering.
- Tidsserie: Sverige + valt län + vald kommun; index-läge för antal (befolkning, byggande).
- Rangordning av län/kommuner som diagram eller tabell; klick väljer region.
- Periodreglage som styr karta, kort och rangordning; klick i tidsserien väljer period.
- Ljust/mörkt tema, mobilanpassat, valet sparas i URL:en (`#inkomst/01/0162`).

## Steg
1. Utforska SCB-API:t och välj tabeller ✅
2. Backend: klient, JSON-stat-parser, datasetdefinitioner, API + tester ✅
3. Kartdata: skript som hämtar och normaliserar GeoJSON ✅
4. Frontend: layout, karta, diagram, interaktion ✅
5. Test i webbläsare (desktop, mobil, mörkt läge), push till GitHub ✅

## Möjliga nästa steg
- Kort server-cache (t.ex. 5 min) om många använder sidan samtidigt.
- Fler dataset – lägg bara till en `Dataset(...)` i `backend/app/datasets.py`.
- Spara data i en lokal DuckDB/Parquet för historik och egna analyser.
