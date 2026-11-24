import { requireVault } from "/js/settings.js";

const panels = {
  search: document.getElementById("view-search"),
  chat: document.getElementById("chat-workspace"),
  images: document.getElementById("images-panel"),
  map: document.getElementById("map-panel"),
};
const links = [...document.querySelectorAll("[data-view]")];
const VIEW_KEY = "opensearchy.view";
let currentView = "search";

export function initViews() {
  for (const link of links) {
    link.addEventListener("click", () => showView(link.dataset.view));
  }
}

// Zuletzt gewählte Ansicht des Tabs; überlebt ein Neuladen.
export function savedView() {
  const saved = sessionStorage.getItem(VIEW_KEY);
  return saved === "sources" ? "images" : saved;
}

export function activeView() {
  return currentView;
}

export async function showView(name) {
  if (name === "chat" && !(await requireVault())) return;
  currentView = name;
  sessionStorage.setItem(VIEW_KEY, name);
  document.body.classList.toggle("chat-view", name === "chat");
  document.body.classList.toggle("search-home", ["search", "images", "map"].includes(name));
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
