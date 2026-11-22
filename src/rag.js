// Web- und Bildsuche mit Perplexity Sonar, direkt oder über OpenRouter.
const SEARCH_MAX_TOKENS = 1200;
const SOURCE_COUNT = 6;
const DESCRIPTION_MAX_CHARS = 320;
const TITLE_MAX_CHARS = 160;
const IMAGE_COUNT = 12;
const SEARCH_SYSTEM = [
  "Führe eine präzise Websuche aus. Verwende nur Quellen, die die Suchanfrage direkt beantworten oder direkt mit ihr zusammenhängen.",
  "Behandle die Anfrage wie eine Suchmaschine: Suche die Begriffe wörtlich und liefere Seiten, die genau diese Begriffe behandeln. Steht die Anfrage für ein Unternehmen oder eine Marke mit eigener Website, muss deren offizielle Website (z. B. google.com für „google“) das erste Ergebnis sein. Bei mehrdeutigen Begriffen liefere nicht nur Seiten eines einzigen Anbieters, sondern eine Mischung aus offizieller Seite und unabhängigen Seiten zum Begriff.",  `Ermittle bis zu ${SOURCE_COUNT} inhaltlich unterschiedliche, möglichst verlässliche Ergebnisse. Vermeide doppelte Seiten und breit verwandte Themen.`,  "Gib ausschließlich gültiges JSON zurück: {\"results\":[{\"title\":\"exakter Seitentitel\",\"url\":\"https://...\",\"description\":\"kurze deutsche Beschreibung\"}]}",
  "Die Beschreibung muss in ein bis zwei Sätzen konkret erklären, warum genau dieses Ergebnis zur Suchanfrage passt. Keine allgemeine Zusammenfassung der ganzen Suche.",
].join("\n");


// Bevorzugt Perplexity direkt; nutzt andernfalls den vorhandenen OpenRouter-Key.
export function pickPerplexity(providers) {
  const keyed = providers.filter((provider) => provider.apiKey);
  return keyed.find((provider) =>
    provider.id === "perplexity"
    || /api\.perplexity\.ai/.test(provider.baseUrl ?? "")
  ) ?? keyed.find((provider) =>
    provider.id === "openrouter"
    || /openrouter\.ai/.test(provider.baseUrl ?? "")
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

function isDirectPerplexity(baseUrl) {
  return /^https:\/\/api\.perplexity\.ai\/?$/.test(baseUrl ?? "");
}

function searchModel(baseUrl) {
  return isDirectPerplexity(baseUrl) ? "sonar" : "perplexity/sonar";
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
    const citation = annotation?.url_citation;
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
    response = await fetch(perplexityEndpoint(baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: searchModel(baseUrl),
        messages: [
          { role: "system", content: SEARCH_SYSTEM },
          { role: "user", content: query },
        ],
        max_tokens: SEARCH_MAX_TOKENS,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "web_results",
            schema: {
              type: "object",
              properties: {
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      url: { type: "string" },
                      description: { type: "string" },
                    },
                    required: ["title", "url", "description"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["results"],
              additionalProperties: false,
            },
          },
        },
        temperature: 0,
        stream: false,
      }),
    });
  } catch {
    throw new Error("Perplexity ist nicht erreichbar.");
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Perplexity antwortet mit HTTP ${response.status}: ${detail}`);
  }

  const data = await response.json();
  const message = data.choices?.[0]?.message ?? {};
  const answer = message.content ?? "";
  return { answer, citations: promoteOfficialSite(query, mergeCitations(message.annotations ?? [], answer)) };
}

function perplexityEndpoint(baseUrl) {
  if (isDirectPerplexity(baseUrl)) {
    return "/api/perplexity/chat/completions";
  }
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
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
  if (!provider?.apiKey) throw new Error("Kein API-Key für Perplexity oder OpenRouter.");
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

