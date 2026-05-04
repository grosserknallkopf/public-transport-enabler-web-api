# public-transport-enabler-web-api

Eine einfache Web API für den **public-transport-enabler**.

## Lokaler Start

```bash
npm install
npm run start
```

API läuft dann auf `http://localhost:8080`.

## Endpunkte

- `GET /health`
- `GET /api/v1/stations?q=berlin`
- `POST /api/v1/journeys/plan`

Beispiel-Body für Journey-Planung:

```json
{
  "from": "Hamburg Hbf",
  "to": "Berlin Hbf",
  "departureTime": "2026-05-03T17:00:00.000Z"
}
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
