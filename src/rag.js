const WIKI_API = "https://de.wikipedia.org/w/api.php";
const SOURCE_COUNT = 6;
const SEARCH_LIMIT = 5;
const MAX_TERMS = 6;
const CONTEXT_CHARS = 12000;
const CHUNK_CHARS = 700;
const CHUNKS_PER_SOURCE = 4;
const MIN_PARAGRAPH_CHARS = 40;
const LEAD_BONUS = 1;
const STOPWORDS = new Set([
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "eines",
  "und", "oder", "aber", "ist", "sind", "war", "waren", "wird", "werden", "wurde", "wurden",
  "hat", "haben", "hatte", "hatten", "bin", "bist", "sein", "seine", "seiner", "seinem", "seinen",
  "ihr", "ihre", "ihrer", "ihren", "ihm", "ihn", "was", "wie", "wer", "wen", "wem", "wo",
  "wann", "warum", "wieso", "weshalb", "welche", "welcher", "welches", "welchen", "welchem",
  "von", "zu", "im", "in", "am", "auf", "mit", "für", "über", "bei", "nach", "aus", "an",
  "es", "sich", "auch", "nicht", "gibt", "kann", "können", "alt", "viel", "viele", "dass",
  "dies", "diese", "dieser", "dieses", "er", "sie", "wir", "ich", "du", "man", "mehr", "noch",
  "schon", "sehr", "nur", "also", "dazu", "da", "durch", "gegen", "ohne", "unter", "zwischen",
  "bis", "um", "als", "wenn", "stellt", "stellen", "her", "heißt", "heisst", "gab", "gibt",
]);

function tokens(text) {
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Suchbegriffe ohne Fragewörter; Duplikate entfallen.
function contentTerms(question) {
  const terms = [];
  for (const token of tokens(question)) {
    const word = token.toLowerCase();
    if (word.length < 3 || STOPWORDS.has(word) || terms.includes(word)) continue;
    terms.push(word);
  }
  return terms;
}

// Zusammenhängende großgeschriebene Wörter wie "Albert Einstein" oder "Siemens".
function entityPhrases(question) {
  const phrases = [];
  let current = [];
  for (const token of tokens(question)) {
    const capitalized = /^\p{Lu}/u.test(token) && !STOPWORDS.has(token.toLowerCase());
    if (capitalized) {
      current.push(token);
      continue;
    }
    if (current.length) phrases.push(current.join(" "));
    current = [];
  }
  if (current.length) phrases.push(current.join(" "));
  return [...new Set(phrases)];
}

function planSearches(question) {
  const phrases = entityPhrases(question);
  const terms = contentTerms(question).slice(0, MAX_TERMS);
  const primary = phrases.map((term) => ({ term, weight: 3 }));
  if (terms.length) primary.push({ term: terms.slice(0, 4).join(" "), weight: 2 });
  if (primary.length === 0) primary.push({ term: question, weight: 1 });
  const secondary = terms.map((term) => ({ term, weight: 1 }));
  return { phrases, terms, primary, secondary };
}

// Begrenzt parallele Anfragen, damit Wikipedia keine 429-Fehler liefert.
async function mapLimit(items, limit, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    results.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return results;
}

// Wiederholt Anfragen bei 429 oder "too busy" mit wachsender Wartezeit.
async function apiGet(params, attempt = 0) {
  const query = new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...params });
  const response = await fetch(`${WIKI_API}?${query}`);
  const data = response.ok ? await response.json() : null;
  const busy = response.status === 429 || data?.error?.code === "ratelimited" || /too busy/i.test(data?.error?.info ?? "");
  if (busy && attempt < 3) {
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    return apiGet(params, attempt + 1);
  }
  if (!response.ok) throw new Error(`Wikipedia HTTP ${response.status}`);
  if (data.error) throw new Error(data.error.info);
  return data;
}

async function searchTitles(term) {
  const data = await apiGet({
    action: "query",
    list: "search",
    srsearch: term,
    srnamespace: "0",
    srlimit: String(SEARCH_LIMIT),
  });
  return (data.query?.search ?? []).map((hit) => hit.title);
}

// Exakte Titel (ohne Weiterleitung) gelten als sehr starker Treffer.
async function exactTitles(phrases) {
  if (phrases.length === 0) return [];
  const data = await apiGet({ action: "query", titles: phrases.join("|") });
  return (data.query?.pages ?? []).filter((page) => !page.missing).map((page) => page.title);
}

