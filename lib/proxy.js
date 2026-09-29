const { Readable, Transform } = require("node:stream")

const PROVIDERS = {
  dep2: { baseUrl: "https://rra4dpe.abc-tunnel.us/v1", secret: "DEP2_API_KEY" },
  dep3: { baseUrl: "https://rra4dpe.abc-tunnel.us/v1", secret: "DEP3_API_KEY" },
  dep4: { baseUrl: "https://rra4dpe.abc-tunnel.us/v1", secret: "DEP4_API_KEY" },
  dep5: { baseUrl: "https://rra4dpe.abc-tunnel.us/v1", secret: "DEP5_API_KEY" },
  dep6: { baseUrl: "https://rra4dpe.abc-tunnel.us/v1", secret: "DEP6_API_KEY" },
  dahl: { baseUrl: "https://inference.dahl.global/v1", secret: "DAHL_API_KEY" },
}

// Models that emit <think>...</think> reasoning blocks in their content.
// The proxy strips these before forwarding to the client so users never see
// raw chain-of-thought. Add model IDs here whenever a new reasoning model is
// added to a provider.
const REASONING_MODEL_IDS = new Set([
  "MiniMaxAI/MiniMax-M2.7",
])

// Strip <think>…</think> blocks from a content string (non-streaming).
function stripThinkBlocks(text) {
  return text.replace(/<think>[\s\S]*?<\/think>\n*/g, "")
}

// Stateful SSE transformer: strips <think>…</think> that may span multiple
// streaming chunks. Safe to pipe between Readable and the response.
class ThinkStripper extends Transform {
  constructor() {
    super()
    this._buf = ""
    this._inThink = false
  }

  _transform(chunk, _enc, cb) {
    this._buf += chunk.toString()
    let out = ""

    while (this._buf.length > 0) {
      if (this._inThink) {
        const end = this._buf.indexOf("</think>")
        if (end === -1) break // wait for more data
        this._buf = this._buf.slice(end + "</think>".length)
        if (this._buf.startsWith("\n")) this._buf = this._buf.slice(1)
        this._inThink = false
      } else {
        const start = this._buf.indexOf("<think>")
        if (start === -1) {
          // No opening tag — forward all but last 6 chars (partial tag guard)
          const safe = this._buf.length > 6 ? this._buf.length - 6 : 0
          out += this._buf.slice(0, safe)
          this._buf = this._buf.slice(safe)
          break
        }
        out += this._buf.slice(0, start)
        this._buf = this._buf.slice(start + "<think>".length)
        this._inThink = true
      }
    }

    if (out) this.push(out)
    cb()
  }

  _flush(cb) {
    if (!this._inThink && this._buf) this.push(this._buf)
    this._buf = ""
    cb()
  }
}

// For non-streaming JSON: rewrite content fields of all choices.
function stripThinkFromJson(body) {
  try {
    const obj = JSON.parse(body)
    if (!obj.choices) return body
    let changed = false
    for (const choice of obj.choices) {
      const msg = choice.message || choice.delta
      if (msg && typeof msg.content === "string") {
        const clean = stripThinkBlocks(msg.content)
        if (clean !== msg.content) { msg.content = clean; changed = true }
      }
    }
    return changed ? JSON.stringify(obj) : body
  } catch {
    return body
  }
}

