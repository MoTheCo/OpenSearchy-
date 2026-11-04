import { initChat, sendQuestion } from "/js/chat.js";
import { restoreVault } from "/js/vault.js";
import { initSettings, requireVault } from "/js/settings.js";
import { initViews, savedView, showView } from "/js/views.js";

const DB_NAME = "opensearchy";
const DB_VERSION = 2;
const DB_STORE = "cache";
const WIKI_API = "https://de.wikipedia.org/w/api.php";
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
const PAGE_SIZE = 20;
const SEARCH_BATCHES = 1;
const MAX_QUERY_CHARS = 200;
const SEARCH_TTL = 10 * 60 * 1000;
const ENTITY_TTL = 60 * 60 * 1000;
const CLASS_TTL = 24 * 60 * 60 * 1000;
// Wikidata: Unternehmen, Firma, Enterprise
const COMPANY_CLASSES = ["Q4830453", "Q783794", "Q6881511"];
// Relevanz-Gewichte
const TIER_WEIGHT = 1000;
const POPULARITY_WEIGHT = 1;
const WEBSITE_BOOST = 300; // Boost für Ergebnisse mit externem Link

const form = document.querySelector("form");
const input = form.querySelector('input[name="q"]');
const statusEl = document.getElementById("status");
const results = document.getElementById("results");
const moreLink = document.getElementById("more");

let currentQuery = "";
let nextOffset = null;
let total = 0;
let activeRequest = 0;
let dbPromise = null;

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

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function sparql(query) {
  const data = await getJson(`${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`);
  return data.results.bindings;
}

function wikiId(uri) {
  return uri.split("/").pop();
}

function isQid(id) {
  return /^Q\d+$/.test(id);
}

// Liefert je QID Unternehmensstatus und Webseite; Ergebnisse werden im Browser gecacht.
async function findCompanies(qids) {
  const companies = new Map();
  const missing = [];
  for (const id of new Set(qids.filter(isQid))) {
    const entity = await cacheGet(`entity:${id}`);
    if (entity) companies.set(id, entity);
    else missing.push(id);
  }
  if (missing.length === 0) return companies;

  // Direkte Klassen (P31) sind schnell abfragbar; die Hierarchie wird nur für neue Klassen geprüft.
  // Website: direkt (P856), Muttergesellschaft (P749), Tochter (P355), Domain (P13337)
  // Company-Klasse: direkt (P31) oder über Muttergesellschaft (P749/P31)
  let bindings;
  try {
    bindings = await sparql(
      "SELECT ?item ?class ?parentClass ?website ?domain ?source WHERE { " +
        `VALUES ?item { ${missing.map((id) => `wd:${id}`).join(" ")} } ` +
        "?item wdt:P31 ?class . " +
        "OPTIONAL { ?item wdt:P749 ?parent . ?parent wdt:P31 ?parentClass . } " +
        "OPTIONAL { " +
        "  { ?item wdt:P856 ?website . BIND('direct' AS ?source) } " +
        "  UNION { ?item wdt:P749/wdt:P856 ?website . BIND('parent' AS ?source) } " +
        "  UNION { ?item wdt:P355/wdt:P856 ?website . BIND('subsidiary' AS ?source) } " +
        "  UNION { ?item wdt:P13337 ?domain . BIND('domain' AS ?source) } " +
        "} }"
    );
  } catch (err) {
    console.warn("Unternehmensprüfung fehlgeschlagen", err);
    return companies;
  }

  const itemClasses = new Map();
  const itemWebsites = new Map(); // id -> [{url, source}]
  for (const binding of bindings) {
    if (!binding.item) continue;
    const id = wikiId(binding.item.value);
    if (!itemClasses.has(id)) itemClasses.set(id, []);
    if (binding.class) itemClasses.get(id).push(wikiId(binding.class.value));
    if (binding.parentClass) itemClasses.get(id).push(wikiId(binding.parentClass.value));
    // Website aus P856
    const url = safeUrl(binding.website?.value);
    if (url) {
      const source = binding.source?.value ?? 'unknown';
      if (!itemWebsites.has(id)) itemWebsites.set(id, []);
      itemWebsites.get(id).push({ url, source });
    }
    // Website aus P13337 (domain name) konstruieren
    const domain = binding.domain?.value;
    if (domain && typeof domain === 'string' && domain.includes('.')) {
      const constructedUrl = 'https://' + domain.replace(/^https?:\/\//, '').split('/')[0];
      const validated = safeUrl(constructedUrl);
      if (validated) {
        if (!itemWebsites.has(id)) itemWebsites.set(id, []);
        // Prüfen ob schon vorhanden
        if (!itemWebsites.get(id).some(w => w.url === validated)) {
          itemWebsites.get(id).push({ url: validated, source: 'domain' });
        }
      }
    }
  }

  const flags = new Map();
  const unknown = [];
  for (const cls of new Set([...itemClasses.values()].flat())) {
    const known = await cacheGet(`class:${cls}`);
    if (known === undefined) unknown.push(cls);
    else flags.set(cls, known);
  }
  if (unknown.length > 0) {
    try {
      const rows = await sparql(
        "SELECT DISTINCT ?class WHERE { " +
          `VALUES ?class { ${unknown.map((id) => `wd:${id}`).join(" ")} } ` +
          `VALUES ?root { ${COMPANY_CLASSES.map((id) => `wd:${id}`).join(" ")} } ` +
          "?class wdt:P279* ?root . }"
      );
      const companyClasses = new Set(rows.filter((row) => row.class).map((row) => wikiId(row.class.value)));
      for (const cls of unknown) {
        const isCompany = companyClasses.has(cls);
        flags.set(cls, isCompany);
        await cachePut(`class:${cls}`, isCompany, CLASS_TTL);
      }
    } catch (err) {
      console.warn("Klassenprüfung fehlgeschlagen", err);
      return companies;
    }
  }

  for (const id of missing) {
    const isCompany = (itemClasses.get(id) ?? []).some((cls) => flags.get(cls) === true);
    // Beste Website wählen: direct > parent > subsidiary > domain, dann längste Domain (spezifischste)
    const sites = itemWebsites.get(id) ?? [];
    let website = null;
    if (sites.length > 0) {
      const sourceOrder = { direct: 0, parent: 1, subsidiary: 2, domain: 3, unknown: 4 };
      sites.sort((a, b) => (sourceOrder[a.source] ?? 4) - (sourceOrder[b.source] ?? 4) || b.url.length - a.url.length);
      website = sites[0].url;
    }
    const entity = { is_company: isCompany, website };
    await cachePut(`entity:${id}`, entity, ENTITY_TTL);
    companies.set(id, entity);
  }
  return companies;
}

async function wikiSearch(term, offset) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    origin: "*",
    generator: "search",
    gsrsearch: term,
    gsrnamespace: "0",
    gsrlimit: String(PAGE_SIZE),
    gsroffset: String(offset),
    prop: "extracts|pageprops|info",
    exintro: "1",
    explaintext: "1",
    exlimit: String(PAGE_SIZE),
    exchars: "400",
    ppprop: "wikibase_item",
    inprop: "url",
  });
  const data = await getJson(`${WIKI_API}?${params}`);
  if (data.error) throw new Error(data.error.info);

  return data.query?.pages ?? [];
}

