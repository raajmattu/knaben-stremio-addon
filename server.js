// server.js — Knaben Stremio add-on (format streams like rich rows: seeders + size)
// For YOUR OWN videos / YOUR OWN magnets / YOUR OWN server listings.

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const cheerio = require("cheerio");

// node-fetch dynamic import (Node 24 compatible)
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const PORT = Number(process.env.PORT || 7010);

// ================== CONFIG ==================
const BASE = "https://knaben.org"; // <-- change to your server domain

// IMPORTANT: set this to your real search URL pattern.
// Examples:
//  - WordPress style: return `${BASE}/?s=${encodeURIComponent(q)}`;
//  - Custom search:   return `${BASE}/search?q=${encodeURIComponent(q)}`;
function SEARCH_URL(q) {
  return `${BASE}/search?q=${encodeURIComponent(q)}`;
}

// Optional: how you want the provider/source line to look in Stremio.
// We'll also append the row's "Source" column if we can find it.
const PROVIDER_PREFIX = "Knaben";
// ===========================================

// parse-torrent is ESM; dynamic import for Node 24
async function parseTorrentAny(input) {
  const mod = await import("parse-torrent");
  const fn = mod.default || mod;
  return fn(input);
}

async function fetchText(url) {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Knaben/1.0",
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
      redirect: "follow",
    });
    if (!r.ok) return null;
    return await r.text();
  } catch (e) {
    console.log("fetchText error:", e?.message || e);
    return null;
  }
}

async function fetchJson(url) {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Knaben/1.0",
        "Accept": "application/json,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.log("fetchJson error:", e?.message || e);
    return null;
  }
}

// -------------------- helpers --------------------

