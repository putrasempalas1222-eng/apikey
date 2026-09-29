const { Readable, Transform } = require("node:stream")
const { firebaseApp } = require("./firebase")

// ── Firebase helpers ────────────────────────────────────────────────────────

const PROVIDER_CACHE_TTL_MS = 60_000
const providerCache = new Map()

async function getProviderFromFirebase(providerId) {
  if (typeof providerId !== "string" || !providerId.trim()) return null
  const cached = providerCache.get(providerId)
  if (cached && cached.expiresAt > Date.now()) return cached.provider
  const app = firebaseApp()
  const baseUrl = app.options.databaseURL.replace(/\/$/, "")
  const accessToken = (await app.options.credential.getAccessToken()).access_token
  const url = `${baseUrl}/agents-code-ai/modelCatalog/providers/${encodeURIComponent(providerId)}.json`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) return null
  const data = await res.json()
  if (!data || data.enabled === false) return null
  providerCache.set(providerId, { provider: data, expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS })
  return data
}

// ── Fallback API keys ───────────────────────────────────────────────────────
// Naming convention per providerId:
//   {P}_API_KEY, {P}_API_KEY_2, {P}_API_KEY_3, ... (sampai env var habis)
// Semua key dicoba berurutan. Key yang kena limit/auth langsung dilewati ke
// key berikutnya, jadi satu provider masih jalan walau key pertama habis.
function collectApiKeys(providerId) {
  const prefix = `${providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`
  const keys = []
  const primary = process.env[prefix]
  if (primary) keys.push({ env: prefix, value: primary, index: 1 })
  for (let index = 2; ; index += 1) {
    const env = `${prefix}_${index}`
    const value = process.env[env]
    if (!value) break
    keys.push({ env, value, index })
  }
  return keys
}

// 401 key salah/revoke, 403 key tidak punya akses, 429 limit → coba key berikutnya.
const FALLBACK_STATUSES = new Set([401, 402, 403, 429])

// ── Reasoning model stripper ────────────────────────────────────────────────

const REASONING_MODEL_IDS = new Set([
  "MiniMaxAI/MiniMax-M2.7",
])

