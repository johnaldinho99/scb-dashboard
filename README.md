# 📊 Sverige i siffror – SCB-dashboard

Interaktiv dashboard som hämtar statistik **live från SCB** och visar den med
en klickbar Sverigekarta, tidsserier och rangordningar.

- **7 dataset:** befolkning, medianinkomst, arbetslöshet, småhuspriser,
  bostadsbyggande, inflation (KPI) och hushållens konsumtion
- **Klickbar karta:** klicka på ett län för att se dess kommuner, och på en kommun för att jämföra
  med länet och riket
- **Periodreglage**, förändring mot föregående period och längre sikt,
  placering bland län/kommuner
- **Diagram eller tabell**, ljust/mörkt tema och mobilanpassning
- Datan hämtas på nytt varje gång sidan laddas om

## Kom igång

Kräver Python 3.11+.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn backend.app.main:app --reload
```

Öppna <http://localhost:8000>.

> Om PowerShell vägrar köra `Activate.ps1`: kör
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` en gång, eller anropa
> `.\.venv\Scripts\python -m uvicorn backend.app.main:app --reload` direkt.

## Arkitektur

```
Webbläsare ──▶ FastAPI (backend/app) ──▶ SCB PxWebApi v2
   ▲                │
   └── frontend/ ◀──┘ (serveras som statiska filer)
```

| Fil | Ansvar |
|---|---|
| `backend/app/scb_client.py` | Asynkron HTTP-klient mot SCB, begränsad parallellitet och retry vid HTTP 429 (SCB tillåter 30 anrop / 10 s) |
| `backend/app/jsonstat.py` | Plattar ut JSON-stat2 till rader (`{Region, Tid, value}`) |
| `backend/app/datasets.py` | Deklarativa datasetdefinitioner + transformationer (filtrera regioner, slå ihop tabeller, pivotera) |
| `backend/app/main.py` | API-endpoints och statisk servering av frontend |
| `frontend/js/app.js` | State, interaktion och rendering |
| `frontend/js/charts.js` | ECharts-konfiguration för karta, linje- och stapeldiagram |
| `scripts/prepare_geo.py` | Hämtar och normaliserar GeoJSON för län/kommuner |

### API

| Endpoint | Beskrivning |
|---|---|
| `GET /api/datasets` | Lista över dataset (metadata) |
| `GET /api/datasets/{id}` | Dataset hämtat live från SCB |
| `GET /docs` | Automatisk Swagger-dokumentation |

Exempel på svar (regionalt dataset):

```json
{
  "id": "inkomst", "title": "Medianinkomst", "unit": "tkr", "frequency": "år",
  "periods": ["1999", "...", "2024"],
  "regions": [{"code": "01", "name": "Stockholms län", "level": "lan", "parent": "00"}],
  "series": {"00": [167.9, "...", 359.2], "01": ["..."]}
}
```

### Lägga till ett dataset

1. Hitta en tabell: `https://statistikdatabasen.scb.se/api/v2/tables?query=...&lang=sv`
2. Kolla dimensionerna: `.../api/v2/tables/TAB1234/metadata`
3. Lägg till en `Dataset(...)` i `backend/app/datasets.py`. Frontend plockar upp
   den automatiskt.

## Tester

```powershell
pytest
```

Testerna mockar SCB (httpx `MockTransport`) och kräver därför ingen
internetanslutning.

## Källor

- Statistik: [SCB, Statistikdatabasen](https://www.statistikdatabasen.scb.se/) (CC0)
- Kartgränser: [okfse/sweden-geojson](https://github.com/okfse/sweden-geojson)

## Hur det byggdes

Byggt med Claude Code i VS Code som ett första test av verktyget (17 nov 2026).

| | |
|---|---|
| Tid | Cirka 25–30 minuter från svar på kontrollfrågorna till pushad kod (uppskattat från filstämplar och commit-tider) |
| Tokens / kostnad | Ej uppmätt – Claude Pro visar ingen token- eller kostnadsrapport |
| Quota (Claude Pro) | Båda projekten (Snake + SCB-dashboard) tillsammans med planeringen: ca **22 %** av 5-timmarsgränsen och ca **3 %** av veckogränsen |

Quota-siffrorna är kontots totala förbrukning vid avläsningen (`/usage`, ungefärlig och
gäller sessioner på den här datorn), så de är en övre gräns för vad bygget kostade.
