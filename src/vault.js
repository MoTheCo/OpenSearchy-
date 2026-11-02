const STORAGE_KEY = "opensearchy.vault";
const FORMAT = "opensearchy-vault";
const BACKUP_VERSION = 1;
const LOCAL_VERSION = 2;
const ITERATIONS = 600000;
const DEVICE_DB = "opensearchy-keys";
const DEVICE_STORE = "keys";
const DEVICE_KEY_ID = "device";
const DEFAULT_PROVIDERS = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let deviceKey = null;
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

// Der Geräteschlüssel ist nicht exportierbar und liegt nur in der IndexedDB dieses Browsers.
async function runKeyStore(mode, action) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVICE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DEVICE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DEVICE_STORE, mode);
      const request = action(tx.objectStore(DEVICE_STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function readDeviceKey() {
  return (await runKeyStore("readonly", (store) => store.get(DEVICE_KEY_ID))) ?? null;
}

async function createDeviceKey() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await runKeyStore("readwrite", (store) => store.put(key, DEVICE_KEY_ID));
  return key;
}

async function removeDeviceKey() {
  await runKeyStore("readwrite", (store) => store.delete(DEVICE_KEY_ID));
}

function parseEnvelope(text, version) {
  if (!text) throw new Error("Kein Speicher vorhanden.");
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("Datei ist kein gültiger Vault.");
  }
  if (envelope.format !== FORMAT || envelope.version !== version) {
    throw new Error("Unbekanntes Vault-Format.");
  }
  return envelope;
}

async function encryptData(key, iv) {
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(data))));
}

// Lokale Speicherung: verschlüsselt mit dem Geräteschlüssel, kein Passwort nötig.
async function persist() {
  if (!data) throw new Error("Vault ist nicht geladen.");
  deviceKey ??= (await readDeviceKey()) ?? (await createDeviceKey());
  const iv = crypto.getRandomValues(new Uint8Array(12));
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      format: FORMAT,
      version: LOCAL_VERSION,
      cipher: { name: "AES-GCM", iv: toBase64(iv) },
      data: toBase64(await encryptData(deviceKey, iv)),
    })
  );
}

async function openLocal(text) {
  const envelope = parseEnvelope(text, LOCAL_VERSION);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.cipher.iv) },
      deviceKey,
      fromBase64(envelope.data)
    );
  } catch {
    throw new Error("Gespeicherter Speicher konnte nicht entschlüsselt werden.");
  }
  return { ...emptyData(), ...JSON.parse(decoder.decode(plain)) };
}

// Backup-Datei: mit dem Master-Passwort verschlüsselt, damit sie auf anderen Geräten nutzbar ist.
async function sealBackup(password) {
  if (!data) throw new Error("Vault ist nicht geladen.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, ITERATIONS);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return JSON.stringify({
    format: FORMAT,
    version: BACKUP_VERSION,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: toBase64(salt) },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    data: toBase64(await encryptData(key, iv)),
  });
}

async function openBackup(text, password) {
  const envelope = parseEnvelope(text, BACKUP_VERSION);
  const key = await deriveKey(password, fromBase64(envelope.kdf.salt), envelope.kdf.iterations);
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
  return { ...emptyData(), ...JSON.parse(decoder.decode(plain)) };
}

export function isUnlocked() {
  return data !== null;
}

export function vaultData() {
  return data;
}

// Lädt den lokalen Speicher beim Start; ohne Speicher wird ein leerer Vault angelegt.
export async function loadVault() {
  deviceKey = await readDeviceKey();
  if (localStorage.getItem(STORAGE_KEY)) {
    if (!deviceKey) {
      throw new Error("Der Geräteschlüssel fehlt, der gespeicherte Speicher kann nicht geöffnet werden. Bitte ein Backup importieren.");
    }
    data = await openLocal(localStorage.getItem(STORAGE_KEY));
    return;
  }
  data = { ...emptyData(), providers: DEFAULT_PROVIDERS.map((provider) => ({ ...provider })) };
  await persist();
}

export async function exportVault(password) {
  return sealBackup(password);
}

export async function importVault(text, password) {
  data = await openBackup(text, password);
  await persist();
}

export async function saveVault() {
  await persist();
}

export async function forgetVault() {
  localStorage.removeItem(STORAGE_KEY);
  data = null;
  deviceKey = null;
  await removeDeviceKey();
  await loadVault();
}
