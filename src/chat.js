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
// Gewähltes Ziel: { agentId } oder { providerId, model }; pro Tab gespeichert.
const TARGET_KEY = "opensearchy.chatTarget";
const RECENT_KEY = "opensearchy.recentTargets";
const RECENT_LIMIT = 5;
const chipsEl = document.getElementById("chat-chips");
let target = readJson(TARGET_KEY, null);

function readJson(key, fallback) {
  try {
    return JSON.parse(sessionStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function sameTarget(a, b) {
  return a?.agentId === b?.agentId && a?.providerId === b?.providerId && a?.model === b?.model;
}

function setTarget(next) {
  target = next;
  if (next) {
    sessionStorage.setItem(TARGET_KEY, JSON.stringify(next));
    const recent = readJson(RECENT_KEY, []).filter((item) => !sameTarget(item, next));
    sessionStorage.setItem(RECENT_KEY, JSON.stringify([next, ...recent].slice(0, RECENT_LIMIT)));
  } else {
    sessionStorage.removeItem(TARGET_KEY);
  }
  renderChips();
  updateSubmit();
}

// Anzeigename, der im Text als @Name erscheint.
function targetName(item) {
  if (!item || !isUnlocked()) return "";
  if (item.agentId) return vaultData().agents.find((agent) => agent.id === item.agentId)?.name ?? "";
  return item.model ?? "";
}

function targetExists(item) {
  const data = vaultData();
  if (item.agentId) return data.agents.some((agent) => agent.id === item.agentId);
  return data.providers.some((provider) => provider.id === item.providerId);
}

function renderChips() {
  const items = [];
  if (isUnlocked()) {
    const data = vaultData();
    for (const agent of usableAgents(data)) items.push({ item: { agentId: agent.id }, label: agent.name });
    for (const item of readJson(RECENT_KEY, [])) {
      if (!targetExists(item) || items.some((entry) => sameTarget(entry.item, item))) continue;
      items.push({ item, label: targetName(item) });
    }
    if (target && !items.some((entry) => sameTarget(entry.item, target)) && targetExists(target)) {
      items.unshift({ item: target, label: targetName(target) });
    }
  }
  chipsEl.hidden = items.length === 0;
  chipsEl.replaceChildren(
    ...items.map(({ item, label }) => {
      const chip = el("button", sameTarget(item, target) ? "chip active" : "chip", label, { type: "button" });
      chip.addEventListener("click", () => selectTarget(item));
      return chip;
    })
  );
}

// Wählt ein Ziel und setzt die @-Erwähnung in das Eingabefeld.
function selectTarget(item) {
  setTarget(item);
  insertMention(targetName(item));
  input.focus();
}

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
  renderChips();
}

// Entfernt das Ziel, wenn Agent oder Provider inzwischen gelöscht wurden.
function dropStaleTarget() {
  if (target && isUnlocked() && !targetExists(target)) {
    setTarget(null);
    return;
  }
  renderChips();
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
  const recent = readJson(RECENT_KEY, []).filter((item) => {
    if (!isUnlocked() || !item.providerId || !targetExists(item)) return false;
    const providerName = data.providers.find((provider) => provider.id === item.providerId)?.name ?? "";
    return `${providerName} ${item.model}`.toLowerCase().includes(query);
  });
  if (recent.length) {
    modelCol.append(el("div", "mention-group", "Zuletzt verwendet"));
    for (const item of recent) addMentionItem(modelCol, item.model, () => pickModel(item.providerId, item.model));
  }
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
  const usable = usableAgents(data);
  const recentAgents = readJson(RECENT_KEY, [])
    .filter((item) => item.agentId && isUnlocked() && targetExists(item))
    .map((item) => usable.find((agent) => agent.id === item.agentId))
    .filter((agent) => agent && agent.name.toLowerCase().includes(query));
  if (recentAgents.length) {
    agentCol.append(el("div", "mention-group", "Zuletzt verwendet"));
    for (const agent of recentAgents) addMentionItem(agentCol, agent.name, () => pickAgent(agent.id));
  }
  const agents = usable.filter((agent) => agent.name.toLowerCase().includes(query));
  if (agents.length) agentCol.append(el("div", "mention-group", "Alle Agenten"));
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
  setTarget({ providerId, model });
  finishMention(model);
}

function pickCustomModel(providerId) {
  const model = window.prompt("Modell-ID des Anbieters:")?.trim();
  if (model) pickModel(providerId, model);
  else finishMention();
}

function pickAgent(agentId) {
  setTarget({ agentId });
  finishMention(targetName({ agentId }));
}

// Ersetzt den @-Suchtext vor dem Cursor durch die gewählte Erwähnung (leer = entfernen).
function finishMention(name = "") {
  const cursor = input.selectionStart;
  const before = input.value.slice(0, cursor).replace(/@[^\s@]*$/, name ? `@${name} ` : "");
  input.value = before + input.value.slice(cursor);
  input.setSelectionRange(before.length, before.length);
  mentionMenu.hidden = true;
  updateSubmit();
  input.focus();
}

// Setzt die Erwähnung des Ziels an den Anfang des Eingabefelds, ohne eine vorherige zu duplizieren.
function insertMention(name) {
  if (!name) return;
  input.value = `@${name} ${input.value.replace(/^@\S*\s*/, "")}`;
  updateSubmit();
}

// Entfernt die Erwähnung des gewählten Ziels aus dem Fragetext.
function questionText() {
  const raw = input.value.trim();
  const name = targetName(target);
  return name ? raw.split(`@${name}`).join("").trim() : raw;
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
  const question = questionText();
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
