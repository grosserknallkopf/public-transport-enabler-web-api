import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { createClient as createDbVendoClient } from "db-vendo-client";
import { profile as dbVendoDbProfile } from "db-vendo-client/p/db/index.js";
import { data as loyaltyCardData } from "db-vendo-client/format/loyalty-cards.js";
import { createVbbHafas } from "vbb-hafas";
import { createBvgHafas } from "bvg-hafas";
import { createClient as createHafasClient } from "hafas-client";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8080);
const userAgent = process.env.HAFAS_USER_AGENT || "public-transport-enabler-web-api";
const defaultProvider = String(process.env.DEFAULT_PROVIDER || "db").toLowerCase();
const germanyProviderKeys = new Set([
  "avv",
  "bvg",
  "db",
  "hvv",
  "insa",
  "invg",
  "ivb",
  "kvb",
  "nvv",
  "rmv",
  "rsag",
  "sbahnmuenchen",
  "vbb",
  "vbn",
  "vkg",
  "vmt",
  "vrn",
  "vsn",
]);

app.use(cors());
app.use(express.json());

const nowIso = () => new Date().toISOString();
const providers = {
  db: {
    key: "db",
    name: "Deutsche Bahn",
    capabilities: ["SUGGEST_LOCATIONS", "NEARBY_LOCATIONS", "DEPARTURES", "TRIPS"],
    client: createDbVendoClient(dbVendoDbProfile, userAgent),
  },
  bvg: {
    key: "bvg",
    name: "Berliner Verkehrsbetriebe",
    capabilities: ["SUGGEST_LOCATIONS", "NEARBY_LOCATIONS", "DEPARTURES", "TRIPS"],
    client: createBvgHafas(userAgent),
  },
  vbb: {
    key: "vbb",
    name: "Verkehrsverbund Berlin-Brandenburg",
    capabilities: ["SUGGEST_LOCATIONS", "NEARBY_LOCATIONS", "DEPARTURES", "TRIPS"],
    client: createVbbHafas(userAgent),
  },
};

const prettifyProviderName = (key) => {
  const map = {
    avv: "AVV",
    bvg: "BVG",
    db: "Deutsche Bahn",
    insa: "INSA",
    invg: "INVG",
    ivb: "IVB",
    kvb: "KVB",
    nvv: "NVV",
    oebb: "OEBB",
    rmv: "RMV",
    rsag: "RSAG",
    sbahnmuenchen: "S-Bahn Muenchen",
    sncb: "SNCB",
    stv: "STV",
    svv: "SVV",
    vbb: "VBB",
    vbn: "VBN",
    vkg: "VKG",
    vmt: "VMT",
    vor: "VOR",
    vos: "VOS",
    vrn: "VRN",
    vsn: "VSN",
    vvt: "VVT",
    vvv: "VVV",
    zvv: "ZVV",
  };
  return map[key] || key.toUpperCase();
};

const loadAdditionalHafasProviders = async () => {
  const hafasPackagePath = path.join(process.cwd(), "node_modules", "hafas-client", "p");
  if (!fs.existsSync(hafasPackagePath)) return;
  const candidates = fs
    .readdirSync(hafasPackagePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !["db", "bvg", "vbb"].includes(name));

  for (const candidate of candidates) {
    try {
      const mod = await import(`hafas-client/p/${candidate}/index.js`);
      if (!mod?.profile || providers[candidate]) continue;
      providers[candidate] = {
        key: candidate,
        name: prettifyProviderName(candidate),
        capabilities: ["SUGGEST_LOCATIONS", "NEARBY_LOCATIONS", "DEPARTURES", "TRIPS"],
        client: createHafasClient(mod.profile, userAgent),
      };
    } catch (_error) {}
  }
};

await loadAdditionalHafasProviders();

const parseProvider = (input) => {
  const providerKey = String(input || defaultProvider).toLowerCase();
  return providers[providerKey];
};
const isGermanProviderKey = (key) => germanyProviderKeys.has(String(key || "").toLowerCase());

const toLocationSummary = (location) => ({
  type: location.type || "location",
  id: location.id,
  name: location.name,
  latitude: location.location?.latitude ?? null,
  longitude: location.location?.longitude ?? null,
});

const resolveStop = async (hafas, value, idValue) => {
  if (idValue) return idValue;

  const query = String(value || "").trim();
  if (!query) return null;

  const matches = await hafas.locations(query, {
    results: 1,
    stops: true,
    stations: true,
    addresses: false,
    poi: false,
  });
  const first = matches.find((item) => item.type === "stop" || item.type === "station");
  return first?.id || null;
};

