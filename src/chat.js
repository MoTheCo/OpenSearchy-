import { el } from "/js/dom.js";
import { completeChat } from "/js/llm.js";
import { loadModels } from "/js/models.js";
import { pickPerplexity, retrieveSources } from "/js/rag.js";
import { confirmDialog, openNewAgent, requireVault } from "/js/settings.js";
import { isUnlocked, saveVault, vaultData } from "/js/vault.js";

const DIRECT_SYSTEM_PROMPT = "Du bist ein hilfreicher Assistent.";
const DRAFT_INSTRUCTIONS =
  'Antworte auf Deutsch aus deinem eigenen Wissen. Gib ausschließlich JSON zurück: {"answer": "<deine Antwort>", "confidence": <Zahl von 0 bis 1 für deine Sicherheit>}.';
// Ergänzung des Systemprompts, nur wenn der Nutzer nach Quellen fragt.
const KEYWORD_INSTRUCTIONS =
  'Der Nutzer möchte Quellen. Ergänze das JSON um "keywords": ein Array mit 2 bis 5 Suchbegriffen für die Websuche, abgeleitet aus dem gesamten Gespräch (Eigennamen und Fachbegriffe, ohne Fragewörter).';
// Wörter, die im Nutzertext die Quellensuche auslösen.
const SOURCE_TRIGGER = /quell|beleg|nachweis|\bsources?\b|\breferences?\b/i;
const MAX_KEYWORDS = 5;
const CHECK_INSTRUCTIONS =
  'Prüfe den Entwurf anhand der Quellenauszüge und korrigiere ihn bei Bedarf. Kennzeichne belegte Aussagen mit der Quellennummer, z. B. [1]. Gib ausschließlich JSON zurück: {"answer": "<Antwort auf Deutsch>", "uses_sources": <true, wenn die Auszüge die Antwort stützen oder korrigieren, sonst false>, "sources": [<verwendete Quellennummern>]}.';
// Unter diesem Wert prüft das LLM mit Quellen.
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
const chatWorkspace = document.getElementById("chat-workspace");
const historyList = document.getElementById("chat-history-list");
const chatTitle = document.getElementById("chat-title");
const openHistoryBtn = document.getElementById("open-history-btn");
const closeHistoryBtn = document.getElementById("close-history-btn");

const MENTION = /(^|\s)@([^\s@]*)$/;

const CHAT_KEY = "opensearchy.chat";
// Verlauf für das LLM, Anzeige-Einträge und letzter Quellenstand; liegen verschlüsselt im Vault und werden nach dem Entsperren geladen.
let history = [];
let transcript = [];
let sourcesState = null;
let archivedChats = [];
let activeChatId = null;
let historyOpen = true;
let chatLoaded = false;
let busy = false;
let currentSources = [];
let firstMentionPick = null;
let mentionRun = 0;
// Gewähltes Ziel: { agentId } oder { providerId, model }. Liegt zusammen mit den Chats verschlüsselt im Vault.
const TARGET_KEY = "opensearchy.chatTarget";
const RECENT_KEY = "opensearchy.recentTargets";
const RECENT_LIMIT = 5;
const chipsEl = document.getElementById("chat-chips");
let target = null;
let recentTargets = [];

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
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
    recentTargets = [next, ...recentTargets.filter((item) => !sameTarget(item, next))].slice(0, RECENT_LIMIT);
  }
  saveChat();
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
    for (const item of recentTargets) {
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
const historyMenu = el("div", "chat-history-menu");
historyMenu.hidden = true;
document.body.append(historyMenu);

export function initChat() {
  newChatBtn.addEventListener("click", resetChat);
  openHistoryBtn.addEventListener("click", () => setHistoryOpen(true));
  closeHistoryBtn.addEventListener("click", () => setHistoryOpen(false));
  document.addEventListener("click", closeHistoryMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeHistoryMenu();
  });
  window.addEventListener("resize", closeHistoryMenu);
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
  window.addEventListener("vault-changed", () => {
    dropStaleTarget();
    if (isUnlocked()) {
      if (!chatLoaded) loadChat();
    } else {
      clearLoadedChat();
    }
  });
  renderChips();
}

