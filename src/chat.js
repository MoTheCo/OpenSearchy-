import { el } from "/js/dom.js";
import { streamChat } from "/js/llm.js";
import { retrieveSources } from "/js/rag.js";
import { requireVault } from "/js/settings.js";
import { isUnlocked, saveVault, vaultData } from "/js/vault.js";

const GROUNDING_WITH_SOURCES =
  "Antworte auf Deutsch. Stütze dich auf die Wikipedia-Auszüge und kennzeichne Aussagen mit der Quellennummer, z. B. [1]. Wenn die Auszüge die Frage nicht beantworten, sag das ausdrücklich.";
const GROUNDING_WITHOUT_SOURCES =
  "Antworte auf Deutsch. Es liegen keine Wikipedia-Auszüge vor; weise darauf hin, dass die Antwort nicht belegt ist.";
const HISTORY_MESSAGES = 20;

const sourcesPanel = document.getElementById("sources-panel");
const sourcesCount = document.getElementById("sources-count");
const messagesEl = document.getElementById("chat-messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const submitBtn = document.getElementById("chat-submit");
const agentSelect = document.getElementById("agent-select");
const newChatBtn = document.getElementById("new-chat-btn");
const keyForm = document.getElementById("chat-key-form");
const keyInput = document.getElementById("chat-key-input");

let history = [];
let busy = false;

export function initChat() {
  newChatBtn.addEventListener("click", resetChat);
  window.addEventListener("view-changed", (event) => {
    if (event.detail === "chat") fillAgents();
  });
  agentSelect.addEventListener("change", updateSubmit);
  input.addEventListener("input", updateSubmit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", onSubmit);
  keyForm.addEventListener("submit", onKeySubmit);
  window.addEventListener("vault-changed", fillAgents);
  renderSources([]);
}

function fillAgents() {
  const agents = isUnlocked() ? vaultData().agents : [];
  const previous = agentSelect.value;
  if (agents.length) {
    agentSelect.replaceChildren(...agents.map((agent) => el("option", null, agent.name, { value: agent.id })));
    if (agents.some((agent) => agent.id === previous)) agentSelect.value = previous;
  } else {
    agentSelect.replaceChildren(el("option", null, "Kein Agent angelegt", { value: "" }));
  }
  updateSubmit();
}

function selectedAgent() {
  if (!isUnlocked()) return null;
  return vaultData().agents.find((agent) => agent.id === agentSelect.value) ?? null;
}

function updateSubmit() {
  updateKeyForm();
  submitBtn.disabled = busy || !input.value.trim() || !agentSelect.value;
}

function updateKeyForm() {
  const agent = selectedAgent();
  keyForm.hidden = !agent || Boolean(agent.apiKey);
}

async function onKeySubmit(event) {
  event.preventDefault();
  const agent = selectedAgent();
  const apiKey = keyInput.value.trim();
  if (!agent || !apiKey) return;
  agent.apiKey = apiKey;
  keyInput.value = "";
  await saveVault();
  updateSubmit();
}

function resetChat() {
  history = [];
  messagesEl.replaceChildren();
  renderSources([]);
}

async function onSubmit(event) {
  event.preventDefault();
  const question = input.value.trim();
  if (!question || busy) return;
  if (!isUnlocked() && !(await requireVault())) return;

  const agent = selectedAgent();
  if (!agent) {
    appendMessage("error", "Bitte zuerst einen Agenten in den Einstellungen anlegen.");
    return;
  }
  if (!agent.apiKey) {
    appendMessage("error", "Für diesen Agenten fehlt der API-Key. Bitte oben eintragen.");
    updateKeyForm();
    return;
  }
  const provider = vaultData().providers.find((item) => item.id === agent.providerId);
  const baseUrl = agent.baseUrl || provider?.baseUrl;
  if (!baseUrl) {
    appendMessage("error", "Dem Agenten fehlt eine Base URL.");
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
      baseUrl,
      apiKey: agent.apiKey,
      model: agent.model,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      messages: buildMessages(agent, question, context),
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

function buildMessages(agent, question, context) {
  const system = [agent.systemPrompt || "Du bist ein hilfreicher Assistent.", context ? GROUNDING_WITH_SOURCES : GROUNDING_WITHOUT_SOURCES];
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
    const cite = el("button", "cite", part, { type: "button" });
    cite.addEventListener("click", () => highlightSource(number));
    bubble.append(cite);
  }
}

function highlightSource(number) {
  const target = sourcesPanel.querySelector(`#source-${number}`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "nearest" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1500);
}

function renderSources(sources, question = "", notice = "") {
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
  heading.append(
    source.url
      ? el("a", "source-title", source.title, { href: source.url, target: "_blank", rel: "noopener noreferrer" })
      : el("span", "source-title", source.title)
  );
  item.append(heading);
  for (const passage of source.passages) item.append(el("p", "source-passage", passage.text));
  return item;
}
