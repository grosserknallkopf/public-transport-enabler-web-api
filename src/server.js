import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8080);

app.use(cors());
app.use(express.json());

const nowIso = () => new Date().toISOString();

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "public-transport-enabler-web-api",
    timestamp: nowIso(),
  });
});

app.get("/api/v1/stations", (req, res) => {
  const query = String(req.query.q || "").toLowerCase().trim();
  const stations = [
    { id: "de-hh-hbf", name: "Hamburg Hbf", city: "Hamburg" },
    { id: "de-b-bf-zoo", name: "Berlin Zoologischer Garten", city: "Berlin" },
    { id: "de-m-hbf", name: "München Hbf", city: "München" },
    { id: "de-k-hbf", name: "Köln Hbf", city: "Köln" },
  ];

  const filtered = query
    ? stations.filter(
        (station) =>
          station.name.toLowerCase().includes(query) ||
          station.city.toLowerCase().includes(query) ||
          station.id.toLowerCase().includes(query),
      )
    : stations;

  res.json({
    count: filtered.length,
    items: filtered,
  });
});

app.post("/api/v1/journeys/plan", (req, res) => {
  const { from, to, departureTime } = req.body || {};

  if (!from || !to) {
    return res.status(400).json({
      error: "from and to are required",
    });
  }

  const requestedDeparture = departureTime || nowIso();
  const journey = {
    from,
    to,
    departureTime: requestedDeparture,
    durationMinutes: 42,
    transfers: 1,
    segments: [
      { line: "S1", mode: "train", from, to: "Central Hub", durationMinutes: 18 },
      { line: "U2", mode: "subway", from: "Central Hub", to, durationMinutes: 24 },
    ],
  };

  res.json({
    items: [journey],
    generatedAt: nowIso(),
  });
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