// vLLM rejects requests where any tool parameter enum has > 256 values.
const ENUM_LIMIT = 256
function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return tools
  return tools.map((tool) => {
    if (!tool?.function?.parameters) return tool
    const params = JSON.parse(JSON.stringify(tool.function.parameters))
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

const COMPACT_RESPONSE_RULES = [
  "You are M Putra Ramadhani Agents Code AI, an AI coding agent built by M Putra Ramadhani. If asked who you are, always identify yourself as 'M Putra Ramadhani Agents Code AI'.",
  "CRITICAL: Always respond in the exact same language the user writes in. If the user writes in Indonesian (Bahasa Indonesia), respond fully in Indonesian. If in English, respond in English. Never switch languages unless the user switches first.",
  "Act as a coding agent, not a tutor.",
  "The user's latest message is authoritative: answer that request directly and never invent a different task.",
  "Do not claim to have edited, run, or verified anything unless a tool result in the current conversation confirms it.",
  "For code requests, immediately make the edit or output the smallest exact patch/code needed.",
  "Before creating a requested folder, inspect the exact target path. If it exists, keep it and add or update only the requested files; create it only when missing. Before changing an existing file, inspect it and preserve unrelated user changes.",
  "Use the shortest safe sequence of tools. Do not repeat scans or explanations after evidence is already available.",
  "Never start with a plan, restatement, tutorial, rationale, apology, or progress narration.",
  "Do not use filler, repeated summaries, or long explanations unless the user explicitly requests an explanation.",
  "Use tools when available; otherwise return only actionable code and the minimum essential note.",
  "Keep exact file paths, commands, errors, and security warnings complete.",
  "After coding, report at most: files changed and one verification result.",
  "Prefer a small correct change over broad boilerplate.",
  "CRITICAL PATH RULE: When providing file paths in tool calls (fs_write, str_replace, etc), always use forward slashes (/) instead of backslashes (\\), even on Windows. This prevents JSON parsing errors. Example: use 'D:/3D POSTER/agents ai/file.txt' not 'D:\\3D POSTER\\agents ai\\file.txt'. Forward slashes work on all operating systems including Windows.",
].join(" ")

const DEFAULT_MAX_TOKENS = 8192
const MAX_RESPONSE_TOKENS = Infinity // No limit - let model decide

function capResponseTokens(body) {
  const requested = Number(body.max_tokens ?? body.max_completion_tokens)
  const value = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_MAX_TOKENS
  body.max_tokens = Math.min(Math.floor(value), MAX_RESPONSE_TOKENS)
  // OpenAI-compatible providers vary in their support for the newer field.
  // Sending one normalized limit keeps the request small and predictable.
  delete body.max_completion_tokens
}

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
    return fail(response, 400, "Invalid request: model or messages missing.")
  }
  const apiKey = process.env[provider.secret]
  if (!apiKey) {
    console.error(`Missing API key for provider: ${providerId} (${provider.secret})`)
    return fail(response, 503, `Provider ${providerId} is not configured. Check API key environment variable: ${provider.secret}`)
  }

  const controller = new AbortController()
  const cancelUpstream = () => controller.abort()
  request.once("aborted", cancelUpstream)
  response.once("close", () => {
    if (!response.writableEnded) cancelUpstream()
  })

  const { providerId: _providerId, ...body } = request.body
  body.messages = [{ role: "system", content: COMPACT_RESPONSE_RULES }, ...body.messages]
  capResponseTokens(body)
  if (body.tools) body.tools = sanitizeTools(body.tools)
  if (body.stream === true) {
    body.stream_options = { ...(body.stream_options || {}), include_usage: true }
  }

  const needsThinkStrip = REASONING_MODEL_IDS.has(model)
  const connectTimeout = setTimeout(() => controller.abort(), 90_000)

  try {
    const upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!upstream.ok) {
      const retryAfter = upstream.headers.get("retry-after") || upstream.headers.get("retry-after-ms")
      if (retryAfter) response.setHeader("Retry-After", retryAfter)
      
      // Log detailed error for debugging
      console.error(`Provider error: ${providerId} | Model: ${model} | Status: ${upstream.status} | URL: ${provider.baseUrl}`)
      
      // Provider bodies can contain endpoint data, headers, or implementation
      // JSON. Never relay them to the extension or browser.
      await upstream.body?.cancel()
      
      // Specific error messages based on status
      if (upstream.status === 401) {
        return fail(response, 401, `Authentication failed for ${providerId}. Please check your API key.`)
      }
      if (upstream.status === 403) {
        return fail(response, 403, `Access forbidden for model "${model}". Check your API key permissions or account status.`)
      }
      if (upstream.status === 404) {
        return fail(response, 404, `Model "${model}" not found on ${providerId}. Please check the model name.`)
      }
      if (upstream.status === 429) {
        return fail(response, 429, "Rate limit exceeded. Please try again shortly or choose another model.")
      }
      if (upstream.status === 503 || upstream.status === 502) {
        return fail(response, upstream.status, `Provider ${providerId} is temporarily unavailable. Try another provider or wait a few minutes.`)
      }
      
      return fail(response, upstream.status, `Model "${model}" on ${providerId} returned error ${upstream.status}. Try another model or provider.`)
    }

    const contentType = upstream.headers.get("content-type") || "application/json"
    response.status(upstream.status)
    response.setHeader("Content-Type", contentType)

    if (!upstream.body) return response.end()

    const isStream = contentType.includes("text/event-stream")

    // Non-streaming reasoning model: buffer → strip → send
    if (!isStream && needsThinkStrip) {
      const chunks = []
      for await (const chunk of Readable.fromWeb(upstream.body)) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString("utf8")
      return response.end(stripThinkFromJson(raw))
    }

    // Streaming reasoning model: pipe through ThinkStripper
    if (isStream && needsThinkStrip) {
      const stripper = new ThinkStripper()
      Readable.fromWeb(upstream.body).pipe(stripper).pipe(response)
      stripper.once("end", () => { if (!response.writableEnded) response.end() })
      stripper.once("error", () => { if (!response.writableEnded) { response.write("\ndata: [DONE]\n\n"); response.end() } })
      return
    }

    // Pass-through for non-reasoning models
    const readable = Readable.fromWeb(upstream.body)
    readable.pipe(response)
    readable.once("end", () => { if (!response.writableEnded) response.end() })
    readable.once("error", () => {
      // Aborts (client force-stop) are expected — do not log or leak error details.
      if (controller.signal.aborted) return
      if (!response.writableEnded) {
        if (isStream) response.write("\ndata: [DONE]\n\n")
        response.end()
      }
    })
    return
  } catch (error) {
    // User-initiated abort (stop button) should not show as error
    if (controller.signal.aborted) {
      console.log(`Request aborted by user: ${providerId} | Model: ${model}`)
      return response.end()
    }
    console.error("Provider proxy request failed", error)
    return fail(response, 502, `Provider ${providerId} connection failed. Please try again or select a different provider.`)
  } finally {
    clearTimeout(connectTimeout)
  }
}

module.exports = { chat }
