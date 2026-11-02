const STORAGE_KEY = "opensearchy.vault";
const FORMAT = "opensearchy-vault";
const VERSION = 1;
const ITERATIONS = 600000;
const DEFAULT_PROVIDERS = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let session = null;
let data = null;

function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function emptyData() {
  return { providers: [], prompts: [], agents: [] };
}

async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function newSession(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await deriveKey(password, salt, ITERATIONS), salt, iterations: ITERATIONS };
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
  const key = await deriveKey(password, salt, envelope.kdf.iterations);
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
    session: { key, salt, iterations: envelope.kdf.iterations },
    data: { ...emptyData(), ...JSON.parse(decoder.decode(plain)) },
  };
}

async function persist() {
  localStorage.setItem(STORAGE_KEY, await seal());
}

export function hasStoredVault() {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

export function isUnlocked() {
  return data !== null;
}

export function vaultData() {
  return data;
}

export function exportVault() {
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

export async function createVault(password) {
  session = await newSession(password);
  data = { ...emptyData(), providers: DEFAULT_PROVIDERS.map((provider) => ({ ...provider })) };
  await persist();
}

export async function unlockVault(password) {
  const opened = await openEnvelope(localStorage.getItem(STORAGE_KEY), password);
  session = opened.session;
  data = opened.data;
}

export async function importVault(text, password) {
  const opened = await openEnvelope(text, password);
  session = opened.session;
  data = opened.data;
  await persist();
}

export async function saveVault() {
  await persist();
}

export async function changePassword(password) {
  session = await newSession(password);
  await persist();
}

export function lockVault() {
  session = null;
  data = null;
}

export function forgetVault() {
  localStorage.removeItem(STORAGE_KEY);
  lockVault();
}