// Holt Pageviews für eine Liste von PageIDs (letzte 30 Tage, Summe).
async function fetchPageviews(pageids) {
  if (pageids.length === 0) return new Map();
  const key = `views:${pageids.join(",")}`;
  const cached = await cacheGet(key);
  if (cached) return new Map(Object.entries(cached));

  const chunks = [];
  for (let i = 0; i < pageids.length; i += 50) {
    chunks.push(pageids.slice(i, i + 50));
  }

  const allViews = new Map();
  await Promise.all(chunks.map(async (chunk) => {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      origin: "*",
      pageids: chunk.join("|"),
      prop: "pageviews",
    });
    try {
      const data = await getJson(`${WIKI_API}?${params}`);
      for (const page of data.query?.pages ?? []) {
        const views = page.pageviews
          ? Object.values(page.pageviews).reduce((a, b) => a + (b || 0), 0)
          : 0;
        allViews.set(page.pageid, views);
      }
    } catch (err) {
      console.warn("Pageviews fehlgeschlagen", err);
    }
  }));

  await cachePut(key, Object.fromEntries(allViews), SEARCH_TTL);
  return allViews;
}

function normalize(text) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Niedriger ist besser: exakter Titel, Titel mit Zusatz, Titelanfang, alle Wörter, Teiltreffer.
function relevanceTier(title, query) {
  const q = normalize(query);
  const full = normalize(title);
  const base = normalize(title.replace(/\s*\([^()]*\)\s*$/, ""));
  if (full === q) return 0;
  if (base === q) return 1;
  if (base.startsWith(`${q} `)) return 2;
  const words = new Set(base.split(/[^\p{L}\p{N}]+/u));
  if (q.split(" ").every((word) => words.has(word))) return 3;
  if (full.includes(q)) return 4;
  return 5;
}

