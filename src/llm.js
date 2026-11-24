function chatEndpoint(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

// Vollständige Antwort ohne Streaming; nötig, wenn das LLM ein JSON-Signal liefert.
export async function completeChat({ baseUrl, apiKey, model, messages, temperature, maxTokens }) {
  let response;
  try {
    response = await fetch(chatEndpoint(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
    });
  } catch {
    throw new Error(
      "Anfrage an den Provider fehlgeschlagen (Netzwerk, CORS oder ungültiger API-Key). " +
        "Key, Modell und Base-URL in den Einstellungen prüfen."
    );
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Provider antwortet mit HTTP ${response.status}: ${detail}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}

export async function streamChat({ baseUrl, apiKey, model, messages, temperature, maxTokens, onToken }) {
  let response = await streamRequest({
    baseUrl,
    apiKey,
    model,
    messages,
    temperature,
    maxTokens,
  });
  if ([502, 503, 504].includes(response.status)) {
    await delay(300);
    response = await streamRequest({
      baseUrl,
      apiKey,
      model,
      messages,
      temperature,
      maxTokens,
    });
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    if ([502, 503, 504].includes(response.status)) {
      const fallback = await completeChat({
        baseUrl,
        apiKey,
        model,
        messages,
        temperature,
        maxTokens,
      });
      onToken?.(fallback);
      return;
    }
    throw new Error(`Provider antwortet mit HTTP ${response.status}: ${detail}`);
  }

  if (!response.body) throw new Error("Provider unterstützt kein Streaming.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (handleSseLine(line, onToken)) return;
    }
    if (done) {
      if (buffer && handleSseLine(buffer, onToken)) return;
      return;
    }
  }
}

async function streamRequest({ baseUrl, apiKey, model, messages, temperature, maxTokens }) {
  try {
    return await fetch(chatEndpoint(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
    });
  } catch {
    throw new Error(
      "Anfrage an den Provider fehlgeschlagen (Netzwerk, CORS oder ungültiger API-Key). " +
        "Key, Modell und Base-URL in den Einstellungen prüfen."
    );
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function handleSseLine(line, onToken) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return false;
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") return true;
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    throw new Error("Provider hat einen ungültigen Streaming-Block gesendet.");
  }
  if (event.error) {
    throw new Error(event.error.message || "Provider hat den Streaming-Request abgelehnt.");
  }
  const delta = event.choices?.[0]?.delta?.content;
  if (delta) onToken(delta);
  return false;
}
