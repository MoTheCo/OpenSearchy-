const STORE_PATH = "/api/store";

// Liefert den gespeicherten Text eines Datensatzes oder null, wenn keiner existiert.
export async function readRecord(name) {
  const response = await fetch(`${STORE_PATH}/${name}`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Speicher antwortet mit HTTP ${response.status}.`);
  return response.text();
}

export async function writeRecord(name, text) {
  const response = await fetch(`${STORE_PATH}/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: text,
  });
  if (!response.ok) throw new Error(`Speichern fehlgeschlagen (HTTP ${response.status}).`);
}

export async function deleteRecord(name) {
  const response = await fetch(`${STORE_PATH}/${name}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Löschen fehlgeschlagen (HTTP ${response.status}).`);
}
