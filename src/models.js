import { el } from "/js/dom.js";

const CUSTOM = "__custom__";

// Modell-IDs im Namensformat des jeweiligen Anbieters; eigene IDs gehen über „Anderes Modell …“.
export const MODEL_CATALOG = {
  perplexity: [
    "sonar",
    "sonar-pro",
    "sonar-reasoning-pro",
    "sonar-deep-research",
  ],
  openai: [
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
  ],
  mistral: [
    "mistral-large-latest",
    "mistral-medium-latest",
    "mistral-small-latest",
    "codestral-latest",
    "devstral-2512",
    "ministral-8b-latest",
  ],
  groq: [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3-32b",
    "meta-llama/llama-4-scout-17b-16e-instruct",
  ],
  openrouter: [
    "openai/gpt-6.1-sol",
    "openai/gpt-5.6-sol",
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-opus-5.5",
    "anthropic/claude-haiku-5.5",
    "google/gemini-3.5-flash",
    "google/gemini-3.1-pro-preview",
    "x-ai/grok-4.7",
    "deepseek/deepseek-v4-pro",
    "qwen/qwen3.6-plus",
    "meta-llama/llama-4-maverick",
    "mistralai/mistral-large-2512",
  ],
};

export function bindModelSelect(select, customInput) {
  select.addEventListener("change", () => {
    customInput.hidden = select.value !== CUSTOM;
  });
}

export function fillModelSelect(select, customInput, providerId, model = "", models = MODEL_CATALOG[providerId] ?? []) {
  select.replaceChildren(
    ...models.map((name) => el("option", null, name, { value: name })),
    el("option", null, "Anderes Modell …", { value: CUSTOM })
  );
  if (models.includes(model)) select.value = model;
  else if (!model && models.length) select.value = models[0];
  else select.value = CUSTOM;
  customInput.value = select.value === CUSTOM ? model : "";
  customInput.hidden = select.value !== CUSTOM;
}

export function readModel(select, customInput) {
  return select.value === CUSTOM ? customInput.value.trim() : select.value;
}

// Keine Chat-Modelle: Embeddings, Audio, Bild, Moderation und Schutzmodelle.
const NON_CHAT_MODEL = /embed|whisper|tts|dall-e|image|audio|realtime|transcribe|speech|moderation|guard|ocr|rerank/i;

const modelCache = new Map();

// Modelle eines Providers live über GET {baseUrl}/models; bei Fehlern (z. B. CORS) der Katalog.
export async function loadModels(provider) {
  const key = `${provider.baseUrl}|${provider.apiKey ?? ""}`;
  if (!modelCache.has(key)) {
    const request = fetchModels(provider).catch(() => null);
    modelCache.set(key, request);
    if ((await request) === null) modelCache.delete(key);
  }
  return (await modelCache.get(key)) ?? MODEL_CATALOG[provider.id] ?? [];
}

async function fetchModels({ baseUrl, apiKey }) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { data } = await response.json();
  const ids = (data ?? []).map((model) => model.id).filter((id) => typeof id === "string" && !NON_CHAT_MODEL.test(id));
  if (!ids.length) throw new Error("Leere Modellliste");
  return [...new Set(ids)].sort();
}
