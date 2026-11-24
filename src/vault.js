import { deleteRecord, readRecord, writeRecord } from "/js/store.js";

const STORAGE_KEY = "opensearchy.vault";
const SESSION_KEY = "opensearchy.session";
const RECORD_NAME = "vault";
const FORMAT = "opensearchy-vault";
const VERSION = 1;
const ITERATIONS = 600000;
const DEFAULT_PROVIDERS = [
  { id: "brave-search", name: "Brave Search", baseUrl: "https://api.search.brave.com/res/v1" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let session = null;
let data = null;
// Verschlüsselter Vault wie er auf dem Gerät liegt; null, solange keiner existiert.
let stored = null;
let storeReady = null;
let writeQueue = Promise.resolve();

function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function emptyData() {
  return {
    providers: [],
    prompts: [],
    agents: [],
    chat: { history: [], transcript: [], sources: null },
    chats: [],
    chatPreferences: { target: null, recent: [] },
  };
}

async function deriveRaw(password, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, 256);
  return new Uint8Array(bits);
}

function aesKey(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function newSession(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const raw = await deriveRaw(password, salt, ITERATIONS);
  return { key: await aesKey(raw), raw, salt, iterations: ITERATIONS };
}

// Hält den abgeleiteten Schlüssel für den Tab, bis er geschlossen wird (sessionStorage).
function saveSession() {
  if (!session) return;
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ raw: toBase64(session.raw), salt: toBase64(session.salt), iterations: session.iterations })
  );
}

async function seal() {
  if (!session || !data) throw new Error("Vault ist gesperrt.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    session.key,
    encoder.encode(JSON.stringify(data))
  );
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: session.iterations, salt: toBase64(session.salt) },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    data: toBase64(new Uint8Array(cipher)),
  });
}

async function openEnvelope(text, password) {
  if (!text) throw new Error("Kein Speicher vorhanden.");
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("Datei ist kein gültiger Vault.");
  }
  if (envelope.format !== FORMAT || envelope.version !== VERSION) {
    throw new Error("Unbekanntes Vault-Format.");
  }

  const salt = fromBase64(envelope.kdf.salt);
  const raw = await deriveRaw(password, salt, envelope.kdf.iterations);
  const key = await aesKey(raw);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.cipher.iv) },
      key,
      fromBase64(envelope.data)
    );
  } catch {
    throw new Error("Master-Passwort falsch oder Daten beschädigt.");
  }
  return {
    session: { key, raw, salt, iterations: envelope.kdf.iterations },
    data: { ...emptyData(), ...JSON.parse(decoder.decode(plain)) },
  };
}

async function persist() {
  const write = writeQueue.then(async () => {
    stored = await seal();
    await writeRecord(RECORD_NAME, stored);
  });
  writeQueue = write.catch(() => {});
  return write;
}

// Lädt den verschlüsselten Vault vom Gerät; übernimmt einen älteren Vault aus dem Browser-Speicher.
function loadVaultStore() {
  storeReady ??= (async () => {
    stored = await readRecord(RECORD_NAME);
    const legacy = localStorage.getItem(STORAGE_KEY);
    if (stored === null && legacy !== null) {
      await writeRecord(RECORD_NAME, legacy);
      stored = legacy;
      localStorage.removeItem(STORAGE_KEY);
    }
  })();
  return storeReady;
}

export function hasStoredVault() {
  return stored !== null;
}

export function isUnlocked() {
  return data !== null;
}

export function vaultData() {
  return data;
}

export function exportVault() {
  return stored ?? "";
}

export async function createVault(password) {
  session = await newSession(password);
  data = { ...emptyData(), providers: DEFAULT_PROVIDERS.map((provider) => ({ ...provider })) };
  await persist();
  saveSession();
}

export async function unlockVault(password) {
  await loadVaultStore();
  const opened = await openEnvelope(stored, password);
  session = opened.session;
  data = withDefaultProviders(opened.data);
  saveSession();
}

function withDefaultProviders(current) {
  const merged = { ...emptyData(), ...current };
  merged.providers = merged.providers.filter((provider) => provider.id !== "perplexity");
  const existingIds = new Set(merged.providers.map((provider) => provider.id));
  for (const provider of DEFAULT_PROVIDERS) {
    if (!existingIds.has(provider.id)) merged.providers.unshift({ ...provider });
  }
  return merged;
}

// Stellt die Sitzung aus sessionStorage wieder her, ohne erneut nach dem Passwort zu fragen.
export async function restoreVault() {
  if (session) return true;
  await loadVaultStore();
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (!saved || stored === null) return false;
  try {
    const savedSession = JSON.parse(saved);
    const raw = fromBase64(savedSession.raw);
    const key = await aesKey(raw);
    const envelope = JSON.parse(stored);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.cipher.iv) },
      key,
      fromBase64(envelope.data)
    );
    session = { key, raw, salt: fromBase64(savedSession.salt), iterations: savedSession.iterations };
    data = withDefaultProviders(JSON.parse(decoder.decode(plain)));
    return true;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return false;
  }
}

export async function importVault(text, password) {
  const opened = await openEnvelope(text, password);
  session = opened.session;
  data = opened.data;
  await persist();
  saveSession();
}

export async function saveVault() {
  await persist();
}

export async function changePassword(password) {
  session = await newSession(password);
  await persist();
  saveSession();
}

export function lockVault() {
  session = null;
  data = null;
  sessionStorage.removeItem(SESSION_KEY);
}

export async function forgetVault() {
  await deleteRecord(RECORD_NAME);
  stored = null;
  storeReady = Promise.resolve();
  lockVault();
}