function normalize(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function toISODateOnly(released) {
  if (!released) return null;
  const m = String(released).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function formatDateVariants(isoDate) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return [];
  const [y, m, d] = isoDate.split("-").map(Number);

  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mon = monthNames[m - 1];
  const dd = String(d);

  const suffix =
    d % 100 >= 11 && d % 100 <= 13 ? "th"
    : d % 10 === 1 ? "st"
    : d % 10 === 2 ? "nd"
    : d % 10 === 3 ? "rd"
    : "th";

  return [
    `${dd} ${mon} ${y}`,                  // 24 Feb 2026
    `${dd}${suffix} ${mon} ${y}`,         // 24th Feb 2026
    `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}` // 2026-02-24
  ];
}

function matchByDate(title, dateVariants) {
  const t = normalize(title);
  return (dateVariants || []).some(d => t.includes(normalize(d)));
}

function parseSizeToBytes(sizeStr) {
  // Accepts "613.5MB", "613.5 MB", "1.06 GB", "552.7 MiB"
  if (!sizeStr) return undefined;
  const s = String(sizeStr).trim().replace(/\s+/g, "");
  const m = s.match(/^([\d.]+)(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i);
  if (!m) return undefined;

  const num = parseFloat(m[1]);
  const unit = m[2].toUpperCase();

  const base = unit.includes("IB") ? 1024 : 1000;
  const mult =
    unit === "B" ? 1 :
    unit === "KB" || unit === "KIB" ? base ** 1 :
    unit === "MB" || unit === "MIB" ? base ** 2 :
    unit === "GB" || unit === "GIB" ? base ** 3 :
    unit === "TB" || unit === "TIB" ? base ** 4 : 1;

  return Math.round(num * mult);
}

// -------------------- table row extraction --------------------
// Expects rows like:
// Category | Title | Size | Date | Seeders | Leechers | Source
//
// Magnet can be:
// 1) <a href="magnet:...">Title</a>
// 2) onclick contains magnet
// 3) data-magnet / data-href contains magnet
function extractRows(html) {
  const $ = cheerio.load(html);
  const out = [];

  $("tr").each((_, tr) => {
    const $tr = $(tr);
    const tds = $tr.find("td");
    if (tds.length < 2) return;

    // Title: most likely td[1]
    const title = $(tds[1]).text().replace(/\s+/g, " ").trim();
    if (!title) return;

    // Try magnet in the SAME row
    let magnet =
      $tr.find('a[href^="magnet:?xt=urn:btih:"]').first().attr("href") ||
      $tr.find("[data-magnet]").first().attr("data-magnet") ||
      $tr.find("[data-href]").first().attr("data-href") ||
      null;

    if (!magnet) {
      const onclick = $tr.find("[onclick]").first().attr("onclick") || "";
      const m = onclick.match(/magnet:\?xt=urn:btih:[^'"\s)]+/i);
      if (m) magnet = m[0];
    }

    if (!magnet || !magnet.startsWith("magnet:?xt=urn:btih:")) return;

    // Size / seeders / source: best-effort based on common column layout.
    // If your table matches the screenshot layout, these indices are correct:
    // 0 category, 1 title, 2 size, 3 date, 4 seeders, 5 leechers, 6 source
    const size = (tds.length >= 3 ? $(tds[2]).text().trim() : "") || "";
    const seedersRaw = (tds.length >= 5 ? $(tds[4]).text().trim() : "") || "";
    const source = (tds.length >= 7 ? $(tds[6]).text().trim() : "") || "";

    const seeders = parseInt(seedersRaw, 10);
    out.push({
      title,
      magnet,
      size,
      seeders: Number.isFinite(seeders) ? seeders : 0,
      source,
    });
  });

  // De-dupe by magnet
  const seen = new Set();
  return out.filter(r => {
    if (seen.has(r.magnet)) return false;
    seen.add(r.magnet);
    return true;
  });
}

// -------------------- search -> streams --------------------
async function findStreamsForQuery(query, label, dateVariants) {
  const html = await fetchText(SEARCH_URL(query));
  if (!html) return [];

  const rows = extractRows(html);

  // Only keep rows that match the specific episode date (prevents “same magnet for every episode”)
  const matching = dateVariants?.length ? rows.filter(r => matchByDate(r.title, dateVariants)) : rows;

  const streams = [];
  const seen = new Set();

  for (const r of matching) {
    try {
      const parsed = await parseTorrentAny(r.magnet);
      const infoHash = parsed.infoHash;

      if (!infoHash || seen.has(infoHash)) continue;
      seen.add(infoHash);

      const videoSizeBytes = parseSizeToBytes(r.size);

      // This controls the right-side provider/source line like your screenshot.
      // Example output: "Knaben|MyServer" or "Knaben|1337x"
      const providerLine = r.source
        ? `${PROVIDER_PREFIX}|${r.source}`
        : `${PROVIDER_PREFIX}|MyServer`;

streams.push({
    name: r.source || "Knaben",

    // TWO-LINE TITLE (Stremio shows both lines perfectly)
    title: `${r.title}
Seeders: ${r.seeders} • Size: ${r.size} • Server: ${r.source || "Knaben"}`,

    infoHash,
    peerCount: r.seeders || 0,

    behaviorHints: {
        ...(videoSizeBytes ? { videoSize: videoSizeBytes } : {}),
    },
});
    } catch (e) {
      // ignore parse errors
    }
  }

  return streams;
}

// -------------------- Cinemeta lookups --------------------
async function cinemetaEpisodeInfo(imdbId, season, episode) {
  const metaUrl = `https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(imdbId)}.json`;
  const data = await fetchJson(metaUrl);
  const meta = data?.meta;
  if (!meta) return null;

  const s = Number(season);
  const e = Number(episode);
  const v = (meta.videos || []).find(x => Number(x.season) === s && Number(x.episode) === e);
  if (!v) return null;

  return { showName: meta.name, epTitle: v.title, released: v.released };
}

async function cinemetaMovieInfo(imdbId) {
  const metaUrl = `https://v3-cinemeta.strem.io/meta/movie/${encodeURIComponent(imdbId)}.json`;
  const data = await fetchJson(metaUrl);
  const meta = data?.meta;
  if (!meta) return null;

  return { title: meta.name, released: meta.released };
}

// -------------------- Stremio manifest + handler --------------------
const manifest = {
  id: "org.knaben.privatestreams",
  version: "4.0.0",
  name: "Knaben",
  description: "Displays streams with seeders + filesize like Stremio rich rows (for your own content).",
  resources: ["stream"],
  types: ["series", "movie"],
  catalogs: [],
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  console.log("STREAM REQUEST:", type, id);

  try {
    if (type === "series") {
      const [imdbId, season, episode] = String(id).split(":");
      if (!imdbId?.startsWith("tt") || !season || !episode) return { streams: [] };

      const info = await cinemetaEpisodeInfo(imdbId, season, episode);
      if (!info?.showName) return { streams: [] };

      const isoDate = toISODateOnly(info.released);
      const dateVariants = formatDateVariants(isoDate);
      const epCode = `S${String(season).padStart(2,"0")}E${String(episode).padStart(2,"0")}`;
      // What Stremio shows as the small label if you look at stream details
      const label = `${info.showName} • ${dateVariants[1] || isoDate || ""} • S${season}E${episode}`.replace(/\s+•\s+$/, "");

      // Strong -> weak queries
const queries = [
    // 1) Search using SxxEyy FIRST (this matches your server)
    `${info.showName} ${epCode}`,
    `${info.showName}.${epCode}`,
    `${info.showName.replace(/\s+/g, ".")}.${epCode}`,

    // 2) Date-based searches (if the show uses dates)
    ...dateVariants.map(d => `${info.showName} ${d}`),
    isoDate ? `${info.showName} ${isoDate}` : null,

    // 3) Generic fallback
    info.showName
].filter(Boolean);

      let all = [];
for (const q of queries) {
    const isEpisodeQuery = q.includes(epCode);

    const got = await findStreamsForQuery(
        q,
        label,
        isEpisodeQuery ? null : dateVariants   // <-- THE FIX
    );

    if (got.length) all = all.concat(got);
}

      // Final de-dupe by infoHash
      const uniq = [];
      const seen = new Set();
      for (const s of all) {
        if (seen.has(s.infoHash)) continue;
        seen.add(s.infoHash);
        uniq.push(s);
      }

      return { streams: uniq };
    }

 if (type === "movie") {
    if (!String(id).startsWith("tt")) return { streams: [] };

    const info = await cinemetaMovieInfo(id);
    if (!info?.title) return { streams: [] };

    const isoDate = toISODateOnly(info.released);
    const dateVariants = formatDateVariants(isoDate);

    const label = `${info.title} • ${dateVariants[1] || isoDate || ""}`.replace(/\s+•\s+$/, "");

    // MOVIES DO NOT USE epCode (SxxEyy) — never include it here
    const queries = [
        ...dateVariants.map(d => `${info.title} ${d}`),
        isoDate ? `${info.title} ${isoDate}` : null,
        info.title
    ].filter(Boolean);

    let all = [];
    for (const q of queries) {
        const got = await findStreamsForQuery(q, label, dateVariants);
        if (got.length) all = all.concat(got);
    }

    // de-dupe
    const uniq = [];
    const seen = new Set();
    for (const s of all) {
        if (seen.has(s.infoHash)) continue;
        seen.add(s.infoHash);
        uniq.push(s);
    }

    return { streams: uniq };
}

    return { streams: [] };
  } catch (e) {
    console.log("ERROR:", e?.message || e);
    return { streams: [] };
  }
});

// Listen on all interfaces so LAN devices (Android box) can reach it
serveHTTP(builder.getInterface(), { port: PORT, host: "0.0.0.0" });

console.log(`Knaben addon running at http://127.0.0.1:${PORT}/manifest.json`);
console.log(`LAN install URL: http://YOUR_PC_IP:${PORT}/manifest.json`);