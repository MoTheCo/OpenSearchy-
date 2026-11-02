export async function streamChat({ baseUrl, apiKey, model, messages, temperature, maxTokens, onToken }) {
  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
    });
  } catch {
    // Der Browser meldet Netzwerk- und CORS-Fehler gleich. Fehlerantworten ohne
    // CORS-Header (z. B. HTTP 401 bei falschem Key) landen ebenfalls hier.
    throw new Error(
      "Anfrage an den Provider fehlgeschlagen (Netzwerk, CORS oder ungültiger API-Key). " +
        "Key, Modell und Base-URL in den Einstellungen prüfen."
    );
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Provider antwortet mit HTTP ${response.status}: ${detail}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of done ? [...lines, buffer] : lines) {
      if (handleSseLine(line, onToken)) return;
    }
    if (done) return;
  }
}

function handleSseLine(line, onToken) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return false;
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") return true;
  const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
  if (delta) onToken(delta);
  return false;
}