const parseDeparture = (value) => {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parsePositiveInt = (value, fallback, max) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

const toBoolean = (value) => {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").toLowerCase();
  return ["true", "1", "yes", "on"].includes(normalized);
};

const parseAges = (value) =>
  String(value || "")
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((age) => Number.isInteger(age) && age > 0 && age < 120);

const normalizeFareProfile = (rawProfile) => {
  const profile = rawProfile || {};
  const travellerCount = parsePositiveInt(profile.travellerCount || profile.travelers || 1, 1, 8);
  const ages = parseAges(profile.travellerAges || profile.ages).slice(0, travellerCount);
  while (ages.length < travellerCount) ages.push(30);

  let loyaltyCard = null;
  const bahnCard = String(profile.bahnCard || "none").toLowerCase();
  if (bahnCard === "25") loyaltyCard = { type: loyaltyCardData.BAHNCARD, discount: 25, class: 2 };
  if (bahnCard === "50") loyaltyCard = { type: loyaltyCardData.BAHNCARD, discount: 50, class: 2 };
  if (bahnCard === "100") loyaltyCard = { type: loyaltyCardData.BAHNCARD, discount: 100, class: 2 };

  const loyaltyCards = Array.from({ length: travellerCount }, (_entry, index) => {
    const age = ages[index];
    if (!loyaltyCard || age < 15) return null;
    return loyaltyCard;
  });

  return {
    deutschlandTicket: toBoolean(profile.deutschlandTicket),
    deutschlandTicketOnly: toBoolean(profile.deutschlandTicketOnly),
    bahnCard,
    travellerCount,
    ages,
    loyaltyCards,
  };
};

const extractJourneyPrice = (journey) => {
  if (journey?.price?.amount != null) return journey.price;
  const ticketWithPrice = (journey?.tickets || []).find((ticket) => ticket?.price?.amount != null);
  return ticketWithPrice?.price || null;
};

const toMarker = (role, stop) => ({
  role,
  id: stop?.id || null,
  name: stop?.name || null,
  latitude: stop?.location?.latitude ?? null,
  longitude: stop?.location?.longitude ?? null,
});

const toCoordinate = (place) => {
  const latitude = place?.location?.latitude ?? place?.latitude;
  const longitude = place?.location?.longitude ?? place?.longitude;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return [latitude, longitude];
};

const minutesBetween = (from, to) => {
  if (!from || !to) return null;
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const diffMs = toDate.getTime() - fromDate.getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return null;
  return Math.round(diffMs / 60000);
};

const summarizeJourney = (journey, index) => {
  const firstLeg = journey?.legs?.[0];
  const lastLeg = journey?.legs?.[journey.legs.length - 1];
  const price = extractJourneyPrice(journey);
  const legs = (journey?.legs || []).map((leg, legIndex, allLegs) => {
    const nextLeg = allLegs[legIndex + 1];
    return {
      index: legIndex + 1,
      from: toMarker("from", leg?.origin),
      to: toMarker("to", leg?.destination),
      departure: leg?.departure || leg?.plannedDeparture || null,
      arrival: leg?.arrival || leg?.plannedArrival || null,
      departurePlatform: leg?.departurePlatform || leg?.plannedDeparturePlatform || null,
      arrivalPlatform: leg?.arrivalPlatform || leg?.plannedArrivalPlatform || null,
      line: leg?.line?.name || null,
      mode: leg?.walking ? "walking" : leg?.line?.mode || null,
      direction: leg?.direction || null,
      operator: leg?.line?.operator?.name || null,
      stopCount: leg?.stopovers?.length || 0,
      transferMinutesToNext: nextLeg ? minutesBetween(leg?.arrival, nextLeg?.departure) : null,
    };
  });
  const routeCoordinates = [];
  for (const leg of journey?.legs || []) {
    const points = [
      leg?.origin,
      ...(leg?.stopovers || []).map((stopover) => stopover?.stop || stopover),
      leg?.destination,
    ];
    for (const point of points) {
      const coordinate = toCoordinate(point);
      if (!coordinate) continue;
      const previous = routeCoordinates[routeCoordinates.length - 1];
      if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
        routeCoordinates.push(coordinate);
      }
    }
  }

  return {
    id: journey?.refreshToken || `journey-${index + 1}`,
    departure: journey?.departure || firstLeg?.departure || null,
    arrival: journey?.arrival || lastLeg?.arrival || null,
    duration: journey?.duration || null,
    transfers: Math.max((journey?.legs?.length || 1) - 1, 0),
    from: toMarker("from", firstLeg?.origin),
    to: toMarker("to", lastLeg?.destination),
    lineNames: (journey?.legs || [])
      .map((leg) => leg?.line?.name)
      .filter(Boolean)
      .slice(0, 6),
    legs,
    routeCoordinates,
    price: price
      ? {
          amount: price.amount ?? null,
          currency: price.currency || "EUR",
          hint: price.hint || null,
        }
      : null,
  };
};

const mapJourneyBySignature = (journey) => {
  const firstLeg = journey?.legs?.[0];
  const lastLeg = journey?.legs?.[journey.legs.length - 1];
  return `${firstLeg?.origin?.id || firstLeg?.origin?.name || ""}|${lastLeg?.destination?.id || lastLeg?.destination?.name || ""}|${journey?.departure || firstLeg?.departure || ""}|${journey?.arrival || lastLeg?.arrival || ""}|${(journey?.legs || []).length}`;
};

const capJourneys = (journeys, limit = 4) => journeys.slice(0, limit);

