import { initChat } from "/js/chat.js";
import { restoreVault, vaultData } from "/js/vault.js";
import { pickBrave, pickOpenRouter, searchImages, searchPlaces, searchWeb, searchWebBrave } from "/js/rag.js";
import { initSettings, requireVault } from "/js/settings.js";
import { activeView, initViews, savedView, showView } from "/js/views.js";

const DB_NAME = "opensearchy";
const DB_VERSION = 2;
const DB_STORE = "cache";
const MAX_QUERY_CHARS = 200;
const SEARCH_TTL = 10 * 60 * 1000;

const form = document.querySelector("form");
const input = form.querySelector('input[name="q"]');
const statusEl = document.getElementById("status");
const results = document.getElementById("results");
const imagesStatus = document.getElementById("images-status");
const imageResults = document.getElementById("image-results");
const mapStatus = document.getElementById("map-status");
const mapResults = document.getElementById("map-results");
const mapCanvas = document.getElementById("map-canvas");

let activeRequest = 0;
let activeImageRequest = 0;
let activeMapRequest = 0;
let requestedWebQuery = "";
let requestedImageQuery = "";
let requestedMapQuery = "";
let loadedWebQuery = "";
let loadedImageQuery = "";
let loadedMapQuery = "";
let map = null;
let mapMarkers = null;
let pendingMapBounds = null;
let dbPromise = null;
let currentQuery = "";

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (db.objectStoreNames.contains("searches")) db.deleteObjectStore("searches");
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

// Liefert undefined bei fehlendem oder abgelaufenem Eintrag.
async function cacheGet(key) {
  try {
    const db = await openDb();
    const entry = await new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (entry && Date.now() < entry.expires) {
      return entry.value;
    }
  } catch (err) {
    console.warn("Cache-Lesefehler", err);
  }
  return undefined;
}

async function cachePut(key, value, ttl) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put({ value, expires: Date.now() + ttl }, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("Cache-Schreibfehler", err);
  }
}

async function cacheCleanup() {
  try {
    const db = await openDb();
    const tx = db.transaction(DB_STORE, "readwrite");
    const request = tx.objectStore(DB_STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (Date.now() >= cursor.value.expires) cursor.delete();
      cursor.continue();
    };
  } catch (err) {
    console.warn("Cache-Bereinigung fehlgeschlagen", err);
  }
}

// Treffer kommen über die OpenRouter-Websuche und werden pro Suchbegriff gecacht.
async function fetchResults(query) {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  const key = `web:v8:${normalizedQuery.toLocaleLowerCase("de")}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  if (!(await requireVault())) throw new Error("Speicher ist gesperrt.");
  const providers = vaultData().providers;
  const brave = pickBrave(providers);
  const openRouter = pickOpenRouter(providers);
  if (!brave?.apiKey && !openRouter?.apiKey) {
    throw new Error("Kein API-Key für Brave Search oder OpenRouter. Bitte in den Einstellungen hinterlegen.");
  }
  const { citations } = brave?.apiKey
    ? await searchWebBrave({ apiKey: brave.apiKey, query: normalizedQuery })
    : await searchWeb({ baseUrl: openRouter.baseUrl, apiKey: openRouter.apiKey, query: normalizedQuery });
  const hits = citations.map(({ title, url, content }) => ({ title, url, description: content }));

  await cachePut(key, hits, SEARCH_TTL);
  return hits;
}

async function fetchImages(query) {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  const key = `images:v3:${normalizedQuery.toLocaleLowerCase("de")}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  await restoreVault();
  const brave = pickBrave(vaultData()?.providers ?? []);
  const result = await searchImages({
    braveApiKey: brave?.apiKey ?? "",
    query: normalizedQuery,
  });
  await cachePut(key, result, SEARCH_TTL);
  return result;
}

