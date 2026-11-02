import { el } from "/js/dom.js";
import { completeChat } from "/js/llm.js";
import { loadModels } from "/js/models.js";
import { retrieveSources } from "/js/rag.js";
import { openNewAgent, requireVault } from "/js/settings.js";
import { isUnlocked, vaultData } from "/js/vault.js";

const DIRECT_SYSTEM_PROMPT = "Du bist ein hilfreicher Assistent.";
const DRAFT_INSTRUCTIONS =
  'Antworte auf Deutsch aus deinem eigenen Wissen. Gib ausschließlich JSON zurück: {"answer": "<deine Antwort>", "confidence": <Zahl von 0 bis 1 für deine Sicherheit>}.';
const CHECK_INSTRUCTIONS =
  'Prüfe den Entwurf anhand der Wikipedia-Auszüge und korrigiere ihn bei Bedarf. Kennzeichne belegte Aussagen mit der Quellennummer, z. B. [1]. Gib ausschließlich JSON zurück: {"answer": "<Antwort auf Deutsch>", "uses_sources": <true, wenn die Auszüge die Antwort stützen oder korrigieren, sonst false>, "sources": [<verwendete Quellennummern>]}.';
// Unter diesem Wert prüft das LLM mit Wikipedia.
const CONFIDENCE_THRESHOLD = 0.45;
const DIRECT_TEMPERATURE = 0.7;
const DIRECT_MAX_TOKENS = 4000;
const HISTORY_MESSAGES = 20;