const getPlannerHtml = () => `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Public Transport Enabler Planner</title>
  <link
    rel="stylesheet"
    href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
    crossorigin=""
  />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: #0b1020;
      color: #e5e7eb;
    }
    .app {
      display: grid;
      grid-template-columns: 380px 1fr;
      min-height: 100vh;
    }
    .panel {
      padding: 18px;
      border-right: 1px solid #1f2937;
      background: #111827;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 20px;
    }
    .sub {
      margin: 0 0 14px;
      color: #9ca3af;
      font-size: 13px;
    }
    form { display: grid; gap: 10px; margin-bottom: 14px; }
    input, select, button {
      width: 100%;
      border: 1px solid #374151;
      background: #111827;
      color: #f9fafb;
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 14px;
    }
    .input-wrap { position: relative; }
    .suggestions {
      position: absolute;
      left: 0;
      right: 0;
      top: calc(100% + 4px);
      z-index: 1000;
      max-height: 220px;
      overflow: auto;
      background: #0b1220;
      border: 1px solid #1f2937;
      border-radius: 10px;
      display: none;
    }
    .suggestions.show { display: block; }
    .suggestion-item {
      width: 100%;
      text-align: left;
      border: 0;
      border-bottom: 1px solid #1f2937;
      background: transparent;
      color: #f9fafb;
      padding: 9px 10px;
      cursor: pointer;
      font-size: 13px;
    }
    .suggestion-item:last-child { border-bottom: 0; }
    .suggestion-item:hover, .suggestion-item.active { background: #1e293b; }
    .suggestion-sub { color: #94a3b8; font-size: 11px; display: block; margin-top: 2px; }
    button {
      cursor: pointer;
      border-color: #2563eb;
      background: #2563eb;
      font-weight: 600;
    }
    button:disabled { opacity: 0.6; cursor: wait; }
    .actions { display: grid; gap: 8px; }
    .betterbahn {
      display: inline-block;
      text-decoration: none;
      color: #93c5fd;
      font-size: 13px;
    }
    .results {
      max-height: calc(100vh - 260px);
      overflow: auto;
      display: grid;
      gap: 10px;
      padding-right: 4px;
    }
    .card {
      border: 1px solid #1f2937;
      border-radius: 12px;
      padding: 10px;
      background: #0f172a;
    }
    .price { color: #86efac; font-weight: 700; }
    .discount { color: #facc15; font-weight: 700; font-size: 12px; margin-top: 4px; }
    .meta { color: #9ca3af; font-size: 12px; margin-top: 4px; }
    .line-badges {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .line-badge {
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.2px;
    }
    .line-badge.train { background: #1d4ed8; color: #eff6ff; }
    .line-badge.bus { background: #0f766e; color: #ecfeff; }
    .line-badge.tram { background: #a16207; color: #fffbeb; }
    .line-badge.subway { background: #7c3aed; color: #f5f3ff; }
    .line-badge.ferry { background: #0e7490; color: #ecfeff; }
    .line-badge.walking { background: #334155; color: #e2e8f0; }
    .line-badge.other { background: #374151; color: #f3f4f6; }
    .legs {
      margin-top: 10px;
      border-top: 1px solid #1f2937;
      padding-top: 8px;
      display: grid;
      gap: 8px;
    }
    .leg {
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 10px;
      padding: 8px;
    }
    .leg-title { font-weight: 600; }
    .card.active {
      border-color: #2563eb;
      box-shadow: 0 0 0 1px #2563eb inset;
    }
    .details-toggle {
      border: 1px solid #374151;
      background: #0f172a;
      color: #cbd5e1;
      border-radius: 8px;
      padding: 6px 9px;
      font-size: 12px;
      margin-top: 8px;
      cursor: pointer;
    }
    .route-details { display: none; }
    .card.active .route-details { display: grid; }
    #map { min-height: 100vh; }
    .leaflet-popup-content-wrapper { background: #111827; color: #f9fafb; }
    .leaflet-popup-tip { background: #111827; }
    @media (max-width: 960px) {
      .app { grid-template-columns: 1fr; }
      #map { min-height: 45vh; }
      .results { max-height: none; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="panel">
      <h1>Moderner Routenplaner</h1>
      <p class="sub">OpenStreetMap + Live-Provider + Preise + BetterBahn-Integration</p>
      <form id="planner-form">
        <div class="meta">Tarifprofil</div>
        <div class="line-badges" style="margin-top:0">
          <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:#cbd5e1"><input id="deutschlandTicket" type="checkbox" style="width:auto;padding:0;margin:0" />Deutschlandticket</label>
          <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:#cbd5e1"><input id="deutschlandTicketOnly" type="checkbox" style="width:auto;padding:0;margin:0" />Nur D-Ticket-Verbindungen</label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <select id="bahnCard">
            <option value="none">Keine BahnCard</option>
            <option value="25">BahnCard 25</option>
            <option value="50">BahnCard 50</option>
            <option value="100">BahnCard 100</option>
          </select>
          <input id="travellerCount" type="number" min="1" max="8" value="1" placeholder="Mitreisende" />
        </div>
        <input id="travellerAges" placeholder="Alter (CSV), z.B. 34,32,12" />
        <hr style="border:0;border-top:1px solid #1f2937;width:100%;margin:2px 0 4px" />
        <div class="meta">Route</div>
        <div class="input-wrap">
          <input id="from" name="from" placeholder="Start (z. B. Berlin Hbf)" autocomplete="off" required />
          <div id="from-suggestions" class="suggestions"></div>
        </div>
        <div class="input-wrap">
          <input id="to" name="to" placeholder="Ziel (z. B. Hamburg Hbf)" autocomplete="off" required />
          <div id="to-suggestions" class="suggestions"></div>
        </div>
        <select id="provider" name="provider"></select>
        <input id="departureTime" name="departureTime" type="datetime-local" />
        <button id="submit" type="submit">Route berechnen</button>
      </form>
      <div class="actions">
        <a id="betterbahn-route-link" class="betterbahn" href="https://betterbahn.de" target="_blank" rel="noreferrer noopener">
          In BetterBahn oeffnen (Split-Ticketing)
        </a>
        <a class="betterbahn" href="https://github.com/BetterBahn/betterbahn" target="_blank" rel="noreferrer noopener">
          BetterBahn Open Source Projekt
        </a>
      </div>
      <div id="status" class="sub"></div>
      <div id="results" class="results"></div>
    </aside>
    <main id="map"></main>
  </div>
  <script
    src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
    crossorigin=""
  ></script>
  <script>
    const map = L.map("map", { zoomControl: true }).setView([52.52, 13.405], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap-Mitwirkende",
    }).addTo(map);
    const markerLayer = L.layerGroup().addTo(map);
    const routeLayer = L.layerGroup().addTo(map);
    const form = document.getElementById("planner-form");
    const statusEl = document.getElementById("status");
    const resultsEl = document.getElementById("results");
    const submitEl = document.getElementById("submit");
    const providerEl = document.getElementById("provider");
    const betterbahnRouteLinkEl = document.getElementById("betterbahn-route-link");
    const fromInputEl = document.getElementById("from");
    const toInputEl = document.getElementById("to");
    const deutschlandTicketEl = document.getElementById("deutschlandTicket");
    const deutschlandTicketOnlyEl = document.getElementById("deutschlandTicketOnly");
    const bahnCardEl = document.getElementById("bahnCard");
    const travellerCountEl = document.getElementById("travellerCount");
    const travellerAgesEl = document.getElementById("travellerAges");
    const fromSuggestionsEl = document.getElementById("from-suggestions");
    const toSuggestionsEl = document.getElementById("to-suggestions");
    const toIso = (value) => value ? new Date(value).toISOString() : undefined;
    const selectedStationIds = { from: null, to: null };
    const stationMaps = { from: new Map(), to: new Map() };
    const suggestionState = {
      from: { items: [], activeIndex: -1, shown: false },
      to: { items: [], activeIndex: -1, shown: false },
    };
    let currentJourneys = [];
    let activeJourneyId = null;
    const euro = (price) => {
      if (!price || price.amount == null) return "Kein Preis verfuegbar";
      const value = Number(price.amount);
      if (Number.isFinite(value)) return value.toLocaleString("de-DE", { style: "currency", currency: price.currency || "EUR" });
      return "Preis unbekannt";
    };
    const escapeHtml = (value) => String(value || "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
    const modeClass = (mode) => {
      if (!mode) return "other";
      if (mode === "walking") return "walking";
      if (mode === "bus") return "bus";
      if (mode === "tram") return "tram";
      if (mode === "subway") return "subway";
      if (mode === "ferry") return "ferry";
      if (mode === "train") return "train";
      return "other";
    };
    const drawJourney = (journey) => {
      markerLayer.clearLayers();
      routeLayer.clearLayers();
      if (!journey) return;
      const bounds = [];
      const coords = journey.routeCoordinates || [];
      if (coords.length >= 2) {
        const line = L.polyline(coords, { color: "#3b82f6", weight: 5, opacity: 0.9 }).addTo(routeLayer);
        bounds.push(...coords);
        line.bindPopup("Route: " + (journey.from?.name || "?") + " -> " + (journey.to?.name || "?"));
      }
      const markers = [journey.from, journey.to];
      for (const marker of markers) {
        if (!marker || marker.latitude == null || marker.longitude == null) continue;
        L.marker([marker.latitude, marker.longitude]).addTo(markerLayer).bindPopup((marker.role === "from" ? "Start: " : "Ziel: ") + (marker.name || marker.id || "?"));
        bounds.push([marker.latitude, marker.longitude]);
      }
      if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] });
    };
    const renderJourneys = (payload) => {
      const journeys = payload.journeys || [];
      currentJourneys = journeys;
      activeJourneyId = null;
      betterbahnRouteLinkEl.href = payload.betterbahn?.routeUrl || "https://betterbahn.de";
      resultsEl.innerHTML = "";
      if (payload.faresProfile) {
        const fp = payload.faresProfile;
        const badge = [];
        if (fp.deutschlandTicket) badge.push("D-Ticket");
        if (fp.bahnCard && fp.bahnCard !== "none") badge.push("BahnCard " + fp.bahnCard);
        badge.push(fp.travellerCount + " Reisende");
        if (fp.ages?.length) badge.push("Alter: " + fp.ages.join(", "));
        statusEl.textContent = "Tarifprofil: " + badge.join(" | ");
      }
      if (!journeys.length) {
        if (!payload.faresProfile) statusEl.textContent = "Keine Verbindungen gefunden.";
        drawJourney(null);
        return;
      }
      statusEl.textContent = (statusEl.textContent ? statusEl.textContent + " | " : "") + journeys.length + " Verbindung(en) gefunden.";
      for (const journey of journeys) {
        const card = document.createElement("article");
        card.className = "card";
        card.dataset.journeyId = journey.id;
        let legsHtml = "";
        for (const leg of journey.legs || []) {
          const transferText = leg.transferMinutesToNext != null ? "<div class='meta'>Umstieg: " + leg.transferMinutesToNext + " min</div>" : "";
          legsHtml += "<div class='leg'>"
            + "<div class='leg-title'>" + escapeHtml(leg.line || (leg.mode === "walking" ? "Fussweg" : "Verbindung")) + "</div>"
            + "<div class='meta'>" + escapeHtml(leg.from?.name) + " (" + escapeHtml(leg.departure || "n/a") + (leg.departurePlatform ? ", Gleis " + escapeHtml(leg.departurePlatform) : "") + ")</div>"
            + "<div class='meta'>" + escapeHtml(leg.to?.name) + " (" + escapeHtml(leg.arrival || "n/a") + (leg.arrivalPlatform ? ", Gleis " + escapeHtml(leg.arrivalPlatform) : "") + ")</div>"
            + "<div class='meta'>Richtung: " + escapeHtml(leg.direction || "n/a") + "</div>"
            + transferText
            + "</div>";
        }
        const lineBadges = (journey.legs || [])
          .map((leg) => '<span class="line-badge ' + modeClass(leg.mode) + '">' + escapeHtml(leg.line || (leg.mode === "walking" ? "Fussweg" : (leg.mode || "Verbindung"))) + "</span>")
          .join("");
        const discountHtml = journey.priceComparison?.hasDiscount
          ? '<div class="discount">Verguenstigt: ' + euro(journey.priceComparison.discounted) + ' statt ' + euro(journey.priceComparison.base) + ' (Ersparnis ' + euro({amount: journey.priceComparison.savings, currency: journey.priceComparison.base.currency}) + ')</div>'
          : (journey.priceComparison?.discounted && !journey.priceComparison?.base
              ? '<div class="discount">Rabattprofil aktiv - Preis nach Profil: ' + euro(journey.priceComparison.discounted) + '</div>'
              : '');
        card.innerHTML = '<div><strong>' + escapeHtml(journey.from?.name || payload.fromId || "?") + "</strong> -> <strong>" + escapeHtml(journey.to?.name || payload.toId || "?") + '</strong></div>'
          + '<div class="price">' + euro(journey.priceComparison?.discounted || journey.price) + "</div>"
          + discountHtml
          + '<div class="meta">Abfahrt: ' + (journey.departure || "n/a") + "</div>"
          + '<div class="meta">Ankunft: ' + (journey.arrival || "n/a") + "</div>"
          + '<div class="line-badges">' + lineBadges + "</div>"
          + '<div class="route-details legs">' + legsHtml + "</div>";
        card.addEventListener("click", () => {
          activeJourneyId = journey.id;
          for (const cardEl of resultsEl.querySelectorAll(".card")) {
            cardEl.classList.toggle("active", cardEl.dataset.journeyId === activeJourneyId);
          }
          drawJourney(journey);
        });
        resultsEl.appendChild(card);
      }
      drawJourney(null);
    };
    let suggestTimer = null;
    const renderSuggestions = (field) => {
      const state = suggestionState[field];
      const containerEl = field === "from" ? fromSuggestionsEl : toSuggestionsEl;
      containerEl.innerHTML = "";
      if (!state.items.length || !state.shown) {
        containerEl.classList.remove("show");
        return;
      }
      state.items.forEach((item, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "suggestion-item" + (index === state.activeIndex ? " active" : "");
        button.innerHTML = "<span>" + escapeHtml(item.name) + "</span><span class='suggestion-sub'>" + escapeHtml(item.id || "") + "</span>";
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
          const inputEl = field === "from" ? fromInputEl : toInputEl;
          inputEl.value = item.name;
          selectedStationIds[field] = item.id || null;
          stationMaps[field].set(item.name, item.id || null);
          state.shown = false;
          renderSuggestions(field);
        });
        containerEl.appendChild(button);
      });
      containerEl.classList.add("show");
    };
    const hideSuggestions = (field) => {
      suggestionState[field].shown = false;
      suggestionState[field].activeIndex = -1;
      renderSuggestions(field);
    };
    const showSuggestions = (field) => {
      if (!suggestionState[field].items.length) return;
      suggestionState[field].shown = true;
      renderSuggestions(field);
    };
    const suggestStations = (field) => {
      const inputEl = field === "from" ? fromInputEl : toInputEl;
      const state = suggestionState[field];
      const value = inputEl.value.trim();
      if (value.length < 2) {
        state.items = [];
        state.shown = false;
        state.activeIndex = -1;
        stationMaps[field].clear();
        selectedStationIds[field] = null;
        renderSuggestions(field);
        return;
      }
      clearTimeout(suggestTimer);
      suggestTimer = setTimeout(async () => {
        try {
          const provider = providerEl.value;
          const response = await fetch("/api/v1/locations/suggest?provider=" + encodeURIComponent(provider) + "&query=" + encodeURIComponent(value) + "&maxLocations=8");
          if (!response.ok) return;
          const data = await response.json();
          stationMaps[field].clear();
          state.items = (data.items || []).map((item) => ({ name: item.name, id: item.id }));
          state.activeIndex = -1;
          state.shown = true;
          for (const item of state.items) {
            if (!stationMaps[field].has(item.name)) stationMaps[field].set(item.name, item.id);
          }
          selectedStationIds[field] = stationMaps[field].get(inputEl.value.trim()) || null;
          renderSuggestions(field);
        } catch (_error) {}
      }, 220);
    };
    const handleSuggestionKeys = (field, event) => {
      const state = suggestionState[field];
      if (!state.shown || !state.items.length) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.activeIndex = Math.min(state.activeIndex + 1, state.items.length - 1);
        renderSuggestions(field);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        state.activeIndex = Math.max(state.activeIndex - 1, 0);
        renderSuggestions(field);
      } else if (event.key === "Enter" && state.activeIndex >= 0) {
        event.preventDefault();
        const selected = state.items[state.activeIndex];
        const inputEl = field === "from" ? fromInputEl : toInputEl;
        inputEl.value = selected.name;
        selectedStationIds[field] = selected.id || null;
        state.shown = false;
        renderSuggestions(field);
      } else if (event.key === "Escape") {
        hideSuggestions(field);
      }
    };
    fromInputEl.addEventListener("input", () => suggestStations("from"));
    toInputEl.addEventListener("input", () => suggestStations("to"));
    fromInputEl.addEventListener("focus", () => showSuggestions("from"));
    toInputEl.addEventListener("focus", () => showSuggestions("to"));
    fromInputEl.addEventListener("keydown", (event) => handleSuggestionKeys("from", event));
    toInputEl.addEventListener("keydown", (event) => handleSuggestionKeys("to", event));
    fromInputEl.addEventListener("change", () => { selectedStationIds.from = stationMaps.from.get(fromInputEl.value.trim()) || null; });
    toInputEl.addEventListener("change", () => { selectedStationIds.to = stationMaps.to.get(toInputEl.value.trim()) || null; });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".input-wrap")) {
        hideSuggestions("from");
        hideSuggestions("to");
      }
    });
    providerEl.addEventListener("change", () => {
      selectedStationIds.from = null;
      selectedStationIds.to = null;
      stationMaps.from.clear();
      stationMaps.to.clear();
      suggestionState.from = { items: [], activeIndex: -1, shown: false };
      suggestionState.to = { items: [], activeIndex: -1, shown: false };
      renderSuggestions("from");
      renderSuggestions("to");
    });
    const loadProviders = async () => {
      try {
        const response = await fetch("/api/v1/providers");
        if (!response.ok) return;
        const data = await response.json();
        const defaultProvider = data.defaultProvider || "db";
        providerEl.innerHTML = "";
        for (const item of data.items || []) {
          const option = document.createElement("option");
          option.value = item.key;
          option.textContent = item.name + " (" + item.key + ")";
          if (item.key === defaultProvider) option.selected = true;
          providerEl.appendChild(option);
        }
      } catch (_error) {}
    };
    loadProviders();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submitEl.disabled = true;
      statusEl.textContent = "Suche...";
      resultsEl.innerHTML = "";
      try {
        const body = {
          provider: providerEl.value,
          faresProfile: {
            deutschlandTicket: deutschlandTicketEl.checked,
            deutschlandTicketOnly: deutschlandTicketOnlyEl.checked,
            bahnCard: bahnCardEl.value,
            travellerCount: Number(travellerCountEl.value || 1),
            travellerAges: travellerAgesEl.value.trim(),
          },
        };
        const fromValue = fromInputEl.value.trim();
        const toValue = toInputEl.value.trim();
        const fromId = selectedStationIds.from || stationMaps.from.get(fromValue) || null;
        const toId = selectedStationIds.to || stationMaps.to.get(toValue) || null;
        if (fromId) body.fromId = fromId; else body.from = fromValue;
        if (toId) body.toId = toId; else body.to = toValue;
        const departureIso = toIso(document.getElementById("departureTime").value);
        if (departureIso) body.departureTime = departureIso;
        const response = await fetch("/api/v1/planner/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || "Planner request failed");
        renderJourneys(data);
      } catch (error) {
        statusEl.textContent = "Fehler: " + error.message;
        drawJourney(null);
      } finally {
        submitEl.disabled = false;
      }
    });
  </script>
</body>
</html>`;

