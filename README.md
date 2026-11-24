# normannormalmann.github.io

Persönliche Seite mit Projekten und Live-Statistik: **https://normannormalmann.github.io**

## Wie das Tracking funktioniert

Der Workflow [`collect.yml`](.github/workflows/collect.yml) läuft jeden Morgen und ruft `scripts/collect.py` auf. Das Skript fragt die GitHub-API für alle öffentlichen Repos ab und schreibt die Werte in `data/`:

| Datei | Inhalt |
|---|---|
| `traffic.csv` | Aufrufe, Besucher, Klone pro Tag und Repo (GitHub selbst hält nur 14 Tage) |
| `assets.csv` | Download-Zählerstand jedes Release-Assets pro Tag, daraus ergeben sich Downloads pro Tag |
| `repos.csv` | Tages-Snapshot: Sterne, Forks, PRs, Installationen, Update-Checks |
| `referrers.csv`, `paths.csv` | Top-Quellen und meistbesuchte Seiten (14-Tage-Fenster je Stichtag) |
| `profile.csv` | Follower und Anzahl öffentlicher Repos |

Die CSV-Dateien lassen sich direkt in Excel oder Google Sheets öffnen.

## Einrichtung

Traffic-Daten anderer Repos darf der Standard-Token eines Workflows nicht lesen. Dafür braucht es einen eigenen Token:

1. Unter **Settings → Developer settings → Fine-grained tokens** einen Token anlegen: Zugriff auf *All repositories*, Berechtigung **Administration: Read-only** (Metadata wird automatisch ergänzt).
2. Als Secret speichern: `gh secret set TRAFFIC_TOKEN -R normannormalmann/normannormalmann.github.io`
3. Workflow einmal von Hand starten: `gh workflow run collect.yml -R normannormalmann/normannormalmann.github.io`

Ohne Token sammelt der Workflow weiterhin Downloads, Sterne und PRs und meldet fehlenden Traffic als Warnung.

## Lokal ansehen

```bash
python -m http.server 8000
python -m unittest discover -s tests
```
