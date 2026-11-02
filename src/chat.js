import { el } from "/js/dom.js";
import { streamChat } from "/js/llm.js";
import { bindModelSelect, fillModelSelect, readModel } from "/js/models.js";
import { retrieveSources } from "/js/rag.js";
import { requireVault } from "/js/settings.js";
import { isUnlocked, saveVault, vaultData } from "/js/vault.js";

const GROUNDING_WITH_SOURCES =
  "Antworte auf Deutsch. Stütze dich auf die Wikipedia-Auszüge und kennzeichne Aussagen mit der Quellennummer, z. B. [1]. Wenn die Auszüge die Frage nicht beantworten, sag das ausdrücklich.";
const GROUNDING_WITHOUT_SOURCES =
  "Antworte auf Deutsch. Es liegen keine Wikipedia-Auszüge vor; weise darauf hin, dass die Antwort nicht belegt ist.";
const DIRECT_SYSTEM_PROMPT = "Du bist ein hilfreicher Assistent.";
const DIRECT_TEMPERATURE = 0.7;
const DIRECT_MAX_TOKENS = 4000;
const HISTORY_MESSAGES = 20;

const sourcesPanel = document.getElementById("sources-panel");
const sourcesCount = document.getElementById("sources-count");
const messagesEl = document.getElementById("chat-messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const submitBtn = document.getElementById("chat-submit");
const agentSelect = document.getElementById("agent-select");
const newChatBtn = document.getElementById("new-chat-btn");
const directBar = document.getElementById("chat-direct");
const providerSelect = document.getElementById("chat-provider");
const modelSelect = document.getElementById("chat-model");
const modelCustom = document.getElementById("chat-model-custom");

let history = [];
let busy = false;
let currentSources = [];

export function initChat() {
  newChatBtn.addEventListener("click", resetChat);
  window.addEventListener("view-changed", (event) => {
    if (event.detail === "chat") fillAgents();
  });
  agentSelect.addEventListener("change", updateSubmit);
  providerSelect.addEventListener("change", () => fillModelSelect(modelSelect, modelCustom, providerSelect.value, ""));
  bindModelSelect(modelSelect, modelCustom);
  input.addEventListener("input", updateSubmit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", onSubmit);
  window.addEventListener("vault-changed", fillAgents);
  renderSources([]);
  fillAgents();
}

function fillAgents() {
  const agents = isUnlocked() ? vaultData().agents : [];
  const previous = agentSelect.value;
  agentSelect.replaceChildren(
    el("option", null, "Direkt (ohne Agent)", { value: "" }),
    ...agents.map((agent) => el("option", null, agent.name, { value: agent.id }))
  );
  agentSelect.value = agents.some((agent) => agent.id === previous) ? previous : "";
  fillDirect();
  updateSubmit();
}

function fillDirect() {
  const providers = isUnlocked() ? vaultData().providers : [];
  const previousProvider = providerSelect.value;
  const previousModel = readModel(modelSelect, modelCustom);
  providerSelect.replaceChildren(...providers.map((provider) => el("option", null, provider.name, { value: provider.id })));
  if (providers.some((provider) => provider.id === previousProvider)) providerSelect.value = previousProvider;
  const sameProvider = providerSelect.value === previousProvider;
  fillModelSelect(modelSelect, modelCustom, providerSelect.value, sameProvider ? previousModel : "");
}

function updateSubmit() {
  directBar.hidden = Boolean(agentSelect.value);
  submitBtn.disabled = busy || !input.value.trim();
}

function resetChat() {
  history = [];
  messagesEl.replaceChildren();
  renderSources([]);
}

// Liefert Provider, Modell und Einstellungen; bei Agent aus dem Agenten, sonst aus der Direkt-Auswahl.
function chatConfig() {
  const data = vaultData();
  const agent = data.agents.find((item) => item.id === agentSelect.value) ?? null;
  const providerId = agent ? agent.providerId : providerSelect.value;
  const provider = data.providers.find((item) => item.id === providerId) ?? null;
  return {
    agent,
    provider,
    model: agent ? agent.model : readModel(modelSelect, modelCustom),
    baseUrl: agent?.baseUrl || provider?.baseUrl,
    apiKey: provider?.apiKey || agent?.apiKey,
    systemPrompt: agent ? agent.systemPrompt : DIRECT_SYSTEM_PROMPT,
    temperature: agent ? agent.temperature : DIRECT_TEMPERATURE,
    maxTokens: agent ? agent.maxTokens : DIRECT_MAX_TOKENS,
  };
}

async function onSubmit(event) {
  event.preventDefault();
  const question = input.value.trim();
  if (!question || busy) return;
  if (!isUnlocked() && !(await requireVault())) return;

  const config = chatConfig();
  if (!config.provider && !config.agent) {
    appendMessage("error", "Bitte zuerst einen Anbieter in den Einstellungen anlegen.");
    return;
  }
  if (!config.apiKey) {
    appendMessage("error", "Für diesen Anbieter fehlt der API-Key. Bitte in den Einstellungen eintragen.");
    return;
  }
  if (!config.model) {
    appendMessage("error", "Bitte ein Modell auswählen.");
    return;
  }
  if (!config.baseUrl) {
    appendMessage("error", "Dem Anbieter fehlt eine Base URL.");
    return;
  }

  busy = true;
  input.value = "";
  updateSubmit();
  appendMessage("user", question);
  const bubble = appendMessage("assistant", "…");

  try {
    let sources = [];
    let context = "";
    let notice = "";
    try {
      ({ sources, context } = await retrieveSources(question));
    } catch (err) {
      notice = `Wikipedia nicht erreichbar, Antwort ohne Quellen (${err.message}).`;
    }
    renderSources(sources, question, notice);

    let answer = "";
    bubble.textContent = "";
    await streamChat({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      messages: buildMessages(config.systemPrompt, question, context),
      onToken(token) {
        answer += token;
        bubble.textContent = answer;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      },
    });
    history.push({ role: "user", content: question }, { role: "assistant", content: answer });
    renderAnswer(bubble, answer || "(leere Antwort)");
  } catch (err) {
    bubble.className = "message error";
    bubble.textContent = `Fehler: ${err.message}`;
  } finally {
    busy = false;
    updateSubmit();
  }
}

function buildMessages(systemPrompt, question, context) {
  const system = [systemPrompt || DIRECT_SYSTEM_PROMPT, context ? GROUNDING_WITH_SOURCES : GROUNDING_WITHOUT_SOURCES];
  if (context) system.push(`Wikipedia-Auszüge:\n\n${context}`);
  return [
    { role: "system", content: system.join("\n\n") },
    ...history.slice(-HISTORY_MESSAGES),
    { role: "user", content: question },
  ];
}

function appendMessage(role, text) {
  const bubble = el("div", `message ${role}`, text);
  messagesEl.append(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

function renderAnswer(bubble, text) {
  bubble.replaceChildren();
  for (const part of text.split(/(\[\d+\])/)) {
    const number = part.match(/^\[(\d+)\]$/)?.[1];
    if (!number) {
      bubble.append(part);
      continue;
    }
    const source = currentSources.find((item) => String(item.n) === number);
    if (!source) {
      bubble.append(part);
      continue;
    }
    bubble.append(el("a", "cite", part, { href: sourceUrl(source), target: "_blank", rel: "noopener noreferrer", title: source.title }));
  }
}

function sourceUrl(source) {
  return source.url || `https://de.wikipedia.org/wiki/${encodeURIComponent(source.title.replace(/ /g, "_"))}`;
}

function renderSources(sources, question = "", notice = "") {
  currentSources = sources;
  const parts = [el("h2", null, "Quellen")];
  if (question) parts.push(el("p", "sources-query", `Frage: ${question}`));
  if (notice) parts.push(el("p", "hint", notice));
  if (sources.length) {
    const list = el("ol", "sources-list");
    for (const source of sources) list.append(sourceItem(source));
    parts.push(list);
  } else {
    parts.push(el("p", "sources-empty", question ? "Keine Wikipedia-Quellen gefunden." : "Noch keine Quellen."));
  }
  sourcesPanel.replaceChildren(...parts);
  sourcesCount.textContent = sources.length ? `(${sources.length})` : "";
}

function sourceItem(source) {
  const item = el("li", "source");
  item.id = `source-${source.n}`;
  const heading = el("div");
  heading.append(el("span", "source-number", `[${source.n}]`));
  heading.append(el("a", "source-title", source.title, { href: sourceUrl(source), target: "_blank", rel: "noopener noreferrer" }));
  item.append(heading);
  for (const passage of source.passages) item.append(el("p", "source-passage", passage.text));
  return item;
}