const sourcesPanel = document.getElementById("sources-panel");
const sourcesCount = document.getElementById("sources-count");
const messagesEl = document.getElementById("chat-messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const submitBtn = document.getElementById("chat-submit");
const newChatBtn = document.getElementById("new-chat-btn");

const MENTION = /(^|\s)@([^\s@]*)$/;

let history = [];
let busy = false;
let currentSources = [];
let firstMentionPick = null;
let mentionRun = 0;
// Gewähltes Ziel: { agentId } oder { providerId, model }; wird nur über das @-Menü gesetzt.
let target = null;

const mentionMenu = el("div", "mention-menu");
mentionMenu.hidden = true;
form.append(mentionMenu);

export function initChat() {
  newChatBtn.addEventListener("click", resetChat);
  input.addEventListener("input", () => {
    updateSubmit();
    updateMention();
  });
  input.addEventListener("blur", () => {
    mentionMenu.hidden = true;
  });
  input.addEventListener("keydown", (event) => {
    if (!mentionMenu.hidden) {
      if (event.key === "Escape") {
        event.preventDefault();
        mentionMenu.hidden = true;
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        firstMentionPick?.();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", onSubmit);
  window.addEventListener("vault-changed", dropStaleTarget);
  renderSources([]);
}

// Entfernt das Ziel, wenn Agent oder Provider inzwischen gelöscht wurden.
function dropStaleTarget() {
  if (!target) return;
  const data = isUnlocked() ? vaultData() : { providers: [], agents: [] };
  const exists = target.agentId
    ? data.agents.some((agent) => agent.id === target.agentId)
    : data.providers.some((provider) => provider.id === target.providerId);
  if (!exists) target = null;
  updateSubmit();
}

function updateSubmit() {
  submitBtn.disabled = busy || !input.value.trim();
}

// Agent ist nutzbar, wenn er einen eigenen Key oder einen Provider mit Key hat.
function usableAgents(data) {
  return data.agents.filter((agent) => agent.apiKey || data.providers.find((item) => item.id === agent.providerId)?.apiKey);
}

function updateMention() {
  const match = input.value.slice(0, input.selectionStart).match(MENTION);
  if (!match) {
    mentionMenu.hidden = true;
    return;
  }
  renderMentionMenu(match[2].toLowerCase());
}

async function renderMentionMenu(query) {
  const run = ++mentionRun;
  const data = isUnlocked() ? vaultData() : { providers: [], agents: [] };
  const keyed = data.providers.filter((provider) => provider.apiKey);
  const lists = await Promise.all(keyed.map((provider) => loadModels(provider)));
  if (run !== mentionRun || document.activeElement !== input) return;
  firstMentionPick = null;

  const modelCol = el("div", "mention-col");
  modelCol.append(el("h3", null, "Modelle"));
  keyed.forEach((provider, index) => {
    const models = lists[index];
    const matching = models.filter((model) => `${provider.name} ${model}`.toLowerCase().includes(query));
    const custom = !models.length && provider.name.toLowerCase().includes(query);
    if (!matching.length && !custom) return;
    modelCol.append(el("div", "mention-group", provider.name));
    for (const model of matching) addMentionItem(modelCol, model, () => pickModel(provider.id, model));
    if (custom) addMentionItem(modelCol, "Eigene Modell-ID …", () => pickCustomModel(provider.id));
  });
  if (!keyed.length) modelCol.append(el("p", "hint", "Kein API-Key hinterlegt. Bitte in den Einstellungen eintragen."));
  else if (!firstMentionPick) modelCol.append(el("p", "hint", "Keine passenden Modelle."));

  const agentCol = el("div", "mention-col");
  agentCol.append(el("h3", null, "Agenten"));
  const agents = usableAgents(data).filter((agent) => agent.name.toLowerCase().includes(query));
  for (const agent of agents) addMentionItem(agentCol, agent.name, () => pickAgent(agent.id));
  if (!agents.length) agentCol.append(el("p", "hint", "Keine passenden Agenten."));
  agentCol.append(makeMentionItem("＋ Neuer Agent …", () => {
    finishMention();
    openNewAgent();
  }));

  mentionMenu.replaceChildren(modelCol, agentCol);
  mentionMenu.hidden = false;
}

function makeMentionItem(label, pick) {
  const item = el("button", "mention-item", label, { type: "button" });
  // mousedown statt click, damit das Textfeld den Fokus behält.
  item.addEventListener("mousedown", (event) => {
    event.preventDefault();
    pick();
  });
  return item;
}

function addMentionItem(parent, label, pick) {
  parent.append(makeMentionItem(label, pick));
  firstMentionPick ??= pick;
}

function pickModel(providerId, model) {
  target = { providerId, model };
  finishMention();
}

function pickCustomModel(providerId) {
  const model = window.prompt("Modell-ID des Anbieters:")?.trim();
  if (model) pickModel(providerId, model);
  else finishMention();
}

function pickAgent(agentId) {
  target = { agentId };
  finishMention();
}

// Entfernt den @-Suchtext vor dem Cursor und aktualisiert die Oberfläche.
function finishMention() {
  const cursor = input.selectionStart;
  const before = input.value.slice(0, cursor).replace(/@[^\s@]*$/, "");
  input.value = before + input.value.slice(cursor);
  input.setSelectionRange(before.length, before.length);
  mentionMenu.hidden = true;
  updateSubmit();
  input.focus();
}

function resetChat() {
  history = [];
  messagesEl.replaceChildren();
  renderSources([]);
}

// Liefert Provider, Modell und Einstellungen; bei Agent aus dem Agenten, sonst aus dem Modell-Ziel.
function chatConfig() {
  const data = vaultData();
  const agent = target?.agentId ? data.agents.find((item) => item.id === target.agentId) ?? null : null;
  const providerId = agent ? agent.providerId : target?.providerId;
  const provider = data.providers.find((item) => item.id === providerId) ?? null;
  return {
    agent,
    provider,
    model: agent ? agent.model : target?.model,
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
  if (!target || (!config.provider && !config.agent)) {
    appendMessage("error", "Bitte mit @ ein Modell oder einen Agenten wählen.");
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
  const bubble = appendMessage("assistant", "Antwort wird aus eigenem Wissen erstellt …");

  const base = { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, temperature: config.temperature, maxTokens: config.maxTokens };
  try {
    const draft = parseReply(
      await completeChat({
        ...base,
        messages: [
          { role: "system", content: `${config.systemPrompt}\n\n${DRAFT_INSTRUCTIONS}` },
          ...history.slice(-HISTORY_MESSAGES),
          { role: "user", content: question },
        ],
      })
    );
    let answer = draft.answer || "";

    if (normalizeConfidence(draft.confidence) >= CONFIDENCE_THRESHOLD) {
      renderSources([], question, "Antwort aus eigenem Wissen, nicht über Wikipedia geprüft.");
    } else {
      bubble.textContent = "Wikipedia wird zur Prüfung abgefragt …";
      let sources = [];
      let context = "";
      let notice = "";
      try {
        ({ sources, context } = await retrieveSources(question));
      } catch (err) {
        notice = `Wikipedia nicht erreichbar (${err.message}).`;
      }
      if (context) {
        bubble.textContent = "Entwurf wird mit Wikipedia geprüft …";
        const check = parseReply(
          await completeChat({
            ...base,
            messages: [
              { role: "system", content: `${config.systemPrompt}\n\n${CHECK_INSTRUCTIONS}\n\nWikipedia-Auszüge:\n\n${context}` },
              { role: "user", content: `Frage: ${question}\n\nEntwurf: ${answer}` },
            ],
          })
        );
        answer = check.answer || answer;
        // Quellen nur, wenn das LLM das Signal gibt.
        const used = Array.isArray(check.sources) ? check.sources.map(String) : [];
        const shown = check.uses_sources ? sources.filter((source) => used.includes(String(source.n))) : [];
        const visible = check.uses_sources ? (shown.length ? shown : sources) : [];
        renderSources(visible, question, notice);
      } else {
        renderSources([], question, notice);
      }
    }

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

// Das LLM antwortet mit JSON; ohne lesbares JSON gilt der Text als Antwort ohne Prüfsignal.
function parseReply(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // Fällt auf den Rohtext zurück.
    }
  }
  return { answer: text.trim() };
}

// Sicherheit als Anteil zwischen 0 und 1; fehlende oder unlesbare Werte gelten als unsicher.
function normalizeConfidence(value) {
  let number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (number > 1) number /= 100;
  return Math.min(Math.max(number, 0), 1);
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
    parts.push(el("p", "sources-empty", question ? "Keine Quellen für diese Antwort." : "Noch keine Quellen."));
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
