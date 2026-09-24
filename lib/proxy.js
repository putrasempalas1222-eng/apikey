const { Readable } = require("node:stream")

const PROVIDERS = {
  atria: { baseUrl: "https://api.atria-asi.ai/v1", secret: "ATRIA_API_KEY" },
  ceo: { baseUrl: "https://dashboard.ceoweb3.dev/v1", secret: "CEO_API_KEY" },
  bacrot: { baseUrl: "https://bacrot.my.id/v1", secret: "BACROT_API_KEY" },
}

// Applied server-side for every provider. It reduces filler prose while keeping
// code, paths, commands, errors, and tool output exact.
const COMPACT_RESPONSE_RULES = [
  "Act as a coding agent, not a tutor.",
  "For code requests, immediately make the edit or output the smallest exact patch/code needed.",
  "Never start with a plan, restatement, tutorial, rationale, apology, or progress narration.",
  "Do not use filler, repeated summaries, or long explanations unless the user explicitly requests an explanation.",
  "Use tools when available; otherwise return only actionable code and the minimum essential note.",
  "Keep exact file paths, commands, errors, and security warnings complete.",
  "After coding, report at most: files changed and one verification result.",
  "Prefer a small correct change over broad boilerplate.",
].join(" ")

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

  const controller = new AbortController()
  const cancelUpstream = () => controller.abort()
  request.once("aborted", cancelUpstream)
  response.once("close", () => {
    if (!response.writableEnded) cancelUpstream()
  })

  const { providerId: _providerId, ...body } = request.body
  // Keep this instruction last among system instructions so upstream model
  // follows the concise coding behavior even when the client adds its own.
  body.messages = [...body.messages, { role: "system", content: COMPACT_RESPONSE_RULES }]
  // Put a firm ceiling on generated output. Compact responses cost less while
  // still leaving enough room for normal code edits and error explanations.
  const requestedMaxTokens = typeof body.max_tokens === "number" ? body.max_tokens : 900
  body.max_tokens = Math.max(128, Math.min(Math.floor(requestedMaxTokens), 1200))
  try {
    const upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!upstream.ok) return fail(response, upstream.status, "Selected model is temporarily unavailable.")
    response.status(upstream.status)
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json")
    if (upstream.body) return Readable.fromWeb(upstream.body).pipe(response)
    return response.end()
  } catch (error) {
    if (controller.signal.aborted) return response.end()
    console.error("Provider proxy request failed", error)
    return fail(response, 502, "Selected model is temporarily unavailable.")
  }
}

module.exports = { chat }