// Vollständiger Artikeltext; Begriffsklärungsseiten werden übersprungen.
async function fetchArticle(title) {
  const data = await apiGet({
    action: "query",
    titles: title,
    redirects: "1",
    prop: "extracts|pageprops|info",
    explaintext: "1",
    exsectionformat: "plain",
    inprop: "url",
  });
  const page = data.query?.pages?.[0];
  if (!page || page.missing || "disambiguation" in (page.pageprops ?? {})) return null;
  return { title: page.title, url: page.fullurl ?? null, text: page.extract ?? "" };
}

// Zerlegt den Text in Abschnitte mit Überschrift; Überschriften sind kurze Zeilen ohne Satzzeichen am Ende.
function chunkArticle(text) {
  const chunks = [];
  let section = "";
  let buffer = [];
  let size = 0;
  const flush = () => {
    if (buffer.length === 0) return;
    chunks.push({ section, text: buffer.join("\n") });
    buffer = [];
    size = 0;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length < 80 && !/[.!?:;)"»]$/.test(line)) {
      flush();
      section = line;
      continue;
    }
    if (line.length < MIN_PARAGRAPH_CHARS) continue;
    buffer.push(line);
    size += line.length;
    if (size >= CHUNK_CHARS) flush();
  }
  flush();
  return chunks;
}

function scoreChunk(text, phrases, stems) {
  const lower = text.toLowerCase();
  const stemHits = stems.filter((stem) => lower.includes(stem)).length;
  const phraseHits = phrases.filter((phrase) => lower.includes(phrase)).length;
  return stemHits + 2 * phraseHits;
}

// Einleitung jedes Artikels immer dabei; danach die besten Abschnitte im Zeichenbudget.
function selectPassages(articles, phrases, stems) {
  const leads = [];
  const others = [];
  articles.forEach((article, source) => {
    chunkArticle(article.text).forEach((chunk, order) => {
      const entry = {
        source,
        order,
        section: chunk.section,
        text: chunk.text,
        score: scoreChunk(chunk.text, phrases, stems) + (order === 0 ? LEAD_BONUS : 0),
      };
      if (order === 0) leads.push(entry);
      else if (entry.score > 0) others.push(entry);
    });
  });

  let budget = CONTEXT_CHARS;
  const selected = [];
  const take = (entry) => {
    if (entry.text.length > budget) return false;
    budget -= entry.text.length;
    selected.push(entry);
    return true;
  };
  leads.forEach(take);

  others.sort((a, b) => b.score - a.score || a.source - b.source || a.order - b.order);
  const perSource = new Map();
  for (const entry of others) {
    const count = perSource.get(entry.source) ?? 0;
    if (count >= CHUNKS_PER_SOURCE) continue;
    if (take(entry)) perSource.set(entry.source, count + 1);
  }
  return selected.sort((a, b) => a.source - b.source || a.order - b.order);
}

export async function retrieveSources(question) {
  const { phrases, terms, primary, secondary } = planSearches(question);
  const scores = new Map();
  const add = (title, points) => scores.set(title, (scores.get(title) ?? 0) + points);
  const addLists = (lists) => {
    for (const { titles, weight } of lists) {
      titles.forEach((title, rank) => add(title, weight * (SEARCH_LIMIT - rank)));
    }
  };

  const runSearch = async ({ term, weight }) => ({ titles: await searchTitles(term), weight });
  addLists(await mapLimit(primary, 2, runSearch));
  for (const title of await exactTitles(phrases)) add(title, 100);
  if (scores.size < SOURCE_COUNT + 4) addLists(await mapLimit(secondary, 2, runSearch));

  const stems = terms.map((term) => term.slice(0, 5));
  for (const title of [...scores.keys()]) {
    const lower = title.toLowerCase();
    if (stems.some((stem) => lower.includes(stem))) add(title, 25);
  }

  const ranked = [...scores]
    .sort((a, b) => b[1] - a[1])
    .map(([title]) => title)
    .slice(0, SOURCE_COUNT + 4);
  const articles = (await mapLimit(ranked, 2, fetchArticle))
    .filter(Boolean)
    .slice(0, SOURCE_COUNT);
  if (articles.length === 0) return { sources: [], context: "" };

  const selected = selectPassages(articles, phrases.map((phrase) => phrase.toLowerCase()), stems);
  const sources = articles.map((article) => ({ title: article.title, url: article.url, passages: [] }));
  for (const entry of selected) {
    sources[entry.source].passages.push({ section: entry.section, text: entry.text });
  }

  const usable = sources
    .filter((source) => source.passages.length > 0)
    .map((source, index) => ({ ...source, n: index + 1 }));
  const context = usable
    .map((source) => {
      const passages = source.passages
        .map((passage) => (passage.section ? `${passage.section}: ${passage.text}` : passage.text))
        .join("\n\n");
      return `[${source.n}] ${source.title}\n${passages}`;
    })
    .join("\n\n");
  return { sources: usable, context };
}

