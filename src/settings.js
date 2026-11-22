import { el } from "/js/dom.js";
import { bindModelSelect, fillModelSelect, loadModels, readModel } from "/js/models.js";
import {
  changePassword,
  createVault,
  exportVault,
  forgetVault,
  hasStoredVault,
  importVault,
  isUnlocked,
  lockVault,
  restoreVault,
  saveVault,
  unlockVault,
  vaultData,
} from "/js/vault.js";

const MIN_PASSWORD_LENGTH = 8;
const LIBRARIES = {
  providers: {
    singular: "Provider",
    fields: [
      { name: "name", label: "Name", required: true },
      { name: "baseUrl", label: "Base URL", type: "url", required: true },
      { name: "apiKey", label: "API-Key", type: "password" },
    ],
    subtitle: (item) => item.baseUrl,
  },
  prompts: {
    singular: "Prompt",
    fields: [
      { name: "name", label: "Name", required: true },
      { name: "text", label: "Systemprompt", textarea: true, required: true },
    ],
    subtitle: (item) => item.text.slice(0, 120),
  },
};

const $ = (id) => document.getElementById(id);
const settingsModal = $("settings-modal");
const masterModal = $("master-key-modal");
const masterForm = $("master-key-form");
const agentModal = $("agent-modal");
const agentForm = $("agent-form");
const confirmModal = $("confirm-modal");

let masterResolve = null;
let confirmResolve = null;
let editing = null;

export function initSettings() {
  $("settings-btn").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", closeSettings);
  for (const button of settingsModal.querySelectorAll(".tab-btn")) {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  }
  masterForm.addEventListener("submit", onMasterSubmit);
  $("master-cancel").addEventListener("click", () => closeMaster(false));
  $("confirm-ok").addEventListener("click", () => closeConfirm(true));
  $("confirm-cancel").addEventListener("click", () => closeConfirm(false));
  $("agent-cancel").addEventListener("click", closeAgent);
  agentForm.addEventListener("submit", onAgentSubmit);
  $("agent-temperature").addEventListener("input", (event) => {
    $("temperature-value").textContent = event.target.value;
  });
  $("agent-prompt-template").addEventListener("change", applyPromptTemplate);
  $("agent-provider").addEventListener("change", (event) => {
    fillModelSelect($("agent-model"), $("agent-model-custom"), event.target.value, "");
    refreshAgentModels("");
  });
  bindModelSelect($("agent-model"), $("agent-model-custom"));
  document.addEventListener("keydown", onEscape);
}

// Liefert true, sobald der Speicher entsperrt bzw. neu angelegt ist.
export async function requireVault() {
  if (isUnlocked() || (await restoreVault())) return true;
  const creating = !hasStoredVault();
  $("master-title").textContent = creating ? "Master-Passwort festlegen" : "Master-Passwort";
  $("master-text").textContent = creating
    ? "Mit diesem Passwort werden API-Keys, Provider und Prompts verschlüsselt. Es wird nirgends gespeichert; ohne Passwort sind die Daten nicht wiederherstellbar."
    : "Master-Passwort eingeben, um den verschlüsselten Speicher zu entsperren.";
  $("master-confirm-field").hidden = !creating;
  $("master-password-confirm").required = creating;
  $("master-password").autocomplete = creating ? "new-password" : "current-password";
  $("master-submit").textContent = creating ? "Speichern" : "Entsperren";
  masterModal.hidden = false;
  $("master-password").focus();
  return new Promise((resolve) => {
    masterResolve = resolve;
  });
}