const isRetriableProviderParseError = (error) => {
  const message = error?.message || "";
  return message.includes("Unexpected end of JSON input");
};

const callProviderWithRetry = async (fn, retries = 2) => {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetriableProviderParseError(error) || attempt === retries) throw error;
      attempt += 1;
    }
  }
};

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "public-transport-enabler-web-api",
    timestamp: nowIso(),
  });
});

app.get("/api/v1/providers", (_req, res) => {
  res.json({
    defaultProvider,
    items: Object.values(providers).map(({ key, name, capabilities }) => ({
      key,
      name,
      capabilities,
      country: isGermanProviderKey(key) ? "DE" : "OTHER",
      supportsDeutschlandticket: key === "db",
    })),
  });
});

app.get("/planner", (_req, res) => {
  res.status(404).json({
    error: "Planner UI moved",
    details: "Use the dedicated planner repository/deployment.",
  });
});

app.get("/api/v1/locations/suggest", async (req, res) => {
  const provider = parseProvider(req.query.provider);
  if (!provider) {
    return res.status(400).json({
      error: "unsupported provider",
      supportedProviders: Object.keys(providers),
    });
  }

  const query = String(req.query.query || req.query.q || "").trim();
  if (!query) {
    return res.status(400).json({
      error: "query is required",
    });
  }

  const safeResults = parsePositiveInt(req.query.maxLocations || req.query.results, 10, 50);

  try {
    const locations = await callProviderWithRetry(() =>
      provider.client.locations(query, {
        results: safeResults,
        stops: true,
        stations: true,
        addresses: true,
        poi: true,
      }),
    );

    res.json({
      provider: provider.key,
      count: locations.length,
      items: locations.map(toLocationSummary),
    });
  } catch (error) {
    res.status(502).json({
      error: "provider request failed",
      provider: provider.key,
      details: error?.message || String(error),
    });
  }
});