async function fetchResults(query) {
  const key = `ranked:${query}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  const pages = await wikiSearch(query, 0);
  if (pages.length === 0) return [];

  // Parallel: Company-Check + Pageviews
  const qids = pages.map((p) => p.pageprops?.wikibase_item).filter(Boolean);
  const pageids = pages.map((p) => p.pageid).filter(Boolean);
  const [companies, views] = await Promise.all([
    findCompanies(qids),
    fetchPageviews(pageids),
  ]);

  const ranked = pages
    .map((page) => {
      const company = companies.get(page.pageprops?.wikibase_item);
      const isCompany = company?.is_company === true;
      const viewCount = views.get(page.pageid) || 0;
      // URL bestimmen: Company → Firmenwebsite, sonst Wikipedia-URL
      const url = isCompany ? company.website : (page.fullurl ?? null);
      const hasExternalUrl = safeUrl(url) !== null;
      const hit = {
        title: page.title,
        description: page.extract || null,
        url,
        is_company: isCompany,
        views: viewCount,
      };
      const tier = relevanceTier(page.title, query);
      // Score: niedriger tier = besser, höhere views = besser
      // tier 0 (exakt) → 0, tier 1 → 1000, etc.
      // views: log10(views + 1) * POPULARITY_WEIGHT
      // Boost für externe Links (Firmenwebsite oder Wikipedia)
      const websiteBoost = hasExternalUrl ? WEBSITE_BOOST : 0;
      const popularity = Math.log10(viewCount + 1) * POPULARITY_WEIGHT;
      const score = tier * TIER_WEIGHT - popularity - websiteBoost;
      return { hit, score };
    })
    .sort((a, b) => a.score - b.score)
    .map(({ hit }) => hit);

  await cachePut(key, ranked, SEARCH_TTL);
  return ranked;
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

function renderHit(hit) {
  const url = safeUrl(hit.url);
  const linkAttrs = { target: "_blank", rel: "noopener noreferrer" };
  const li = el("li", "result");

  li.append(url
    ? el("a", "title", hit.title, { href: url, ...linkAttrs })
    : el("span", "title", hit.title));

  if (hit.is_company) li.append(el("span", "badge", "Unternehmen"));

  if (url) {
    li.append(el("cite", "url", url.replace(/^https?:\/\//, "")));
  } else if (hit.is_company) {
    li.append(el("span", "note", "Keine Webseite in Wikidata hinterlegt"));
  }

  if (hit.description) {
    const p = el("p", "description");
    if (url && hit.is_company) {
      p.append(el("a", null, hit.description, { href: url, ...linkAttrs }));
    } else {
      p.textContent = hit.description;
    }
    li.append(p);
  }
  return li;
}

async function runSearch(query, offset) {
  const request = ++activeRequest;
  const append = offset > 0;
  currentQuery = query;
  moreLink.hidden = true;
  if (query.length > MAX_QUERY_CHARS) {
    statusEl.textContent = "Fehler: Suchbegriff ist zu lang.";
    return;
  }
  statusEl.textContent = "Suche läuft …";

  try {
    const hits = await fetchResults(query);
    if (request !== activeRequest) return;

    if (!append) results.replaceChildren();
    results.append(...hits.slice(offset, offset + PAGE_SIZE).map(renderHit));
    total = hits.length;
    nextOffset = offset + PAGE_SIZE < hits.length ? offset + PAGE_SIZE : null;
    statusEl.textContent = total === 0 ? "Keine Ergebnisse gefunden." : `${total} Ergebnisse`;
    moreLink.hidden = nextOffset == null;
  } catch (err) {
    if (request === activeRequest) statusEl.textContent = `Fehler: ${err.message}`;
  }
}

function runFromUrl() {
  const query = (new URLSearchParams(location.search).get("q") || "").trim();
  input.value = query;
  if (query) {
    runSearch(query, 0);
  } else {
    results.replaceChildren();
    statusEl.textContent = "";
    moreLink.hidden = true;
  }
}

// Ab dieser Wortzahl (oder mit Fragezeichen) gilt die Eingabe als Satz und geht in den Chat.
const SENTENCE_MIN_WORDS = 4;

function isSentence(query) {
  return query.endsWith("?") || query.split(/\s+/).length >= SENTENCE_MIN_WORDS;
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
  if (isSentence(query)) {
    input.value = "";
    await openChatWith(query);
    return;
  }
  history.pushState(null, "", `/?q=${encodeURIComponent(query)}`);
  showView("search");
  runSearch(query, 0);
});

moreLink.addEventListener("click", (event) => {
  event.preventDefault();
  if (nextOffset != null) runSearch(currentQuery, nextOffset);
});

window.addEventListener("popstate", runFromUrl);

cacheCleanup();
initSettings();
initChat();
initViews();
runFromUrl();
restoreVault().then((restored) => {
  if (!restored) return;
  window.dispatchEvent(new Event("vault-changed"));
  // Nach dem Neuladen zur Chat-Ansicht zurückkehren, außer bei einer Suche in der URL.
  const hasQuery = new URLSearchParams(location.search).has("q");
  if (savedView() === "chat" && !hasQuery) showView("chat");
});
