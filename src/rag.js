// Websuche über das in OpenRouter enthaltene Web-Search-Tool.
const SEARCH_MAX_TOKENS = 500;
const SOURCE_COUNT = 6;
const DESCRIPTION_MAX_CHARS = 140;
const TITLE_MAX_CHARS = 160;
const IMAGE_COUNT = 12;
const SEARCH_SYSTEM = [
  "Führe eine präzise Websuche aus. Verwende nur Quellen, die die Suchanfrage direkt beantworten oder direkt mit ihr zusammenhängen.",
  "Behandle die Anfrage wie eine Suchmaschine: Suche die Begriffe wörtlich und liefere Seiten, die genau diese Begriffe behandeln. Steht die Anfrage für ein Unternehmen oder eine Marke mit eigener Website, muss deren offizielle Website (z. B. google.com für „google“) das erste Ergebnis sein. Bei mehrdeutigen Begriffen liefere nicht nur Seiten eines einzigen Anbieters, sondern eine Mischung aus offizieller Seite und unabhängigen Seiten zum Begriff.",  `Ermittle bis zu ${SOURCE_COUNT} inhaltlich unterschiedliche, möglichst verlässliche Ergebnisse. Vermeide doppelte Seiten und breit verwandte Themen.`,  "Gib ausschließlich gültiges JSON ohne Codeblock und ohne weiteren Text zurück: {\"results\":[{\"title\":\"exakter Seitentitel\",\"url\":\"https://...\",\"description\":\"kurze deutsche Beschreibung\"}]}",
  "Die Beschreibung ist ein einziger Satz mit höchstens 15 Wörtern und erklärt konkret, warum genau dieses Ergebnis zur Suchanfrage passt. Keine allgemeine Zusammenfassung der ganzen Suche.",
  "Kennzeichne den Namen der beschriebenen Organisation, Person oder Marke am Anfang der Beschreibung mit Markdown-Fettschrift, z. B. \"**SRH Holding**\".",
].join("\n");


export function pickOpenRouter(providers) {
  return providers.find((provider) =>
    provider.apiKey && (
    provider.id === "openrouter"
    || /openrouter\.ai/.test(provider.baseUrl ?? "")
    )
  ) ?? null;
}

export function pickBrave(providers) {
  return providers.find((provider) =>
    provider.apiKey && (
      provider.id === "brave-search"
      || /api\.search\.brave\.com/.test(provider.baseUrl ?? "")
    )
  ) ?? null;
}

function validUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function resultKey(value) {
  const url = validUrl(value);
  if (!url) return "";
  url.hash = "";
  url.search = "";
  return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`.toLowerCase();
}

// Bei einem einzelnen Begriff wie „google“ steht die Seite <begriff>.com (google.com) immer ganz oben.
function promoteOfficialSite(query, citations) {
  const term = query.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(term)) return citations;
  const official = `${term}.com`;
  const isOfficial = (citation) => validUrl(citation.url)?.hostname.replace(/^www\./, "") === official;
  return [...citations.filter(isOfficial), ...citations.filter((citation) => !isOfficial(citation))];
}

function cleanText(value, maxLength = DESCRIPTION_MAX_CHARS) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const shortened = text.slice(0, maxLength - 1);
  const boundary = shortened.lastIndexOf(" ");
  return `${shortened.slice(0, boundary > maxLength * 0.7 ? boundary : shortened.length).trimEnd()}…`;
}

// Die strukturierte Antwort des Modells ist die maßgebliche Trefferliste mit Titel und Beschreibung.
function parseStructuredResults(content) {
  if (typeof content !== "string") return [];
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    const entries = Array.isArray(parsed) ? parsed : parsed.results;
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => ({
        title: cleanText(entry?.title, TITLE_MAX_CHARS),
        url: validUrl(entry?.url)?.href ?? "",
        description: cleanText(entry?.description),
      }))
      .filter((entry) => entry.url);
  } catch {
    return [];
  }
}

// Annotationen (url_citation) je Ergebnis-Schlüssel; dienen als Ersatz für fehlende Titel oder Beschreibungen.
function annotationResults(annotations) {
  const results = new Map();
  for (const annotation of annotations) {
    const citation = annotation?.url_citation ?? (
      annotation?.type === "url_citation" ? annotation : null
    );
    const url = validUrl(citation?.url)?.href;
    const key = resultKey(url);
    if (annotation?.type !== "url_citation" || !key || results.has(key)) continue;
    results.set(key, {
      title: cleanText(citation.title, TITLE_MAX_CHARS),
      url,
      description: cleanText(citation.content),
    });
  }
  return results;
}

function mergeCitations(annotations, content) {
  const fromAnnotations = annotationResults(annotations);
  const structured = parseStructuredResults(content);
  const entries = structured.length ? structured : [...fromAnnotations.values()];
  const seen = new Set();
  const citations = [];
  for (const entry of entries) {
    const key = resultKey(entry.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const fallback = fromAnnotations.get(key);
    citations.push({
      title: entry.title || fallback?.title || entry.url,
      url: entry.url,
      content: entry.description || fallback?.description || "",
    });
    if (citations.length >= SOURCE_COUNT) break;
  }
  return citations;
}

// Liefert eindeutige, präzise Web-Treffer mit kurzen Beschreibungen.
export async function searchWeb({ baseUrl, apiKey, query }) {
  let response;
  try {
    response = await fetch(openRouterResponsesEndpoint(baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "google/gemini-3.5-flash",
        instructions: SEARCH_SYSTEM,
        input: query,
        tools: [{
          type: "openrouter:web_search",
          parameters: {
            engine: "exa",
            mode: "instant",
            max_results: SOURCE_COUNT,
            max_total_results: SOURCE_COUNT,
            max_characters: 500,
          },
        }],
        max_tool_calls: 1,
        max_output_tokens: SEARCH_MAX_TOKENS,
        temperature: 0,
      }),
    });
  } catch {
    throw new Error("OpenRouter ist nicht erreichbar.");
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`OpenRouter antwortet mit HTTP ${response.status}: ${detail}`);
  }

  const { answer, annotations } = parseResponsesResult(await response.json());
  return { answer, citations: promoteOfficialSite(query, mergeCitations(annotations, answer)) };
}

export async function searchWebBrave({ apiKey, query }) {
  const url = `/api/search/brave?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Brave Search antwortet mit HTTP ${response.status}: ${detail}`);
  }
  const data = await response.json();
  const citations = (data?.web?.results ?? [])
    .map((entry) => ({
      title: cleanText(entry?.title, TITLE_MAX_CHARS),
      url: validUrl(entry?.url)?.href ?? "",
      content: cleanText(entry?.description),
    }))
    .filter((entry) => entry.url)
    .slice(0, SOURCE_COUNT);
  return { answer: "", citations: promoteOfficialSite(query, citations) };
}

const PLACES_COUNT = 6;
const PLACES_SYSTEM = [
  "Du bist eine Ortssuche für medizinische Einrichtungen (Ärzte, Praxen, Zahnärzte, Kliniken, Krankenhäuser, Apotheken, Therapeuten).",
  `Liefere bis zu ${PLACES_COUNT} real existierende Einrichtungen, die zur Anfrage passen, und nur solche mit vollständiger, verifizierbarer Straßenadresse. Erfinde nichts.`,
  "Gib ausschließlich gültiges JSON ohne Codeblock und ohne weiteren Text zurück: {\"places\":[{\"name\":\"Name der Einrichtung\",\"address\":\"Straße Hausnummer, PLZ Ort\",\"website\":\"https://... oder leer\",\"type\":\"z. B. Zahnarzt, Klinik, Apotheke\"}]}",
].join("\n");

// Medizinische Orte über OpenRouter; die Adressen werden anschließend geokodiert.
export async function searchPlaces({ baseUrl, apiKey, query }) {
  let response;
  try {
    response = await fetch(openRouterResponsesEndpoint(baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "google/gemini-3.5-flash",
        instructions: PLACES_SYSTEM,
        input: query,
        tools: [{
          type: "openrouter:web_search",
          parameters: {
            engine: "exa",
            mode: "instant",
            max_results: PLACES_COUNT,
            max_total_results: PLACES_COUNT,
            max_characters: 500,
          },
        }],
        max_tool_calls: 1,
        max_output_tokens: SEARCH_MAX_TOKENS,
        temperature: 0,
      }),
    });
  } catch {
    throw new Error("OpenRouter ist nicht erreichbar.");
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`OpenRouter antwortet mit HTTP ${response.status}: ${detail}`);
  }

  const { answer: content } = parseResponsesResult(await response.json());
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    return (Array.isArray(parsed.places) ? parsed.places : [])
      .map((entry) => ({
        name: cleanText(entry?.name, TITLE_MAX_CHARS),
        address: cleanText(entry?.address, TITLE_MAX_CHARS),
        website: validUrl(entry?.website)?.href ?? "",
        type: cleanText(entry?.type, 60),
      }))
      .filter((entry) => entry.name && entry.address)
      .slice(0, PLACES_COUNT);
  } catch {
    return [];
  }
}

function openRouterResponsesEndpoint(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

function parseResponsesResult(data) {
  const output = Array.isArray(data?.output) ? data.output : [];
  const parts = output
    .filter((item) => item?.type === "message")
    .flatMap((item) => Array.isArray(item.content) ? item.content : []);
  return {
    answer: parts
      .filter((part) => part?.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n"),
    annotations: parts.flatMap((part) => Array.isArray(part.annotations) ? part.annotations : []),
  };
}

function imageHit(imageUrl, pageUrl, title, query) {
  const image = validUrl(imageUrl)?.href;
  const page = validUrl(pageUrl)?.href ?? image;
  if (!image || !page) return null;
  return {
    title: cleanText(title, TITLE_MAX_CHARS) || query,
    pageUrl: page,
    imageUrl: image,
  };
}

function parseBraveImages(data, query) {
  return (data.results ?? [])
    .map((item) => imageHit(
      item.properties?.url ?? item.thumbnail?.src,
      item.url ?? item.properties?.url,
      item.title,
      query
    ))
    .filter(Boolean);
}

function parseOpenverseImages(data, query) {
  return (data.results ?? [])
    .map((item) => imageHit(
      item.thumbnail ?? item.url,
      item.foreign_landing_url,
      item.title,
      query
    ))
    .filter(Boolean);
}

function parseWikimediaImages(data, query) {
  return (data.query?.pages ?? [])
    .map((page) => {
      const info = page.imageinfo?.[0] ?? {};
      return imageHit(
        info.thumburl ?? info.url,
        info.descriptionurl ?? info.url,
        page.title?.replace(/^File:/, ""),
        query
      );
    })
    .filter(Boolean);
}

async function fetchImageProvider(endpoint, name, query, headers = {}) {
  let response;
  try {
    response = await fetch(`${endpoint}?q=${encodeURIComponent(query)}`, { headers });
  } catch {
    throw new Error(`${name} ist nicht erreichbar.`);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`${name} antwortet mit HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response.json();
}

