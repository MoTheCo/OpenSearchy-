import { requireVault } from "/js/settings.js";

const panels = {
  search: document.getElementById("view-search"),
  chat: document.getElementById("chat-panel"),
  sources: document.getElementById("sources-panel"),
};
const links = [...document.querySelectorAll("[data-view]")];
const VIEW_KEY = "opensearchy.view";

export function initViews() {
  for (const link of links) {
    link.addEventListener("click", () => showView(link.dataset.view));
  }
}

// Zuletzt gewählte Ansicht des Tabs; überlebt ein Neuladen.
export function savedView() {
  return sessionStorage.getItem(VIEW_KEY);
}

export async function showView(name) {
  if (name === "chat" && !(await requireVault())) return;
  sessionStorage.setItem(VIEW_KEY, name);
  for (const [key, panel] of Object.entries(panels)) {
    panel.hidden = key !== name;
  }
  for (const link of links) {
    const active = link.dataset.view === name;
    link.classList.toggle("active", active);
    link.setAttribute("aria-pressed", String(active));
  }
  window.dispatchEvent(new CustomEvent("view-changed", { detail: name }));
}