export function confirmDialog(message, okLabel = "Löschen") {
  $("confirm-message").textContent = message;
  $("confirm-ok").textContent = okLabel;
  confirmModal.hidden = false;
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

export async function openNewAgent() {
  if (!(await requireVault())) return;
  openAgentModal();
}

async function openSettings() {
  if (!(await requireVault())) return;
  settingsModal.hidden = false;
  renderAll();
}

function closeSettings() {
  settingsModal.hidden = true;
}

function showTab(name) {
  for (const button of settingsModal.querySelectorAll(".tab-btn")) {
    button.classList.toggle("active", button.dataset.tab === name);
  }
  for (const panel of settingsModal.querySelectorAll(".tab-panel")) {
    panel.hidden = panel.id !== `tab-${name}`;
  }
}

function renderAll() {
  renderAgents();
  renderLibrary("providers");
  renderLibrary("prompts");
  renderSecurity();
}

async function commit() {
  try {
    await saveVault();
  } catch (err) {
    window.alert(`Speichern fehlgeschlagen: ${err.message}`);
    return;
  }
  renderAll();
  window.dispatchEvent(new Event("vault-changed"));
}

function renderAgents() {
  const data = vaultData();
  const list = el("ul", "item-list");
  for (const agent of data.agents) {
    const provider = data.providers.find((item) => item.id === agent.providerId);
    list.append(
      itemRow(
        agent.name,
        `${provider?.name ?? "Kein Provider"} · ${agent.model}`,
        () => openAgentModal(agent),
        async () => {
          if (!(await confirmDialog(`Agent „${agent.name}“ löschen?`))) return;
          data.agents = data.agents.filter((item) => item.id !== agent.id);
          await commit();
        }
      )
    );
  }
  if (!data.agents.length) list.append(el("li", "empty", "Noch keine Agenten."));
  $("tab-agents").replaceChildren(toolbar("Neuer Agent", () => openAgentModal()), list);
}

function renderLibrary(tab) {
  const { singular, fields, subtitle } = LIBRARIES[tab];
  const data = vaultData();
  const items = data[tab];
  const list = el("ul", "item-list");
  for (const item of items) {
    list.append(
      itemRow(
        item.name,
        subtitle(item),
        () => {
          editing = { tab, item };
          renderLibrary(tab);
        },
        async () => {
          if (!(await confirmDialog(`„${item.name}“ löschen?`))) return;
          data[tab] = data[tab].filter((entry) => entry.id !== item.id);
          editing = null;
          await commit();
        }
      )
    );
  }
  if (!items.length) list.append(el("li", "empty", `Noch keine ${singular}.`));

  const parts = [
    toolbar(`Neuer ${singular}`, () => {
      editing = { tab, item: null };
      renderLibrary(tab);
    }),
  ];
  if (editing?.tab === tab) parts.push(editorForm(tab, fields, editing.item));
  parts.push(list);
  $(`tab-${tab}`).replaceChildren(...parts);
}

function editorForm(tab, fields, item) {
  const controls = {};
  const form = el("form", "editor");
  for (const field of fields) {
    const id = `${tab}-${field.name}`;
    const control = field.textarea
      ? el("textarea", null, undefined, { id, rows: "6" })
      : el("input", null, undefined, { id, type: field.type ?? "text", autocomplete: "off" });
    control.required = Boolean(field.required);
    control.value = item?.[field.name] ?? "";
    controls[field.name] = control;
    const group = el("div", "form-group");
    group.append(el("label", null, field.label, { for: id }), control);
    form.append(group);
  }
  const actions = el("div", "form-actions");
  form.append(actions);
  actions.append(
    button("Abbrechen", "btn-secondary", () => {
      editing = null;
      renderLibrary(tab);
    }),
    el("button", "btn-primary", "Speichern", { type: "submit" })
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const entry = { id: item?.id ?? crypto.randomUUID() };
    for (const field of fields) entry[field.name] = controls[field.name].value.trim();
    const data = vaultData();
    const index = data[tab].findIndex((existing) => existing.id === entry.id);
    if (index === -1) data[tab].push(entry);
    else data[tab][index] = entry;
    editing = null;
    await commit();
  });
  return form;
}

function itemRow(title, subtitle, onEdit, onDelete) {
  const row = el("li", "item");
  const info = el("div", "item-info");
  info.append(el("strong", null, title), el("span", "item-sub", subtitle));
  const actions = el("div", "item-actions");
  actions.append(button("Bearbeiten", "btn-secondary", onEdit), button("Löschen", "btn-danger", onDelete));
  row.append(info, actions);
  return row;
}

function button(label, className, onClick) {
  const node = el("button", className, label, { type: "button" });
  node.addEventListener("click", onClick);
  return node;
}