function stripThinkBlocks(text) {
  return text.replace(/<think>[\s\S]*?<\/think>\n*/g, "")
}

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
        if (end === -1) break
        this._buf = this._buf.slice(end + "</think>".length)
        if (this._buf.startsWith("\n")) this._buf = this._buf.slice(1)
        this._inThink = false
      } else {
        const start = this._buf.indexOf("<think>")
        if (start === -1) {
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

// ── Tools sanitizer ─────────────────────────────────────────────────────────

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

// ── System prompt ───────────────────────────────────────────────────────────

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

// ── Token limits ────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 8192
const MAX_RESPONSE_TOKENS = Infinity

function capResponseTokens(body) {
  const requested = Number(body.max_tokens ?? body.max_completion_tokens)
  const value = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_MAX_TOKENS
  body.max_tokens = Math.min(Math.floor(value), MAX_RESPONSE_TOKENS)
  delete body.max_completion_tokens
}

// ── CORS / helpers ──────────────────────────────────────────────────────────

function cors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*")
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, X-Firebase-Token")
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
}

function fail(response, status, message) {
  return response.status(status).json({ error: { message } })
}

// ── Main chat handler ───────────────────────────────────────────────────────

async function chat(request, response, providerId) {
  cors(response)
  if (request.method === "OPTIONS") return response.status(204).end()
  if (request.method !== "POST") return fail(response, 405, "Method not allowed.")

  const { model, messages } = request.body ?? {}
  if (typeof model !== "string" || !model.trim() || !Array.isArray(messages)) {
    return fail(response, 400, "Invalid request: model or messages missing.")
  }

  // Load provider config from Firebase
  let provider
  try {
    provider = await getProviderFromFirebase(providerId)
  } catch (err) {
    console.error(`Firebase provider lookup failed: ${providerId}`, err)
    return fail(response, 503, `Provider ${providerId} lookup failed. Please try again.`)
  }

  if (!provider) {
    return fail(response, 404, `Provider "${providerId}" not found or disabled.`)
  }

  if (!provider.baseUrl) {
    return fail(response, 503, `Provider "${providerId}" has no baseUrl configured.`)
  }

  // API keys — collect all fallback keys for this provider
  const apiKeys = collectApiKeys(providerId)
  if (apiKeys.length === 0) {
    const prefix = `${providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`
    console.error(`Missing API key for provider: ${providerId} (${prefix})`)
    return fail(response, 503, `Provider ${providerId} is not configured. Check API key environment variable: ${prefix}`)
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

  // A stripped-down variant used to recover from 400 Bad Request. Many
  // third-party OpenAI-compatible tunnels/gateways reject optional fields the
  // official OpenAI API tolerates — most commonly `stream_options.include_usage`
  // and an oversized `max_tokens`. When the upstream returns 400, retrying once
  // with this minimal body (no stream_options, capped max_tokens, no tools)
  // turns "model X returned error 400" into a working request. Streaming is
  // preserved so the client contract stays intact.
  function buildMinimalBody() {
    const minimal = { ...body }
    delete minimal.stream_options
    if (typeof minimal.max_tokens === "number") minimal.max_tokens = Math.min(minimal.max_tokens, DEFAULT_MAX_TOKENS)
    // Some gateways reject the tool array if the schema is not supported.
    delete minimal.tools
    delete minimal.tool_choice
    return minimal
  }

  const needsThinkStrip = REASONING_MODEL_IDS.has(model)
  const connectTimeout = setTimeout(() => controller.abort(), 60_000) // 60s timeout untuk model yang lambat

  // ── Try each API key in order, falling through on quota/auth errors.
  // A 400 is retried once with the minimal body before being reported, because
  // it is almost always a field the provider does not accept, not a real model
  // failure. Track whether we already fell back to the minimal body.
  let upstream = null
  let usedKey = null
  let lastRetryStatus = null
  let usedMinimalBody = false

  for (let ki = 0; ki < apiKeys.length; ki += 1) {
    const candidate = apiKeys[ki]
    let res
    try {
      const payload = usedMinimalBody ? buildMinimalBody() : body
      res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${candidate.value}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } catch (err) {
      if (controller.signal.aborted) throw err
      console.error(`Provider ${providerId} key #${candidate.index} network error:`, err.message)
      lastRetryStatus = 502
      if (ki === apiKeys.length - 1) throw err
      continue
    }

    if (res.ok) {
      upstream = res
      usedKey = candidate
      break
    }

    // 400 → the provider rejected the request body. Retry once with the
    // minimal body (still within this same key) before treating it as fatal.
    if (res.status === 400 && !usedMinimalBody) {
      console.warn(
        `Provider ${providerId} | Model: ${model} returned 400 — retrying with minimal body (no stream_options, capped max_tokens).`,
      )
      await res.body?.cancel()
      usedMinimalBody = true
      ki -= 1 // re-run this key with the minimal body
      continue
    }

    // Non-retryable statuses → fail immediately with that status.
    if (!FALLBACK_STATUSES.has(res.status)) {
      const retryAfter = res.headers.get("retry-after") || res.headers.get("retry-after-ms")
      if (retryAfter) response.setHeader("Retry-After", retryAfter)
      console.error(`Provider error: ${providerId} | Model: ${model} | Status: ${res.status} | URL: ${provider.baseUrl} (key #${candidate.index})`)
      await res.body?.cancel()
      if (res.status === 404) return fail(response, 404, `Model "${model}" not found on ${providerId}. Please check the model name.`)
      if (res.status === 503 || res.status === 502) return fail(response, res.status, `Provider ${providerId} is temporarily unavailable. Try another provider or wait a few minutes.`)
      return fail(response, res.status, `Model "${model}" on ${providerId} returned error ${res.status}. Try another model or provider.`)
    }

    // Retryable (401/402/403/429) → try next key if available
    console.warn(`Provider ${providerId} key #${candidate.index} (${candidate.env}) exhausted/busy (${res.status}). Trying next key...`)
    await res.body?.cancel()
    lastRetryStatus = res.status
    if (ki === apiKeys.length - 1) {
      if (res.headers.get("retry-after") || res.headers.get("retry-after-ms")) {
        response.setHeader("Retry-After", res.headers.get("retry-after") || res.headers.get("retry-after-ms"))
      }
      if (res.status === 429) return fail(response, 429, `Semua API key ${providerId} sedang limit (tested ${apiKeys.length} keys). Coba lagi nanti atau tambah key baru.`)
      return fail(response, res.status, `Semua API key ${providerId} gagal (${res.status}) — ${apiKeys.length} keys tested.`)
    }
  }

  if (!upstream) {
    return fail(response, lastRetryStatus || 503, `Provider ${providerId} unavailable — all keys exhausted.`)
  }

  if (usedKey && usedKey.index > 1) {
    console.log(`Provider ${providerId}: fallback succeeded on key #${usedKey.index}`)
  }

  // Success path — forward upstream response to client
  if (!upstream.ok) {
    // Defensive: should already have been handled above
    const retryAfter = upstream.headers.get("retry-after") || upstream.headers.get("retry-after-ms")
    if (retryAfter) response.setHeader("Retry-After", retryAfter)
    await upstream.body?.cancel()
    return fail(response, upstream.status, `Provider ${providerId} returned error ${upstream.status}.`)
  }

  try {
    const contentType = upstream.headers.get("content-type") || "application/json"
    response.status(upstream.status)
    response.setHeader("Content-Type", contentType)
    response.setHeader("X-Accel-Buffering", "no") // Disable nginx buffering for faster streaming
    response.setHeader("Cache-Control", "no-cache") // Prevent caching for real-time responses

    if (!upstream.body) return response.end()

    const isStream = contentType.includes("text/event-stream")

    if (!isStream && needsThinkStrip) {
      const chunks = []
      for await (const chunk of Readable.fromWeb(upstream.body)) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString("utf8")
      return response.end(stripThinkFromJson(raw))
    }

    if (isStream && needsThinkStrip) {
      const stripper = new ThinkStripper()
      Readable.fromWeb(upstream.body).pipe(stripper).pipe(response)
      stripper.once("end", () => { if (!response.writableEnded) response.end() })
      stripper.once("error", () => { if (!response.writableEnded) { response.write("\ndata: [DONE]\n\n"); response.end() } })
      return
    }

    const readable = Readable.fromWeb(upstream.body)
    readable.pipe(response)
    readable.once("end", () => { if (!response.writableEnded) response.end() })
    readable.once("error", () => {
      if (controller.signal.aborted) return
      if (!response.writableEnded) {
        if (isStream) response.write("\ndata: [DONE]\n\n")
        response.end()
      }
    })
    return
  } catch (error) {
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