// Übergibt eine Frage von außen (z. B. aus der Suche) an den Chat und sendet sie.
export function sendQuestion(text) {
  input.value = text;
  updateSubmit();
  form.requestSubmit();
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
  const recent = recentTargets.filter((item) => {
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
  const recentAgents = recentTargets
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

function archiveCurrentChat() {
  if (transcript.length || history.length) {
    const firstQuestion = transcript.find((entry) => entry.role === "user")?.text ?? "Chat";
    const id = activeChatId ?? crypto.randomUUID();
    archivedChats = archivedChats.filter((chat) => chat.id !== id);
    archivedChats.unshift({
      id,
      createdAt: new Date().toISOString(),
      title: firstQuestion.slice(0, 80),
      history,
      transcript,
      sources: sourcesState,
    });
  }
}

function resetChat() {
  archiveCurrentChat();
  activeChatId = crypto.randomUUID();
  history = [];
  transcript = [];
  sourcesState = null;
  messagesEl.replaceChildren();
  renderSources([]);
  renderChatHistory();
  updateChatTitle();
  saveChat();
}

function saveChat() {
  if (!chatLoaded || !isUnlocked()) return;
  const data = vaultData();
  data.chat = { id: activeChatId, history, transcript, sources: sourcesState };
  data.chats = archivedChats;
  data.chatPreferences = { target, recent: recentTargets, historyOpen };
  saveVault().catch((err) => console.warn("Chat konnte nicht gespeichert werden", err));
}

function clearLoadedChat() {
  chatLoaded = false;
  history = [];
  transcript = [];
  sourcesState = null;
  archivedChats = [];
  activeChatId = null;
  target = null;
  recentTargets = [];
  messagesEl.replaceChildren();
  renderSources([]);
  renderChatHistory();
  updateChatTitle();
  renderChips();
}

// Lädt Verlauf, Archiv und zuletzt verwendetes Ziel aus dem entsperrten Vault.
// Alte Browserdaten werden genau einmal übernommen und anschließend entfernt.
function loadChat() {
  const data = vaultData();
  const legacyChat = readJson(CHAT_KEY, null);
  const legacyTarget = readJson(TARGET_KEY, null);
  const legacyRecent = readJson(RECENT_KEY, []);
  const saved = data.chat ?? legacyChat ?? {};
  archivedChats = Array.isArray(data.chats) ? data.chats : [];
  activeChatId = saved.id ?? crypto.randomUUID();
  history = saved.history ?? [];
  transcript = saved.transcript ?? [];
  sourcesState = saved.sources ?? null;
  currentSources = sourcesState?.sources ?? [];
  target = data.chatPreferences?.target ?? legacyTarget;
  recentTargets = Array.isArray(data.chatPreferences?.recent) ? data.chatPreferences.recent : legacyRecent;
  historyOpen = data.chatPreferences?.historyOpen !== false;
  chatLoaded = true;
  messagesEl.replaceChildren();
  restoreChat();
  setHistoryOpen(historyOpen, false);
  renderChatHistory();
  updateChatTitle();
  renderChips();
  if (legacyChat !== null || legacyTarget !== null || legacyRecent.length) {
    localStorage.removeItem(CHAT_KEY);
    localStorage.removeItem(TARGET_KEY);
    localStorage.removeItem(RECENT_KEY);
    saveChat();
  }
}

function setHistoryOpen(open, persist = true) {
  historyOpen = open;
  chatWorkspace.classList.toggle("history-closed", !open);
  if (persist) saveChat();
}

function updateChatTitle() {
  const question = transcript.find((entry) => entry.role === "user")?.text ?? "";
  chatTitle.textContent = question ? question.slice(0, 48) : "Chat";
}

function renderChatHistory() {
  historyList.replaceChildren();
  const visibleChats = [...archivedChats.filter((chat) => chat.id !== activeChatId)];
  if (transcript.length || history.length) {
    const question = transcript.find((entry) => entry.role === "user")?.text ?? "Chat";
    visibleChats.unshift({
      id: activeChatId,
      createdAt: new Date().toISOString(),
      title: question.slice(0, 80),
    });
  }
  if (!visibleChats.length) {
    historyList.append(el("p", "chat-history-empty", "Noch keine vergangenen Chats. Mit „＋“ wird der aktuelle Chat hier abgelegt."));
    return;
  }
  for (const chat of visibleChats) {
    const item = el("button", "chat-history-item", undefined, {
      type: "button",
      title: chat.title ?? "Chat öffnen",
    });
    item.append(el("span", "chat-history-item-title", chat.title ?? "Chat"));
    item.classList.toggle("active", chat.id === activeChatId);
    if (chat.createdAt) {
      const date = new Date(chat.createdAt);
      if (!Number.isNaN(date.valueOf())) {
        item.append(el("span", "chat-history-item-date", new Intl.DateTimeFormat("de", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(date)));
      }
    }
    item.addEventListener("click", () => openArchivedChat(chat.id));
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showHistoryMenu(event.clientX, event.clientY, chat);
    });
    historyList.append(item);
  }
}

function closeHistoryMenu() {
  historyMenu.hidden = true;
  historyMenu.replaceChildren();
}

function showHistoryMenu(x, y, chat) {
  closeHistoryMenu();
  const remove = el("button", "chat-history-menu-action", "Chat löschen", { type: "button" });
  remove.addEventListener("click", async () => {
    closeHistoryMenu();
    if (!(await confirmDialog(`„${chat.title ?? "Chat"}“ löschen?`))) return;
    archivedChats = archivedChats.filter((item) => item.id !== chat.id);
    if (activeChatId === chat.id) {
      activeChatId = crypto.randomUUID();
      history = [];
      transcript = [];
      sourcesState = null;
      currentSources = [];
      messagesEl.replaceChildren();
      renderSources([]);
      updateChatTitle();
    }
    renderChatHistory();
    saveChat();
  });
  historyMenu.append(remove);
  historyMenu.hidden = false;
  const left = Math.min(x, window.innerWidth - historyMenu.offsetWidth - 8);
  const top = Math.min(y, window.innerHeight - historyMenu.offsetHeight - 8);
  historyMenu.style.left = `${Math.max(8, left)}px`;
  historyMenu.style.top = `${Math.max(8, top)}px`;
}

function openArchivedChat(id) {
  if (id === activeChatId) return;
  const selected = archivedChats.find((chat) => chat.id === id);
  if (!selected) return;
  archiveCurrentChat();
  activeChatId = selected.id;
  history = selected.history ?? [];
  transcript = selected.transcript ?? [];
  sourcesState = selected.sources ?? null;
  currentSources = sourcesState?.sources ?? [];
  messagesEl.replaceChildren();
  restoreChat();
  renderChatHistory();
  updateChatTitle();
  saveChat();
  input.focus();
}

// Zeigt den gespeicherten Verlauf und die Quellen des letzten Stands.
function restoreChat() {
  renderSources(sourcesState?.sources ?? [], sourcesState?.question ?? "", sourcesState?.notice ?? "");
  for (const entry of transcript) {
    const bubble = appendMessage(entry.role, entry.text);
    if (entry.role === "assistant") renderAnswer(bubble, entry.text, entry.sources);
  }
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
  transcript.push({ role: "user", text: question });
  updateChatTitle();
  renderChatHistory();
  saveChat();
  const bubble = appendMessage("assistant", "Antwort wird aus eigenem Wissen erstellt …");

  const base = { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, temperature: config.temperature, maxTokens: config.maxTokens };
  const wantsSources = SOURCE_TRIGGER.test(question);
  try {
    const draft = parseReply(
      await completeChat({
        ...base,
        messages: [
          { role: "system", content: `${config.systemPrompt}\n\n${DRAFT_INSTRUCTIONS}${wantsSources ? `\n\n${KEYWORD_INSTRUCTIONS}` : ""}` },
          ...history.slice(-HISTORY_MESSAGES),
          { role: "user", content: question },
        ],
      })
    );
    let answer = draft.answer || "";

    if (!wantsSources && normalizeConfidence(draft.confidence) >= CONFIDENCE_THRESHOLD) {
      renderSources([], question, "Antwort aus eigenem Wissen, nicht über Quellen geprüft.");
    } else {
      // Mit Keywords des LLMs suchen; ohne Keywords dient die Frage als Suchtext.
      const query = (wantsSources && keywordQuery(draft.keywords)) || question;
      bubble.textContent = "Quellen werden gesucht …";
      let sources = [];
      let context = "";
      let notice = "";
      try {
        ({ sources, context } = await retrieveSources(query, pickPerplexity(vaultData().providers)));
      } catch (err) {
        notice = `Quellensuche fehlgeschlagen (${err.message}).`;
      }
      if (context) {
        bubble.textContent = "Entwurf wird mit Quellen geprüft …";
        const check = parseReply(
          await completeChat({
            ...base,
            messages: [
              { role: "system", content: `${config.systemPrompt}\n\n${CHECK_INSTRUCTIONS}\n\nQuellenauszüge:\n\n${context}` },
              { role: "user", content: `Frage: ${question}\n\nEntwurf: ${answer}` },
            ],
          })
        );
        answer = check.answer || answer;
        // Quellen erscheinen bei Signal des LLMs oder wenn der Nutzer sie ausdrücklich verlangt.
        const used = Array.isArray(check.sources) ? check.sources.map(String) : [];
        const shown = sources.filter((source) => used.includes(String(source.n)));
        const signal = wantsSources || check.uses_sources === true;
        renderSources(signal ? (shown.length ? shown : sources) : [], question, notice);
      } else {
        renderSources([], question, wantsSources && !notice ? "Keine passenden Quellen gefunden." : notice);
      }
    }

    history.push({ role: "user", content: question }, { role: "assistant", content: answer });
    const finalText = answer || "(leere Antwort)";
    transcript.push({ role: "assistant", text: finalText, sources: citationsOf(currentSources) });
    renderAnswer(bubble, finalText);
    saveChat();
  } catch (err) {
    const text = `Fehler: ${err.message}`;
    bubble.className = "message error";
    bubble.textContent = text;
    transcript.push({ role: "error", text });
    saveChat();
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

// Keywords des LLMs als Suchtext; leere oder ungültige Werte ergeben "".
function keywordQuery(keywords) {
  if (!Array.isArray(keywords)) return "";
  return keywords
    .map((keyword) => String(keyword).trim())
    .filter(Boolean)
    .slice(0, MAX_KEYWORDS)
    .join(" ");
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

function renderAnswer(bubble, text, sources = currentSources) {
  bubble.replaceChildren();
  for (const part of text.split(/(\[\d+\])/)) {
    const number = part.match(/^\[(\d+)\]$/)?.[1];
    if (!number) {
      bubble.append(part);
      continue;
    }
    const source = sources.find((item) => String(item.n) === number);
    if (!source) {
      bubble.append(part);
      continue;
    }
    bubble.append(el("a", "cite", part, { href: source.url, target: "_blank", rel: "noopener noreferrer", title: source.title }));
  }
}

// Nur die Felder, die für die Zitat-Links nötig sind.
function citationsOf(sources) {
  return sources.map(({ n, title, url }) => ({ n, title, url }));
}

function renderSources(sources, question = "", notice = "") {
  currentSources = sources;
  sourcesState = { sources, question, notice };
  saveChat();
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
  heading.append(el("a", "source-title", source.title, { href: source.url, target: "_blank", rel: "noopener noreferrer" }));
  item.append(heading);
  for (const passage of source.passages) item.append(el("p", "source-passage", passage.text));
  return item;
}