function toolbar(label, onClick) {
  const bar = el("div", "toolbar");
  bar.append(button(label, "btn-primary", onClick));
  return bar;
}

function section(title, content) {
  const wrapper = el("div", "section");
  wrapper.append(el("h3", null, title), content);
  return wrapper;
}

function showError(node, message) {
  node.textContent = message;
  node.hidden = false;
}

function fillSelect(select, items, selectedId) {
  select.replaceChildren(...items.map((item) => el("option", null, item.name, { value: item.id })));
  select.value = selectedId ?? "";
}

function openAgentModal(agent = null) {
  const data = vaultData();
  if (!data.providers.length) {
    window.alert("Bitte zuerst einen Provider anlegen.");
    return;
  }
  const temperature = agent?.temperature ?? 0.7;
  $("agent-modal-title").textContent = agent ? "Agent bearbeiten" : "Agent erstellen";
  $("agent-id").value = agent?.id ?? "";
  $("agent-name").value = agent?.name ?? "";
  fillSelect($("agent-provider"), data.providers, agent?.providerId ?? data.providers[0].id);
  fillModelSelect($("agent-model"), $("agent-model-custom"), $("agent-provider").value, agent?.model ?? "");
  refreshAgentModels(agent?.model ?? "");
  $("agent-base-url").value = agent?.baseUrl ?? "";
  fillSelect($("agent-prompt-template"), [{ id: "", name: "Vorlage wählen …" }, ...data.prompts], "");
  $("agent-system-prompt").value = agent?.systemPrompt ?? "";
  $("agent-temperature").value = String(temperature);
  $("temperature-value").textContent = String(temperature);
  $("agent-max-tokens").value = String(agent?.maxTokens ?? 4000);
  agentModal.hidden = false;
  $("agent-name").focus();
}

// Lädt die Live-Modellliste des gewählten Providers nach und behält die Auswahl bei.
async function refreshAgentModels(model) {
  const providerId = $("agent-provider").value;
  const provider = vaultData().providers.find((item) => item.id === providerId);
  if (!provider) return;
  const models = await loadModels(provider);
  if ($("agent-provider").value !== providerId) return;
  const current = model || readModel($("agent-model"), $("agent-model-custom"));
  fillModelSelect($("agent-model"), $("agent-model-custom"), providerId, current, models);
}

function applyPromptTemplate(event) {
  const prompt = vaultData().prompts.find((item) => item.id === event.target.value);
  if (prompt) $("agent-system-prompt").value = prompt.text;
  event.target.value = "";
}

async function onAgentSubmit(event) {
  event.preventDefault();
  const data = vaultData();
  const id = $("agent-id").value || crypto.randomUUID();
  const agent = {
    id,
    name: $("agent-name").value.trim(),
    providerId: $("agent-provider").value,
    model: readModel($("agent-model"), $("agent-model-custom")),
    baseUrl: $("agent-base-url").value.trim(),
    systemPrompt: $("agent-system-prompt").value.trim(),
    temperature: Number($("agent-temperature").value),
    maxTokens: Number($("agent-max-tokens").value),
  };
  const index = data.agents.findIndex((item) => item.id === id);
  if (index === -1) data.agents.push(agent);
  else data.agents[index] = agent;
  closeAgent();
  await commit();
}

function closeAgent() {
  agentModal.hidden = true;
}

function renderSecurity() {
  $("tab-security").replaceChildren(
    el("p", "hint", "Der Speicher liegt verschlüsselt (AES-256-GCM, Schlüssel per PBKDF2 aus dem Master-Passwort) auf diesem Gerät im Anwendungsordner. Chats sind darin ebenfalls verschlüsselt."),
    section("Sichern", toolbar("Verschlüsselte Datei herunterladen", downloadVault)),
    section("Wiederherstellen", importForm()),
    section("Master-Passwort ändern", passwordForm()),
    section("Aktionen", actionRow())
  );
}

