import { initChat, sendQuestion } from "/js/chat.js";
import { restoreVault, vaultData } from "/js/vault.js";
import { pickBrave, pickPerplexity, searchImages, searchWeb } from "/js/rag.js";
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

let activeRequest = 0;
let activeImageRequest = 0;
let requestedWebQuery = "";
let requestedImageQuery = "";
let loadedWebQuery = "";
let loadedImageQuery = "";
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

// Treffer kommen von Perplexity direkt oder über OpenRouter und werden pro Suchbegriff gecacht.
async function fetchResults(query) {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  const key = `web:v5:${normalizedQuery.toLocaleLowerCase("de")}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  if (!(await requireVault())) throw new Error("Speicher ist gesperrt.");
  const provider = pickPerplexity(vaultData().providers);
  if (!provider?.apiKey) throw new Error("Kein API-Key für Perplexity oder OpenRouter. Bitte in den Einstellungen hinterlegen.");
  const { citations } = await searchWeb({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, query: normalizedQuery });
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

// Jeder Treffer: Titel, darunter die URL als Trennlinie zum nächsten Treffer, dann die Beschreibung.
function renderHit(hit) {
  const url = safeUrl(hit.url);
  const li = el("li", "result");
  li.append(url
    ? el("a", "title", hit.title, { href: url, target: "_blank", rel: "noopener noreferrer" })
    : el("span", "title", hit.title));
  if (url) li.append(el("cite", "url", url.replace(/^https?:\/\//, "")));
  li.append(hit.description
    ? el("p", "description", hit.description)
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
    results.append(...hits.map(renderHit));
    loadedWebQuery = queryKey;
    statusEl.textContent = hits.length === 0 ? "Keine Ergebnisse gefunden." : `${hits.length} Ergebnisse`;
  } catch (err) {
    if (request === activeRequest) statusEl.textContent = `Fehler: ${err.message}`;
  } finally {
    if (requestedWebQuery === queryKey) requestedWebQuery = "";
  }
}

function applyQuery(query) {
  currentQuery = query.replace(/\s+/g, " ").trim();
  input.value = currentQuery;
  if (!currentQuery) {
    activeRequest += 1;
    activeImageRequest += 1;
    results.replaceChildren();
    imageResults.replaceChildren();
    statusEl.textContent = "";
    imagesStatus.textContent = "";
    requestedWebQuery = "";
    requestedImageQuery = "";
    loadedWebQuery = "";
    loadedImageQuery = "";
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
  }
}

function runCurrentQuery() {
  if (!currentQuery) return;
  void Promise.allSettled([
    runSearch(currentQuery),
    runImageSearch(currentQuery),
  ]);
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

// Ab dieser Wortzahl (oder mit Fragezeichen) gilt die Eingabe als Satz und geht in den Chat.
const SENTENCE_MIN_WORDS = 4;

function isSentence(query) {
  return query.endsWith("?") || query.split(/\s+/).length >= SENTENCE_MIN_WORDS;
}

// Erkennt Eingaben wie "example.de", "www.example.com/pfad" oder "https://example.org" (ohne Leerzeichen).
const DOMAIN_PATTERN = /^(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:[/?#]\S*)?$/i;

function domainUrl(query) {
  if (!DOMAIN_PATTERN.test(query)) return null;
  return new URL(/^https?:\/\//i.test(query) ? query : `https://${query}`).href;
}

async function openChatWith(question) {
  if (!(await requireVault())) return;
  await showView("chat");
  sendQuestion(question);
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
  if (isSentence(query)) {
    input.value = "";
    await openChatWith(query);
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