async function fetchGeocodedPlaces(query) {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  const key = `map:v2:${normalizedQuery.toLocaleLowerCase("de")}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  const response = await fetch(`/api/maps/search?q=${encodeURIComponent(normalizedQuery)}`);
  if (!response.ok) {
    throw new Error(`OpenStreetMap antwortet mit HTTP ${response.status}.`);
  }
  const places = await response.json();
  await cachePut(key, places, SEARCH_TTL);
  return places;
}

const MAP_CATEGORIES = [
  {
    id: "doctors",
    pattern: /\b(ärzt|ärzte|arzt|ärztin|hausarzt|praxis|mediziner)\w*\b/i,
  },
  {
    id: "dentist",
    pattern: /\b(zahnarzt|zahnärzt|zahnärzte|zahnklinik)\w*\b/i,
  },
  { id: "hospital", pattern: /\b(krankenhaus|hospital|klinik)\w*\b/i },
  { id: "pharmacy", pattern: /\b(apotheke|pharmazie)\w*\b/i },
  { id: "physician", pattern: /\b(physiotherapie|physiotherapeut)\w*\b/i },
];

function mapCategory(query) {
  const category = MAP_CATEGORIES.find((item) => item.pattern.test(query));
  if (!category) return null;
  const location = query
    .replace(category.pattern, "")
    .replace(/\b(in|bei|nähe|nahe|rund um|suchen|finden)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { ...category, location };
}

const MEDICAL_NAME_HINT = /\b(dr\.?|doktor|facharzt|fachärztin|kardiolog|orthopäd|neurolog|dermatolog|gynäkolog|urolog|pädiater|augenarzt|hno|internist|chirurg)\w*\b/i;

async function namedMedicalQuery(query) {
  if (!MEDICAL_NAME_HINT.test(query)) return null;
  const words = query.trim().split(/\s+/);
  for (let locationWords = Math.min(3, words.length - 1); locationWords >= 1; locationWords -= 1) {
    const nameWords = words.slice(0, -locationWords);
    const location = words.slice(-locationWords).join(" ");
    const places = await fetchGeocodedPlaces(location);
    if (!places.length) continue;
    const term = nameWords
      .join(" ")
      .replace(/\b(dr\.?|doktor|facharzt|fachärztin)\b/gi, " ")
      .replace(/\b(kardiolog|orthopäd|neurolog|dermatolog|gynäkolog|urolog|pädiater|augenarzt|hno|internist|chirurg)\w*\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!term) break;
    return { id: "named", location, term, place: places[0] };
  }
  return null;
}

const NOMINATIM_INTERVAL = 1100;
let lastGeocodeAt = 0;

// Nominatim erlaubt höchstens eine Anfrage pro Sekunde; Treffer aus dem Cache kosten keine Wartezeit.
async function geocodeAddress(address) {
  const key = `map:v2:${address.replace(/\s+/g, " ").trim().toLocaleLowerCase("de")}`;
  const cached = await cacheGet(key);
  if (cached) return cached[0];
  const wait = lastGeocodeAt + NOMINATIM_INTERVAL - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastGeocodeAt = Date.now();
  return (await fetchGeocodedPlaces(address))[0];
}

// OpenRouter findet die Einrichtungen; die Position stammt aus der Geokodierung ihrer Adresse.
async function fetchOpenRouterPlaces(query, onProgress) {
  const key = `map:openrouter:v2:${query.toLocaleLowerCase("de")}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  if (!(await requireVault())) return [];
  const provider = pickOpenRouter(vaultData().providers);
  if (!provider?.apiKey) return [];
  const found = await searchPlaces({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, query });
  const places = [];
  for (const entry of found) {
    try {
      const geocoded = await geocodeAddress(entry.address);
      const lat = Number(geocoded?.lat);
      const lon = Number(geocoded?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      places.push({
        lat,
        lon,
        display_name: `${entry.name} · ${entry.address}`,
        type: entry.type || "medical",
        address: entry.address,
        website: entry.website,
        osmUrl: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`,
      });
      onProgress?.([...places]);
    } catch (err) {
      console.warn(`Adresse „${entry.address}“ konnte nicht geokodiert werden:`, err);
    }
  }
  if (places.length) await cachePut(key, places, SEARCH_TTL);
  return places;
}

async function fetchMapResults(query, onProgress) {
  const category = mapCategory(query);
  if (category && !category.location) {
    throw new Error(`Bitte bei „${query.trim()}“ auch einen Ort angeben, zum Beispiel „Arzt Berlin“.`);
  }
  if (category || MEDICAL_NAME_HINT.test(query)) {
    try {
      const places = await fetchOpenRouterPlaces(query, onProgress);
      if (places.length) return places;
    } catch (err) {
      console.warn("OpenRouter-Ortssuche fehlgeschlagen, nutze OpenStreetMap:", err);
    }
  }
  const named = category ? null : await namedMedicalQuery(query);
  if (!category && !named) return fetchGeocodedPlaces(query);
  if (named) {
    return fetchNearbyMedical(named.id, named.location, named.place, named.term);
  }
  if (!category.location) {
    throw new Error(`Bitte bei „${query.trim()}“ auch einen Ort angeben, zum Beispiel „Arzt Berlin“.`);
  }
  const places = await fetchGeocodedPlaces(category.location);
  const place = places[0];
  return fetchNearbyMedical(category.id, category.location, place);
}

async function fetchNearbyMedical(category, location, place, term = "") {
  const [south, north, west, east] = place?.boundingbox?.map(Number) ?? [];
  if (![south, north, west, east].every(Number.isFinite)) {
    throw new Error(`Für „${location}“ wurde kein Suchgebiet gefunden.`);
  }
  const latPadding = Math.max(0.03, (north - south) * 0.05);
  const lonPadding = Math.max(0.03, (east - west) * 0.05);
  const params = new URLSearchParams({
    category,
    south: String(Math.max(-90, south - latPadding)),
    west: String(Math.max(-180, west - lonPadding)),
    north: String(Math.min(90, north + latPadding)),
    east: String(Math.min(180, east + lonPadding)),
    ...(term ? { term } : {}),
  });
  const key = `map:nearby:v2:${category}:${location.toLocaleLowerCase("de")}:${term.toLocaleLowerCase("de")}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  const response = await fetch(`/api/maps/nearby?${params}`);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenStreetMap antwortet mit HTTP ${response.status}: ${detail}`);
  }
  const data = await response.json();
  const nearby = (data.elements ?? []).map((element) => {
    const tags = element.tags ?? {};
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    const address = [tags["addr:street"], tags["addr:housenumber"], tags["addr:postcode"], tags["addr:city"]]
      .filter(Boolean)
      .join(" ");
    const website = safeUrl(tags.website ?? tags["contact:website"])?.toString();
    const osmUrl = `https://www.openstreetmap.org/${element.type}/${element.id}`;
    return {
      lat,
      lon,
      display_name: [tags.name, address || location].filter(Boolean).join(" · "),
      type: tags.healthcare ?? tags.amenity ?? "medical",
      address,
      website,
      osmUrl,
    };
  }).filter((place) => Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon)));
  await cachePut(key, nearby, SEARCH_TTL);
  return nearby;
}

function el(tag, className, text, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

function safeUrl(url) {
  return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
}

function appendMarkdownBold(node, text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**")) {
      node.append(el("strong", "", part.slice(2, -2)));
    } else {
      node.append(document.createTextNode(part));
    }
  }
  return node;
}

