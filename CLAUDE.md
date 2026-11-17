# CLAUDE.md

Instruktioner för Claude Code i det här repot.

- Backend: Python + FastAPI i `backend/app`. Frontend: ren HTML/CSS/JS (ES-moduler) i `frontend/`, inget byggsteg.
- UI-texter på svenska, kod och kommentarer på engelska.
- SCB-data hämtas via PxWebApi v2 (`https://statistikdatabasen.scb.se/api/v2`). Respektera gränsen 30 anrop/10 s.
- Nya dataset läggs till deklarativt i `backend/app/datasets.py` – undvik specialfall i frontend.
- Regionkoder: `00` = riket, 2 siffror = län, 4 siffror = kommun. Aggregat som `0010` och `RIKS1` filtreras bort.
- Diagramfärger kommer från CSS-variablerna i `frontend/css/styles.css` (validerad, färgblindsäker palett). Inga hårdkodade färger i JS.
- Kör `pytest` efter backendändringar. Starta lokalt med `uvicorn backend.app.main:app --reload`.
