const { Readable } = require("node:stream")

const PROVIDERS = {
  atria: { baseUrl: "https://api.atria-asi.ai/v1", secret: "ATRIA_API_KEY" },
  ceo: { baseUrl: "https://dashboard.ceoweb3.dev/v1", secret: "CEO_API_KEY" },
  dahl: { baseUrl: "https://inference.dahl.global/v1", secret: "DAHL_API_KEY" },
}

// vLLM (used by dahl) rejects requests where any tool parameter enum has more
// than 256 values. Walk the tools array and truncate offending enums in-place.
const ENUM_LIMIT = 256
function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return tools
  return tools.map((tool) => {
    if (!tool?.function?.parameters) return tool
    const params = JSON.parse(JSON.stringify(tool.function.parameters)) // deep clone
    truncateEnums(params)
    return { ...tool, function: { ...tool.function, parameters: params } }
  })
}
function truncateEnums(schema) {
  if (!schema || typeof schema !== "object") return
  if (Array.isArray(schema.enum) && schema.enum.length > ENUM_LIMIT) {
    schema.enum = schema.enum.slice(0, ENUM_LIMIT)
  }
  for (const value of Object.values(schema)) {
    if (value && typeof value === "object") truncateEnums(value)
  }
}

// Applied server-side for every provider. It reduces filler prose while keeping
// code, paths, commands, errors, and tool output exact.
const COMPACT_RESPONSE_RULES = [
  "Act as a coding agent, not a tutor.",
  "The user's latest message is authoritative: answer that request directly and never invent a different task.",
  "Do not claim to have edited, run, or verified anything unless a tool result in the current conversation confirms it.",
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
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, X-Firebase-Token")
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
  // Truncate tool parameter enums that exceed the upstream vLLM limit of 256.
  if (body.tools) body.tools = sanitizeTools(body.tools)
  // No server-side max_tokens cap — let the client decide. If the client
  // doesn't send max_tokens at all, leave it unset so the upstream model uses
  // its own default (up to its full maxOutput limit).
  if (body.stream === true) {
    // OpenAI-compatible providers that support this return final usage in the
    // last SSE event, allowing the reserved balance to be refunded precisely.
    body.stream_options = { ...(body.stream_options || {}), include_usage: true }
  }
  try {
    const upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!upstream.ok) {
      // Forward the upstream's Retry-After header so the client retry logic can
      // honour it (executor.ts reads this header to back off precisely).
      const retryAfter = upstream.headers.get("retry-after") || upstream.headers.get("retry-after-ms")
      if (retryAfter) response.setHeader("Retry-After", retryAfter)
      // Pipe the upstream error body through unchanged so the client/user can
      // see which model to switch to (e.g. dahl model_concurrency messages).
      const contentType = upstream.headers.get("content-type") || "application/json"
      response.status(upstream.status).setHeader("Content-Type", contentType)
      if (upstream.body) return Readable.fromWeb(upstream.body).pipe(response)
      return response.end()
    }
    response.status(upstream.status)
    const contentType = upstream.headers.get("content-type") || "application/json"
    response.setHeader("Content-Type", contentType)
    if (!upstream.body) return response.end()
    const readable = Readable.fromWeb(upstream.body)
    readable.pipe(response)
    // If the upstream stream ends abruptly (no error, just closes early),
    // make sure the response is properly finished so the client isn't left hanging.
    readable.once("end", () => { if (!response.writableEnded) response.end() })
    readable.once("error", (streamErr) => {
      console.error("Upstream stream error", streamErr)
      // For SSE streams, send a terminal event so the client parser closes cleanly.
      if (!response.writableEnded) {
        if (contentType.includes("text/event-stream")) {
          response.write('\ndata: [DONE]\n\n')
        }
        response.end()
      }
    })
    return
  } catch (error) {
    if (controller.signal.aborted) {
      return response.end()
    }
    console.error("Provider proxy request failed", error)
    return fail(response, 502, "Selected model is temporarily unavailable.")
  }
}

module.exports = { chat }