// Jeder Treffer: Titel, darunter die URL als Trennlinie zum nächsten Treffer, dann die Beschreibung.
function renderHit(hit) {
  const url = safeUrl(hit.url);
  const li = el("li", "result");
  li.append(url
    ? el("a", "title", hit.title, { href: url, target: "_blank", rel: "noopener noreferrer" })
    : el("span", "title", hit.title));
  if (url) li.append(el("cite", "url", url.replace(/^https?:\/\//, "")));
  li.append(hit.description
    ? appendMarkdownBold(el("p", "description"), hit.description)
    : el("p", "note", "Keine Beschreibung verfügbar."));
  return li;
}

function renderImage(hit) {
  const pageUrl = safeUrl(hit.pageUrl);
  const imageUrl = safeUrl(hit.imageUrl);
  if (!pageUrl || !imageUrl) return null;
  const card = pageUrl ? el("a", "image-card", undefined, {
    href: pageUrl,
    target: "_blank",
    rel: "noopener noreferrer",
  }) : el("article", "image-card");
  const frame = el("div", "image-frame");
  const image = el("img", "image-result", undefined, {
    src: imageUrl,
    alt: hit.title || "Suchergebnis",
    loading: "lazy",
    decoding: "async",
    referrerpolicy: "no-referrer",
  });
  image.addEventListener("error", () => {
    frame.replaceChildren(el("span", "image-error", "Bild nicht verfügbar"));
    card.classList.add("unavailable");
  }, { once: true });
  frame.append(image);
  card.append(frame, el("span", "image-title", hit.title || "Bild öffnen"));
  card.append(el("span", "image-source", new URL(pageUrl).hostname.replace(/^www\./, "")));
  return card;
}

async function runImageSearch(query) {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  if (!normalizedQuery) {
    imagesStatus.textContent = "Suchbegriff eingeben, um Bilder zu finden.";
    imageResults.replaceChildren();
    loadedImageQuery = "";
    return;
  }
  const queryKey = normalizedQuery.toLocaleLowerCase("de");
  if (normalizedQuery.length > MAX_QUERY_CHARS) {
    imagesStatus.textContent = "Fehler: Suchbegriff ist zu lang.";
    return;
  }
  if (queryKey === requestedImageQuery || queryKey === loadedImageQuery) return;
  requestedImageQuery = queryKey;
  const request = ++activeImageRequest;
  imageResults.replaceChildren();
  imagesStatus.textContent = "Bilder werden gesucht …";
  try {
    const { images, providers } = await fetchImages(normalizedQuery);
    if (request !== activeImageRequest) return;
    const cards = images.map(renderImage).filter(Boolean);
    imageResults.append(...cards);
    loadedImageQuery = normalizedQuery.toLocaleLowerCase("de");
    const sourceText = providers.length ? ` · ${providers.join(", ")}` : "";
    imagesStatus.textContent = cards.length ? `${cards.length} Bilder${sourceText}` : "Keine Bilder gefunden.";
  } catch (err) {
    if (request === activeImageRequest) imagesStatus.textContent = `Fehler: ${err.message}`;
  } finally {
    if (requestedImageQuery === queryKey) requestedImageQuery = "";
  }
}

async function runSearch(query) {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  const queryKey = normalizedQuery.toLocaleLowerCase("de");
  if (!normalizedQuery || queryKey === requestedWebQuery || queryKey === loadedWebQuery) return;
  if (normalizedQuery.length > MAX_QUERY_CHARS) {
    statusEl.textContent = "Fehler: Suchbegriff ist zu lang.";
    return;
  }
  requestedWebQuery = queryKey;
  const request = ++activeRequest;
  results.replaceChildren();
  statusEl.textContent = "Suche läuft …";

  try {
    const hits = await fetchResults(normalizedQuery);
    if (request !== activeRequest) return;
    results.replaceChildren(...hits.map(renderHit));
    loadedWebQuery = queryKey;
    statusEl.textContent = hits.length === 0 ? "Keine Ergebnisse gefunden." : `${hits.length} Ergebnisse`;
  } catch (err) {
    if (request === activeRequest) statusEl.textContent = `Fehler: ${err.message}`;
  } finally {
    if (requestedWebQuery === queryKey) requestedWebQuery = "";
  }
}

function ensureMap() {
  if (map) return map;
  if (!globalThis.L) throw new Error("Die OpenStreetMap-Karte konnte nicht geladen werden.");
  map = L.map(mapCanvas, { zoomControl: true, attributionControl: false })
    .setView([51.1657, 10.4515], 6);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  mapMarkers = L.layerGroup().addTo(map);
  return map;
}

function renderMapPlace(place) {
  const lat = Number(place.lat);
  const lon = Number(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || place.type === "bus_stop") return null;
  const item = el("li", "map-result");
  const name = el("button", "map-result-button", place.display_name, { type: "button" });
  name.addEventListener("click", () => {
    map?.setView([lat, lon], Math.max(map.getZoom(), 14));
  });
  const links = el("div", "map-result-links");
  const osmUrl = place.osmUrl || (place.osm_type && place.osm_id
    ? `https://www.openstreetmap.org/${place.osm_type}/${place.osm_id}`
    : "");
  // Nominatim liefert `address` als Objekt; nur Text-Adressen sind verwendbar.
  const address = [place.address, place.display_name].find((value) => typeof value === "string" && value);
  if (address && osmUrl) {
    const addressLink = el("a", "map-result-address", address, {
      href: osmUrl,
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Klicken, um die Adresse zu kopieren",
    });
    addressLink.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(address);
      } catch (err) {
        console.warn("Adresse konnte nicht kopiert werden:", err);
        return;
      }
      addressLink.classList.add("copied");
      setTimeout(() => addressLink.classList.remove("copied"), 1500);
    });
    links.append(addressLink);
  }
  if (place.website) {
    const website = new URL(place.website);
    links.append(el("a", "map-result-website", website.hostname.replace(/^www\./, ""), {
      href: place.website,
      target: "_blank",
      rel: "noopener noreferrer",
    }));
  }
  item.append(
    name,
    links,
    el("span", "map-result-type", place.type?.replaceAll("_", " ") ?? "Ort")
  );
  return { item, lat, lon, place };
}

