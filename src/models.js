import { el } from "/js/dom.js";

const CUSTOM = "__custom__";

// Modell-IDs im Namensformat des jeweiligen Anbieters; eigene IDs gehen über „Anderes Modell …“.
export const MODEL_CATALOG = {
  openai: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o4-mini", "o3-mini"],
  mistral: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest", "codestral-latest", "ministral-8b-latest"],
  groq: [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "openai/gpt-oss-120b",
    "qwen/qwen3-32b",
    "meta-llama/llama-4-scout-17b-16e-instruct",
  ],
  openrouter: [
    "openai/gpt-4.1",
    "openai/gpt-4o-mini",
    "anthropic/claude-3.5-sonnet",
    "google/gemini-2.5-flash",
    "meta-llama/llama-3.3-70b-instruct",
    "mistralai/mistral-large",
  ],
};

export function bindModelSelect(select, customInput) {
  select.addEventListener("change", () => {
    customInput.hidden = select.value !== CUSTOM;
  });
}

export function fillModelSelect(select, customInput, providerId, model = "") {
  const models = MODEL_CATALOG[providerId] ?? [];
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
