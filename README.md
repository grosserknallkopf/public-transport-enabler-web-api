# public-transport-enabler-web-api

A Web API in the style of **public-transport-enabler** with live provider data (`SUGGEST_LOCATIONS`, `NEARBY_LOCATIONS`, `DEPARTURES`, `TRIPS`).

For **Deutsche Bahn (`db`)**, this project uses `db-vendo-client` (instead of the old/deprecated DB-HAFAS endpoint).

## Local start

```bash
npm install
npm run start
```

The API runs on `http://localhost:8080`.

Optional:

- `DEFAULT_PROVIDER=db` (or `vbb`, `bvg`)
- `HAFAS_USER_AGENT=public-transport-enabler-web-api`

## Endpoints

- `GET /health`
- `GET /api/v1/providers` (including dynamically loaded profiles from `hafas-client`)
- `GET /api/v1/locations/suggest?query=Berlin%20Hbf&provider=vbb&maxLocations=10`
- `GET /api/v1/locations/nearby?latitude=52.5256&longitude=13.3690&provider=vbb&maxDistance=1000`
- `GET /api/v1/departures?stationId=900003201&provider=vbb&maxDepartures=10`
- `POST /api/v1/trips/query?provider=vbb`
- `POST /api/v1/journeys/plan?provider=vbb` (alias of `trips/query`)
- `POST /api/v1/planner/query?provider=db` (journeys + fares + BetterBahn links + `splitTicketing` metadata)

Example request body for journey planning:

```json
{
  "from": "Hamburg Hbf",
  "to": "Berlin Hbf",
  "departureTime": "2026-05-03T17:00:00.000Z"
}
```

Alternative using IDs:

```json
{
  "fromId": "8002549",
  "toId": "8011160",
  "departureTime": "2026-05-03T17:00:00.000Z",
  "provider": "vbb"
}
```

Planner API example:

```bash
curl -X POST "http://localhost:8080/api/v1/planner/query?provider=db" \
  -H "content-type: application/json" \
  -d '{"from":"Berlin Hbf","to":"Hamburg Hbf","maxResults":3}'
```

Note: The web UI has been moved to a separate repository: `public-transport-enabler-planner-ui`.

## Deployment on a DigitalOcean Droplet

Requirements:
- An SSH key for your droplet is available locally
- `doctl` is authenticated

```bash
# 1) Prepare server (Node.js + PM2)
ssh root@<DROPLET_IP> "apt update && apt install -y ca-certificates curl gnupg && \
mkdir -p /etc/apt/keyrings && \
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main' > /etc/apt/sources.list.d/nodesource.list && \
apt update && apt install -y nodejs && npm install -g pm2"

# 2) Deploy app
rsync -av --exclude node_modules ./ root@<DROPLET_IP>:/opt/public-transport-enabler-web-api
ssh root@<DROPLET_IP> "cd /opt/public-transport-enabler-web-api && npm install --omit=dev && \
PORT=8080 pm2 start src/server.js --name public-transport-enabler-web-api && pm2 save"

# 3) Test API
curl http://<DROPLET_IP>:8080/health
```
