/**
 * Server-only AI proxy for Vercel.
 *
 * Add the provider keys in Vercel Project Settings -> Environment Variables.
 * Never put provider keys in this repository, a VSIX, or Firebase.
 */
const PROVIDERS = {
  atria: { baseUrl: "https://api.atria-asi.ai/v1", secret: "ATRIA_API_KEY" },
  ceo: { baseUrl: "https://dashboard.ceoweb3.dev/v1", secret: "CEO_API_KEY" },
  bacrot: { baseUrl: "https://bacrot.my.id/v1", secret: "BACROT_API_KEY" },
}

function cors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*")
  response.setHeader("Access-Control-Allow-Headers", "Content-Type")
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
}

function fail(response, status, message) {
  return response.status(status).json({ error: { message } })
}

module.exports = async (request, response) => {
  cors(response)
  if (request.method === "OPTIONS") return response.status(204).end()
  if (request.method !== "POST") return fail(response, 405, "Method not allowed.")

  const { providerId = "atria", model, messages, temperature, max_tokens } = request.body ?? {}
  const provider = PROVIDERS[providerId]
  if (!provider || typeof model !== "string" || !model.trim() || !Array.isArray(messages)) {
    return fail(response, 400, "Selected model is unavailable.")
  }

  const apiKey = process.env[provider.secret]
  if (!apiKey) return fail(response, 503, "Selected model is temporarily unavailable.")

  const body = { model: model.trim(), messages }
  if (typeof temperature === "number") body.temperature = temperature
  if (typeof max_tokens === "number") body.max_tokens = max_tokens

  try {
    const upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })
    const payload = await upstream.json().catch(() => null)
    if (!upstream.ok) return fail(response, upstream.status, "Selected model is temporarily unavailable.")
    return response.status(200).json(payload)
  } catch (error) {
    console.error("Provider proxy request failed", error)
    return fail(response, 502, "Selected model is temporarily unavailable.")
  }
}