function showMapPlaces(places) {
  const rendered = places.map(renderMapPlace).filter(Boolean);
  mapResults.replaceChildren(...rendered.map((entry) => entry.item));
  const instance = ensureMap();
  mapMarkers.clearLayers();
  const points = [];
  for (const { lat, lon, place } of rendered) {
    const marker = L.marker([lat, lon]).addTo(mapMarkers);
    marker.bindPopup(place.display_name);
    points.push([lat, lon]);
  }
  if (points.length) {
    pendingMapBounds = points;
    if (activeView() === "map") {
      requestAnimationFrame(() => {
        instance.invalidateSize();
        if (pendingMapBounds) instance.fitBounds(pendingMapBounds, { padding: [35, 35], maxZoom: 14 });
        pendingMapBounds = null;
      });
    }
  }
  return rendered.length;
}

async function runMapSearch(query) {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  const queryKey = normalizedQuery.toLocaleLowerCase("de");
  if (!normalizedQuery) {
    mapStatus.textContent = "Ort oder Adresse eingeben, um die Karte zu durchsuchen.";
    mapResults.replaceChildren();
    loadedMapQuery = "";
    return;
  }
  if (normalizedQuery.length > MAX_QUERY_CHARS) {
    mapStatus.textContent = "Fehler: Suchbegriff ist zu lang.";
    return;
  }
  if (queryKey === requestedMapQuery || queryKey === loadedMapQuery) return;
  requestedMapQuery = queryKey;
  const request = ++activeMapRequest;
  mapResults.replaceChildren();
  mapStatus.textContent = "Orte werden gesucht …";
  try {
    const places = await fetchMapResults(normalizedQuery, (partial) => {
      if (request !== activeMapRequest) return;
      const count = showMapPlaces(partial);
      mapStatus.textContent = `${count} Orte gefunden, weitere werden gesucht …`;
    });
    if (request !== activeMapRequest) return;
    const count = showMapPlaces(places);
    loadedMapQuery = queryKey;
    mapStatus.textContent = count ? `${count} Orte` : "Keine Orte gefunden.";
  } catch (err) {
    if (request === activeMapRequest) mapStatus.textContent = `Fehler: ${err.message}`;
  } finally {
    if (requestedMapQuery === queryKey) requestedMapQuery = "";
  }
}

