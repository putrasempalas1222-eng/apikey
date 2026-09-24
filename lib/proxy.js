const { Readable } = require("node:stream")

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

async function chat(request, response, providerId) {
  cors(response)
  if (request.method === "OPTIONS") return response.status(204).end()
  if (request.method !== "POST") return fail(response, 405, "Method not allowed.")

  const provider = PROVIDERS[providerId]
  const { model, messages } = request.body ?? {}
  if (!provider || typeof model !== "string" || !model.trim() || !Array.isArray(messages)) {
    return fail(response, 400, "Selected model is unavailable.")
  }
  const apiKey = process.env[provider.secret]
  if (!apiKey) return fail(response, 503, "Selected model is temporarily unavailable.")

  const { providerId: _providerId, ...body } = request.body
  try {
    const upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    })
    if (!upstream.ok) return fail(response, upstream.status, "Selected model is temporarily unavailable.")
    response.status(upstream.status)
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json")
    if (upstream.body) return Readable.fromWeb(upstream.body).pipe(response)
    return response.end()
  } catch (error) {
    console.error("Provider proxy request failed", error)
    return fail(response, 502, "Selected model is temporarily unavailable.")
  }
}

module.exports = { chat }
