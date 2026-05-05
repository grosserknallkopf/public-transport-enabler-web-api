# public-transport-enabler-web-api

Eine Web API im Stil von **public-transport-enabler** mit Live-Daten (Provider-Capabilities wie `SUGGEST_LOCATIONS`, `NEARBY_LOCATIONS`, `DEPARTURES`, `TRIPS`).

Für **Deutsche Bahn (`db`)** wird `db-vendo-client` genutzt (statt des alten, abgeschalteten DB-HAFAS-Endpunkts).

## Lokaler Start

```bash
npm install
npm run start
```

API läuft dann auf `http://localhost:8080`.

Optional:

- `DEFAULT_PROVIDER=db` (oder `vbb`, `bvg`)
- `HAFAS_USER_AGENT=public-transport-enabler-web-api`

## Endpunkte

- `GET /health`
- `GET /api/v1/providers` (inkl. erweiterter Profile aus `hafas-client`)
- `GET /api/v1/locations/suggest?query=Berlin%20Hbf&provider=vbb&maxLocations=10`
- `GET /api/v1/locations/nearby?latitude=52.5256&longitude=13.3690&provider=vbb&maxDistance=1000`
- `GET /api/v1/departures?stationId=900003201&provider=vbb&maxDepartures=10`
- `POST /api/v1/trips/query?provider=vbb`
- `POST /api/v1/journeys/plan?provider=vbb` (Alias auf `trips/query`)
- `GET /planner` (moderne OSM-Weboberfläche mit:
  - sauberer Live-Suche/Vorschlagsliste für Start & Ziel,
  - kompakten Verbindungskarten (Abfahrt/Ankunft + Linien-Badges),
  - Details/Umstiege/Gleise erst nach Klick auf eine Verbindung,
  - Kartentrasse der ausgewählten Verbindung,
  - integriertem Tarifprofil (Deutschlandticket, BahnCard, Mitreisende/Alter) für Preisberechnung)
- `POST /api/v1/planner/query?provider=db` (Journey + Preise + BetterBahn-Links)

Beispiel-Body für Journey-Planung:

```json
{
  "from": "Hamburg Hbf",
  "to": "Berlin Hbf",
  "departureTime": "2026-05-03T17:00:00.000Z"
}
```

Alternative mit IDs:

```json
{
  "fromId": "8002549",
  "toId": "8011160",
  "departureTime": "2026-05-03T17:00:00.000Z",
  "provider": "vbb"
}
```

Planner-Beispiel:

```bash
curl -X POST "http://159.89.107.127:8080/api/v1/planner/query?provider=db" \
  -H "content-type: application/json" \
  -d '{"from":"Berlin Hbf","to":"Hamburg Hbf","maxResults":3}'
```

## Deployment auf DigitalOcean Droplet

Voraussetzungen:
- SSH Key für dein Droplet ist lokal vorhanden
- `doctl` ist authentifiziert

```bash
# 1) Server vorbereiten (Node.js + PM2)
ssh root@<DROPLET_IP> "apt update && apt install -y ca-certificates curl gnupg && \
mkdir -p /etc/apt/keyrings && \
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main' > /etc/apt/sources.list.d/nodesource.list && \
apt update && apt install -y nodejs && npm install -g pm2"

# 2) App deployen
rsync -av --exclude node_modules ./ root@<DROPLET_IP>:/opt/public-transport-enabler-web-api
ssh root@<DROPLET_IP> "cd /opt/public-transport-enabler-web-api && npm install --omit=dev && \
PORT=8080 pm2 start src/server.js --name public-transport-enabler-web-api && pm2 save"

# 3) API testen
curl http://<DROPLET_IP>:8080/health
```