function downloadVault() {
  const url = URL.createObjectURL(new Blob([exportVault()], { type: "application/json" }));
  const link = el("a", null, undefined, {
    href: url,
    download: `opensearchy-vault-${new Date().toISOString().slice(0, 10)}.json`,
  });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function importForm() {
  const file = el("input", null, undefined, { type: "file", accept: "application/json,.json" });
  const password = el("input", null, undefined, {
    type: "password",
    placeholder: "Master-Passwort der Datei",
    autocomplete: "off",
  });
  const error = el("p", "form-error", undefined, { hidden: "" });
  const run = button("Datei importieren (ersetzt den aktuellen Speicher)", "btn-danger", async () => {
    error.hidden = true;
    const selected = file.files[0];
    if (!selected) return showError(error, "Bitte eine Datei wählen.");
    if (!(await confirmDialog("Den aktuellen Speicher durch die Datei ersetzen?", "Ersetzen"))) return;
    try {
      await importVault(await selected.text(), password.value);
      password.value = "";
      await commit();
    } catch (err) {
      showError(error, err.message);
    }
  });
  const stack = el("div", "stack");
  stack.append(file, password, run, error);
  return stack;
}

function passwordForm() {
  const first = el("input", null, undefined, {
    type: "password",
    placeholder: "Neues Master-Passwort",
    autocomplete: "new-password",
  });
  const second = el("input", null, undefined, {
    type: "password",
    placeholder: "Wiederholen",
    autocomplete: "new-password",
  });
  const error = el("p", "form-error", undefined, { hidden: "" });
  const run = button("Master-Passwort ändern", "btn-primary", async () => {
    error.hidden = true;
    if (first.value.length < MIN_PASSWORD_LENGTH) {
      return showError(error, `Mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`);
    }
    if (first.value !== second.value) return showError(error, "Passwörter stimmen nicht überein.");
    try {
      await changePassword(first.value);
      first.value = "";
      second.value = "";
      window.alert("Master-Passwort geändert.");
    } catch (err) {
      showError(error, err.message);
    }
  });
  const stack = el("div", "stack");
  stack.append(first, second, run, error);
  return stack;
}

function actionRow() {
  const row = el("div", "toolbar");
  row.append(
    button("Jetzt sperren", "btn-secondary", () => {
      lockVault();
      closeSettings();
      window.dispatchEvent(new Event("vault-changed"));
    }),
    button("Gespeicherte Daten auf diesem Gerät löschen", "btn-danger", async () => {
      if (!(await confirmDialog("Alle Agenten, Provider, Prompts und Chats vom Gerät entfernen? Eine heruntergeladene Datei bleibt erhalten."))) {
        return;
      }
      await forgetVault();
      closeSettings();
      window.dispatchEvent(new Event("vault-changed"));
    })
  );
  return row;
}

async function onMasterSubmit(event) {
  event.preventDefault();
  const password = $("master-password").value;
  const confirmation = $("master-password-confirm").value;
  const creating = !hasStoredVault();
  const error = $("master-error");
  error.hidden = true;
  if (creating && password.length < MIN_PASSWORD_LENGTH) {
    return showError(error, `Mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`);
  }
  if (creating && password !== confirmation) {
    return showError(error, "Passwörter stimmen nicht überein.");
  }

  const submit = $("master-submit");
  submit.disabled = true;
  try {
    if (creating) await createVault(password);
    else await unlockVault(password);
    window.dispatchEvent(new Event("vault-changed"));
    closeMaster(true);
  } catch (err) {
    showError(error, err.message);
  } finally {
    submit.disabled = false;
  }
}

function closeMaster(ok) {
  masterModal.hidden = true;
  $("master-password").value = "";
  $("master-password-confirm").value = "";
  $("master-error").hidden = true;
  const resolve = masterResolve;
  masterResolve = null;
  resolve?.(ok);
}

function closeConfirm(ok) {
  confirmModal.hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(ok);
}

function onEscape(event) {
  if (event.key !== "Escape") return;
  if (!confirmModal.hidden) closeConfirm(false);
  else if (!agentModal.hidden) closeAgent();
  else if (!masterModal.hidden) closeMaster(false);
  else if (!settingsModal.hidden) closeSettings();
}