app.get("/api/v1/locations/nearby", async (req, res) => {
  const provider = parseProvider(req.query.provider);
  if (!provider) {
    return res.status(400).json({
      error: "unsupported provider",
      supportedProviders: Object.keys(providers),
    });
  }

  const latitude = Number(req.query.latitude);
  const longitude = Number(req.query.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({
      error: "latitude and longitude are required",
    });
  }

  const distance = parsePositiveInt(req.query.maxDistance || req.query.distance, 1000, 20000);
  const results = parsePositiveInt(req.query.maxLocations || req.query.results, 10, 50);

  try {
    const locations = await callProviderWithRetry(() =>
      provider.client.nearby(
        { type: "location", latitude, longitude },
        {
          distance,
          results,
          stops: true,
          stations: true,
          addresses: false,
          poi: true,
        },
      ),
    );

    res.json({
      provider: provider.key,
      count: locations.length,
      items: locations.map(toLocationSummary),
    });
  } catch (error) {
    res.status(502).json({
      error: "provider request failed",
      provider: provider.key,
      details: error?.message || String(error),
    });
  }
});

app.get("/api/v1/departures", async (req, res) => {
  const provider = parseProvider(req.query.provider);
  if (!provider) {
    return res.status(400).json({
      error: "unsupported provider",
      supportedProviders: Object.keys(providers),
    });
  }

  const stationId = String(req.query.stationId || "").trim();
  if (!stationId) {
    return res.status(400).json({
      error: "stationId is required",
    });
  }

  const when = parseDeparture(req.query.when);
  if (!when) {
    return res.status(400).json({
      error: "when must be a valid ISO timestamp",
    });
  }

  const results = parsePositiveInt(req.query.maxDepartures || req.query.results, 10, 50);

  try {
    const departuresResponse = await callProviderWithRetry(() =>
      provider.client.departures(stationId, when, {
        results,
        duration: 120,
        remarks: true,
      }),
    );
    const departures = Array.isArray(departuresResponse)
      ? departuresResponse
      : departuresResponse?.departures || [];

    res.json({
      provider: provider.key,
      stationId,
      count: departures.length,
      realtimeDataUpdatedAt: departuresResponse?.realtimeDataUpdatedAt || null,
      items: departures,
    });
  } catch (error) {
    res.status(502).json({
      error: "provider request failed",
      provider: provider.key,
      details: error?.message || String(error),
    });
  }
});