export async function searchImages({ braveApiKey = "", query }) {
  const seen = new Set();
  const images = [];
  const providers = [];
  const failures = [];
  const append = (entries, provider) => {
    for (const entry of entries) {
      const key = resultKey(entry.imageUrl);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      images.push(entry);
      if (images.length >= IMAGE_COUNT) break;
    }
    if (images.some((entry) => entries.includes(entry))) providers.push(provider);
  };

  const searches = [];
  if (braveApiKey) {
    searches.push({
      name: "Brave",
      run: () => fetchImageProvider(
        "/api/images/brave",
        "Brave",
        query,
        { Authorization: `Bearer ${braveApiKey}` }
      ),
      parse: parseBraveImages,
    });
  }
  searches.push(
    {
      name: "Openverse",
      run: () => fetchImageProvider("/api/images/openverse", "Openverse", query),
      parse: parseOpenverseImages,
    },
    {
      name: "Wikimedia Commons",
      run: () => fetchImageProvider("/api/images/wikimedia", "Wikimedia Commons", query),
      parse: parseWikimediaImages,
    }
  );

  for (const search of searches) {
    if (images.length >= IMAGE_COUNT) break;
    try {
      const parsed = search.parse(await search.run(), query);
      append(parsed, search.name);
    } catch (err) {
      failures.push(err.message);
      console.warn(`Bildanbieter ${search.name} fehlgeschlagen:`, err);
    }
  }

  if (!images.length) {
    throw new Error(failures.length ? failures.join(" ") : "Keine Bildanbieter sind verfügbar.");
  }
  if (failures.length) console.warn("Bildersuche nutzte Fallbacks:", failures);
  return { images, providers };
}

// Quellen für den Chat: jeder Web-Treffer ist eine nummerierte Quelle mit seinem Ausschnitt.
export async function retrieveSources(question, provider) {
  if (!provider?.apiKey) throw new Error("Kein API-Key für OpenRouter.");
  const { citations } = await searchWeb({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, query: question });
  const sources = citations.slice(0, SOURCE_COUNT).map((citation, index) => ({
    n: index + 1,
    title: citation.title,
    url: citation.url,
    passages: citation.content ? [{ section: "", text: citation.content }] : [],
  }));
  const context = sources
    .map((source) => `[${source.n}] ${source.title}\n${source.passages.map((passage) => passage.text).join("\n")}`)
    .join("\n\n");
  return { sources, context };
}

