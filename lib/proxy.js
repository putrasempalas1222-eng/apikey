const { Readable } = require("node:stream")

const PROVIDERS = {
  atria: { baseUrl: "https://api.atria-asi.ai/v1", secret: "ATRIA_API_KEY" },
  ceo: { baseUrl: "https://dashboard.ceoweb3.dev/v1", secret: "CEO_API_KEY" },
  bacrot: { baseUrl: "https://bacrot.my.id/v1", secret: "BACROT_API_KEY" },
}

// Applied server-side for every provider. It reduces filler prose while keeping
// code, paths, commands, errors, and tool output exact.
const COMPACT_RESPONSE_RULES = [
  "Be concise and action-first.",
  "Do not restate the request or add introductions, summaries, or filler.",
  "Use short bullets only when they improve clarity.",
  "For coding work: make the change, then report only files changed and essential verification.",
  "Keep code, commands, file paths, exact errors, security warnings, and required confirmations complete.",
  "Do not explain obvious steps. Expand only when the user explicitly asks for detail.",
  "Verification, only when the matching tool is available: use Playwright for browser/UI behavior; use the project database CLI (Supabase where applicable) for schema/data work; use Strix for authorized security scans; use SkillUI for UI-to-spec analysis; use Context7 for current API documentation.",
  "Follow docs-ai discipline when its ai-rules folder exists: read the project contract first, keep modules cohesive, respect the existing architecture, and update only documentation affected by a real API, architecture, database, deployment, or operational change.",
  "Do not create placeholder documentation or duplicate summaries. Prefer a small accurate change over broad boilerplate.",
  "Never claim a test, scan, tool call, or documentation lookup ran unless it actually ran. If unavailable, say so in one short line.",
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
  body.messages = [{ role: "system", content: COMPACT_RESPONSE_RULES }, ...body.messages]
  // Prevent excessive prose by default. A caller can still request a larger
  // response explicitly with max_tokens for a large code-generation task.
  if (typeof body.max_tokens !== "number") body.max_tokens = 2048
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