const queryTripsHandler = async (req, res) => {
  const { from, to, via, fromId, toId, viaId, departureTime, arrivalTime, provider: providerFromBody } = req.body || {};
  const provider = parseProvider(providerFromBody || req.query.provider);

  if (!provider) {
    return res.status(400).json({
      error: "unsupported provider",
      supportedProviders: Object.keys(providers),
    });
  }

  if ((!from && !fromId) || (!to && !toId)) {
    return res.status(400).json({
      error: "from/to (or fromId/toId) are required",
    });
  }

    const departure = departureTime ? parseDeparture(departureTime) : new Date(Date.now() + 2 * 60 * 60 * 1000);
    const arrival = arrivalTime ? parseDeparture(arrivalTime) : null;
    if ((departureTime && !departure) || (arrivalTime && !arrival)) {
      return res.status(400).json({
        error: "departureTime/arrivalTime must be valid ISO timestamps",
      });
  }

  try {
    const resolvedFromId = await resolveStop(provider.client, from, fromId);
    const resolvedViaId = await resolveStop(provider.client, via, viaId);
    const resolvedToId = await resolveStop(provider.client, to, toId);
    if (!resolvedFromId || !resolvedToId) {
      return res.status(404).json({
        error: "unable to resolve from/to stop IDs",
      });
    }

    const journeyOptions = {
      results: parsePositiveInt(req.body?.maxResults || req.query.maxResults, 5, 20),
      stopovers: false,
      remarks: true,
    };
    if (departure) journeyOptions.departure = departure;
    if (arrival) journeyOptions.arrival = arrival;
    if (resolvedViaId) journeyOptions.via = resolvedViaId;

    const response = await callProviderWithRetry(() =>
      provider.client.journeys(resolvedFromId, resolvedToId, journeyOptions),
    );

    res.json({
      provider: provider.key,
      fromId: resolvedFromId,
      viaId: resolvedViaId || null,
      toId: resolvedToId,
      generatedAt: nowIso(),
      items: response.journeys || [],
    });
  } catch (error) {
    res.status(502).json({
      error: "provider request failed",
      provider: provider.key,
      details: error?.message || String(error),
    });
  }
};