function applyQuery(query) {
  currentQuery = query.replace(/\s+/g, " ").trim();
  input.value = currentQuery;
  document.body.classList.toggle("has-query", Boolean(currentQuery));
  if (!currentQuery) {
    activeRequest += 1;
    activeImageRequest += 1;
    activeMapRequest += 1;
    results.replaceChildren();
    imageResults.replaceChildren();
    mapResults.replaceChildren();
    statusEl.textContent = "";
    imagesStatus.textContent = "";
    mapStatus.textContent = "";
    requestedWebQuery = "";
    requestedImageQuery = "";
    requestedMapQuery = "";
    loadedWebQuery = "";
    loadedImageQuery = "";
    loadedMapQuery = "";
    return;
  }
  window.dispatchEvent(new CustomEvent("query-changed", { detail: currentQuery }));
}

function renderCurrentView() {
  if (!currentQuery) return;
  if (activeView() === "images") {
    runImageSearch(currentQuery);
  } else if (activeView() === "search") {
    runSearch(currentQuery);
  } else if (activeView() === "map") {
    runMapSearch(currentQuery);
    requestAnimationFrame(() => {
      if (!map) return;
      map.invalidateSize();
      if (pendingMapBounds) {
        map.fitBounds(pendingMapBounds, { padding: [35, 35], maxZoom: 14 });
        pendingMapBounds = null;
      }
    });
  }
}

function runCurrentQuery() {
  if (!currentQuery) return;
  renderCurrentView();
}

function runFromUrl() {
  applyQuery(new URLSearchParams(location.search).get("q") ?? "");
  document.body.classList.add("search-home");
}

function isReload() {
  return performance.getEntriesByType("navigation")[0]?.type === "reload";
}

function clearQueryOnReload() {
  if (!isReload() || !new URLSearchParams(location.search).has("q")) return;
  const url = new URL(location.href);
  url.searchParams.delete("q");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

// Erkennt Eingaben wie "example.de", "www.example.com/pfad" oder "https://example.org" (ohne Leerzeichen).
const DOMAIN_PATTERN = /^(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:[/?#]\S*)?$/i;

function domainUrl(query) {
  if (!DOMAIN_PATTERN.test(query)) return null;
  return new URL(/^https?:\/\//i.test(query) ? query : `https://${query}`).href;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query) return;
  const url = domainUrl(query);
  if (url) {
    location.href = url;
    return;
  }
  history.pushState(null, "", `/?q=${encodeURIComponent(query)}`);
  applyQuery(query);
});

window.addEventListener("popstate", runFromUrl);
window.addEventListener("query-changed", runCurrentQuery);
window.addEventListener("view-changed", renderCurrentView);

cacheCleanup();
initSettings();
initChat();
initViews();
clearQueryOnReload();
runFromUrl();
restoreVault().then((restored) => {
  if (restored) window.dispatchEvent(new Event("vault-changed"));
  if (!isReload()) return;
  const previousView = savedView();
  if (!previousView || previousView === "search") return;
  if (previousView === "chat" && !restored) return;
  showView(previousView);
});