app.post("/api/v1/trips/query", queryTripsHandler);
app.post("/api/v1/journeys/plan", queryTripsHandler);

app.post("/api/v1/planner/query", async (req, res) => {
  const { from, to, fromId, toId, via, viaId, departureTime, arrivalTime, provider: providerFromBody } = req.body || {};
  const provider = parseProvider(providerFromBody || req.query.provider);
  if (!provider) {
    return res.status(400).json({
      error: "unsupported provider",
      supportedProviders: Object.keys(providers),
    });
  }

  if ((!from && !fromId) || (!to && !toId)) {
    return res.status(400).json({
      error: "from/to (or fromId/toId) are required",
    });
  }

  const departure = departureTime ? parseDeparture(departureTime) : null;
  const arrival = arrivalTime ? parseDeparture(arrivalTime) : null;
  if ((departureTime && !departure) || (arrivalTime && !arrival)) {
    return res.status(400).json({
      error: "departureTime/arrivalTime must be valid ISO timestamps",
    });
  }

  try {
    const resolvedFromId = await resolveStop(provider.client, from, fromId);
    const resolvedViaId = await resolveStop(provider.client, via, viaId);
    const resolvedToId = await resolveStop(provider.client, to, toId);
    if (!resolvedFromId || !resolvedToId) {
      return res.status(404).json({
        error: "unable to resolve from/to stop IDs",
      });
    }

    const fareProfile = normalizeFareProfile(req.body?.faresProfile);
    const supportsDeutschlandticket = provider.key === "db";
    if (!supportsDeutschlandticket) {
      fareProfile.deutschlandTicket = false;
      fareProfile.deutschlandTicketOnly = false;
    }

    const baseJourneyOptions = {
      results: parsePositiveInt(req.body?.maxResults || req.query.maxResults, 5, 20),
      stopovers: true,
      remarks: true,
    };
    if (departure) baseJourneyOptions.departure = departure;
    if (arrival) baseJourneyOptions.arrival = arrival;
    if (resolvedViaId) baseJourneyOptions.via = resolvedViaId;

    const isDbProvider = provider.key === "db";
    const hasDiscountProfile =
      isDbProvider &&
      (fareProfile.deutschlandTicket || fareProfile.deutschlandTicketOnly || fareProfile.bahnCard !== "none");

    const pricedJourneyOptions = isDbProvider
      ? {
          ...baseJourneyOptions,
          bestprice: false,
          deutschlandTicketDiscount: fareProfile.deutschlandTicket,
          deutschlandTicketConnectionsOnly: fareProfile.deutschlandTicketOnly,
          age: fareProfile.ages,
          loyaltyCard: fareProfile.loyaltyCards,
        }
      : baseJourneyOptions;

    const pricedResponse = await callProviderWithRetry(() =>
      provider.client.journeys(resolvedFromId, resolvedToId, pricedJourneyOptions),
    );

    const baseResponse = hasDiscountProfile
      ? await callProviderWithRetry(() =>
          provider.client.journeys(resolvedFromId, resolvedToId, {
            ...baseJourneyOptions,
            bestprice: false,
            deutschlandTicketDiscount: false,
            deutschlandTicketConnectionsOnly: false,
            age: Array.from({ length: fareProfile.travellerCount }, () => 30),
            loyaltyCard: Array.from({ length: fareProfile.travellerCount }, () => null),
          }),
        )
      : null;

    const fallbackNoPricingJourneys =
      (pricedResponse.journeys || []).length > 0 && (!hasDiscountProfile || (baseResponse?.journeys || []).length > 0)
        ? null
        : await callProviderWithRetry(() =>
            provider.client.journeys(resolvedFromId, resolvedToId, {
              ...baseJourneyOptions,
              bestprice: false,
            }),
          );

    const discountedJourneysRaw = (pricedResponse.journeys || []).length
      ? pricedResponse.journeys
      : fallbackNoPricingJourneys?.journeys || [];
    const baseJourneysRaw =
      hasDiscountProfile && (baseResponse?.journeys || []).length
        ? baseResponse.journeys
        : fallbackNoPricingJourneys?.journeys || pricedResponse.journeys || [];
    const discountedJourneys = capJourneys(discountedJourneysRaw, 5);
    const baseJourneys = capJourneys(baseJourneysRaw, 5);
    const baseBySignature = new Map(baseJourneys.map((item) => [mapJourneyBySignature(item), extractJourneyPrice(item)]));

    const journeys = discountedJourneys.map((journey, index) => {
      const summarized = summarizeJourney(journey, index);
      if (!hasDiscountProfile) return summarized;
      const signature = mapJourneyBySignature(journey);
      const basePrice = baseBySignature.get(signature) || null;
      const discountedPrice = summarized.price;
      const baseAmount = Number(basePrice?.amount);
      const discountedAmount = Number(discountedPrice?.amount);
      if (Number.isFinite(baseAmount) && Number.isFinite(discountedAmount)) {
        const savings = Math.max(baseAmount - discountedAmount, 0);
        const priceComparison = {
          base: { amount: baseAmount, currency: basePrice?.currency || "EUR" },
          discounted: { amount: discountedAmount, currency: discountedPrice?.currency || "EUR" },
          savings,
          hasDiscount: savings > 0,
        };
        return {
          ...summarized,
          priceComparison,
        };
      }
      if (Number.isFinite(discountedAmount)) {
        const priceComparison = {
          base: null,
          discounted: { amount: discountedAmount, currency: summarized.price?.currency || "EUR" },
          savings: 0,
          hasDiscount: false,
        };
        return {
          ...summarized,
          priceComparison,
        };
      }
      if (Number.isFinite(baseAmount)) {
        const priceComparison = {
          base: { amount: baseAmount, currency: basePrice?.currency || "EUR" },
          discounted: null,
          savings: 0,
          hasDiscount: false,
        };
        return {
          ...summarized,
          price: { amount: baseAmount, currency: basePrice?.currency || "EUR", hint: null },
          priceComparison,
        };
      }
      return summarized;
    });

    const betterbahnParams = new URLSearchParams();
    betterbahnParams.set("from", String(from || fromId || ""));
    betterbahnParams.set("to", String(to || toId || ""));
    if (departure) betterbahnParams.set("departure", departure.toISOString());
    betterbahnParams.set("deutschlandTicket", String(fareProfile.deutschlandTicket));
    betterbahnParams.set("deutschlandTicketOnly", String(fareProfile.deutschlandTicketOnly));
    betterbahnParams.set("bahnCard", String(fareProfile.bahnCard || "none"));
    betterbahnParams.set("travellerCount", String(fareProfile.travellerCount || 1));
    betterbahnParams.set("ages", (fareProfile.ages || []).join(","));

    res.json({
      provider: provider.key,
      fromId: resolvedFromId,
      viaId: resolvedViaId || null,
      toId: resolvedToId,
      generatedAt: nowIso(),
      map: {
        tileSource: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: "OpenStreetMap contributors",
      },
      betterbahn: {
        homepage: "https://betterbahn.de",
        github: "https://github.com/BetterBahn/betterbahn",
        routeUrl: `https://betterbahn.de/?${betterbahnParams.toString()}`,
        note: "BetterBahn focuses on DB split-ticketing.",
      },
      faresProfile: fareProfile,
      providerMeta: {
        supportsDeutschlandticket,
        country: isGermanProviderKey(provider.key) ? "DE" : "OTHER",
      },
      journeys,
    });
  } catch (error) {
    res.status(502).json({
      error: "provider request failed",
      provider: provider.key,
      details: error?.message || String(error),
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    path: req.path,
  });
});

app.listen(port, () => {
  console.log(`public-transport-enabler-web-api listening on port ${port}`);
});
