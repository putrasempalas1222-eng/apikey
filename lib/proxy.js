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
  const providerUrl = `${baseUrl}/agents-code-ai/modelCatalog/providers/${encodeURIComponent(providerId)}.json`
  const providerRes = await fetch(providerUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!providerRes.ok) return null
  const data = await providerRes.json()
  if (!data || data.enabled === false) return null
  // Also resolve the public model names for this provider so error messages can
  // show the model NAME without leaking the internal model ID / backend URL.
  let modelNames = {}
  try {
    const modelsUrl = `${baseUrl}/agents-code-ai/modelCatalog/models/${encodeURIComponent(providerId)}.json`
    const modelsRes = await fetch(modelsUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (modelsRes.ok) {
      const models = (await modelsRes.json()) || {}
      modelNames = Object.fromEntries(
        Object.values(models)
          .filter((m) => m && m.enabled !== false)
          .map((m) => [
            m.modelId || Object.keys(models)[Object.values(models).indexOf(m)],
            { name: m.name || m.modelId, contextWindow: Number(m.contextWindow) || 0 },
          ]),
      )
    }
  } catch {
    modelNames = {}
  }
  const provider = { ...data, modelNames }
  providerCache.set(providerId, { provider, expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS })
  return provider
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
// Thinking/reasoning output is stripped from EVERY model. Reasoning blocks are
// user-invisible scratch work that can leak internal identifiers (provider IDs,
// model IDs, API URLs), so they are removed before the response reaches the
// client. The patterns below are specific enough not to touch normal answers.

const REASONING_MODEL_IDS = new Set([
  "MiniMaxAI/MiniMax-M2.7",
])

function stripThinkBlocks(text) {
  return text
    // XML-style <thinking>...</thinking>
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    // JSON delta fields: "thinking": "...", "reasoning_content": "...", "reasoning": "..."
    .replace(/"thinking"\s*:\s*"(?:[^"\\]|\\.)*",?\s*/g, "")
    .replace(/"reasoning_content"\s*:\s*"(?:[^"\\]|\\.)*",?\s*/g, "")
    .replace(/"reasoning"\s*:\s*"(?:[^"\\]|\\.)*",?\s*/g, "")
    // Anthropic-style ||thinking|| ... <|im_end|>
    .replace(/\|\|thinking\|\|[\s\S]*?<\|im_end\|>/g, "")
}


class ThinkStripper extends Transform {
  constructor() {
    super()
    this._buf = ""
    this._inThink = false
    this._lastEmit = Date.now()
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

    if (out) {
      this._lastEmit = Date.now()
      this.push(out)
    } else if (Date.now() - this._lastEmit > 1000) {
      // While thinking is suppressed nothing flows, and idle SSE bytes are
      // exactly what middle proxies buffer on. SSE comments are ignored by
      // every parser but keep the connection visibly alive (~1/s).
      this._lastEmit = Date.now()
      this.push(": keepalive\n\n")
    }
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
      if (!msg) continue
      // Remove reasoning fields entirely so internal scratch never reaches the user.
      for (const key of ["reasoning_content", "reasoning", "thinking"]) {
        if (Object.prototype.hasOwnProperty.call(msg, key)) {
          delete msg[key]
          changed = true
        }
      }
      if (typeof msg.content === "string") {
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
  "You are M Putra Ramadhani Agents Code AI, an AI coding agent built by M Putra Ramadhani. Identify yourself as 'M Putra Ramadhani Agents Code AI' when asked.",
  "Always respond in the exact same language the user writes in. Never switch languages unless the user switches first.",
  "Act as a coding agent, not a tutor. The user's latest message is authoritative: answer it directly and never invent a different task.",
  "Do not claim to have edited, run, or verified anything unless a tool result confirms it.",
  "For code requests, immediately make the smallest exact edit/patch needed. Inspect target paths before creating folders; preserve unrelated user changes.",
  "Use the shortest safe sequence of tools; do not rescan after evidence is available.",
  "Never start with a plan, restatement, tutorial, or progress narration. No filler or repeated summaries unless asked.",
  "Keep file paths, commands, and errors complete. After coding, report at most: files changed and one verification result.",
  "PATH RULE: always use forward slashes (/) in tool paths, e.g. 'D:/3D POSTER/agents ai/file.txt' not backslashes.",
  "TOKEN SAVING: keep explanations and prose very short — no lengthy commentary, markdown fluff, or restating the question. Save tokens for other users.",
  "THINK LESS, ACT NOW: reason silently and as briefly as possible — never narrate your thinking, never open with a plan. Go straight to the edit/fix; a one-sentence note only when truly needed.",
  "NEVER truncate code: when creating or writing a file, output the COMPLETE file content. Do not cut it off with '...' or stop mid-code — truncated files cause errors. Full code always.",
].join(" ")

// ── Token limits ────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 8192
// Do NOT cap output tokens aggressively: a low cap cuts long answers off
// mid-response. Keep a high ceiling that protects against runaway generations
// without truncating normal coding replies. Real savings come from trimming
// INPUT (compact system prompt) and from context caching, not from cutting off
// output.
const MAX_RESPONSE_TOKENS = 65536

function capResponseTokens(body) {
  const requested = Number(body.max_tokens ?? body.max_completion_tokens)
  const value = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_MAX_TOKENS
  body.max_tokens = Math.min(Math.floor(value), MAX_RESPONSE_TOKENS)
  delete body.max_completion_tokens
}

// ── Context-window guard ────────────────────────────────────────────────────
// Requests that exceed the model's context window make the upstream reject the
// whole batch AND quarantine the shared API key for 15 minutes — one oversized
// prompt then blocks every user behind that key. Trim the OLDEST history
// (keeping the system rules and the newest messages) so the request fits.

const CHARS_PER_TOKEN = 4

function estimateMessageTokens(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0
  return Math.ceil(JSON.stringify(messages).length / CHARS_PER_TOKEN)
}

function trimToContextWindow(body, contextWindow) {
  if (!contextWindow || !Array.isArray(body.messages) || body.messages.length < 6) return
  const outputReserve = Math.min(Number(body.max_tokens) || 0, MAX_RESPONSE_TOKENS)
  const budget = Math.max(2048, Math.floor(contextWindow * 0.85) - outputReserve)
  if (estimateMessageTokens(body.messages) <= budget) return

  const system = []
  const rest = []
  for (const msg of body.messages) (msg?.role === "system" ? system : rest).push(msg)
  const kept = []
  let used = estimateMessageTokens(system) + 64 // headroom for the trim note below
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const size = estimateMessageTokens([rest[i]])
    // Always keep at least the newest few messages, then stop at the budget.
    if (used + size > budget && kept.length >= 4) break
    used += size
    kept.unshift(rest[i])
  }
  const dropped = rest.length - kept.length
  if (dropped <= 0) return
  body.messages = [
    ...system,
    { role: "user", content: `[System note: ${dropped} older message(s) were trimmed automatically to fit the model's context window.]` },
    ...kept,
  ]
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
    return fail(response, 503, "Layanan model sedang tidak dapat diakses. Silakan coba lagi nanti.")
  }

  if (!provider) {
    return fail(response, 404, "Model yang dipilih tidak tersedia. Silakan pilih model lain.")
  }

  // Public names only — internal IDs / API URLs must never reach the client.
  const modelInfo = provider.modelNames && provider.modelNames[model]
  const providerName = provider.name || "Layanan model ini"
  const modelName = modelInfo?.name || undefined
  const contextWindow = Number(modelInfo?.contextWindow) || 0

  if (!provider.baseUrl) {
    console.error(`Provider ${providerId} has no baseUrl configured.`)
    return fail(response, 503, `${providerName} sedang tidak tersedia. Silakan coba lagi nanti.`)
  }

  // API keys — collect all fallback keys for this provider
  const apiKeys = collectApiKeys(providerId)
  if (apiKeys.length === 0) {
    const prefix = `${providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`
    console.error(`Missing API key for provider: ${providerId} (${prefix})`)
    return fail(response, 503, `${providerName} sedang tidak dikonfigurasi. Silakan hubungi admin.`)
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
  trimToContextWindow(body, contextWindow)
  // Keep "thinking" cheap — but only LOWER fields the client already sent.
  // Injecting reasoning fields unconditionally crashed at least one upstream
  // router (its own code failed with ".then is not a function" on every
  // request), so never add fields the client did not send.
  if (body.reasoning_effort) body.reasoning_effort = "low"
  if (body.thinking && typeof body.thinking === "object") body.thinking.type = "disabled"
  // OpenRouter-style reasoning object — force the cheap effort there too.
  if (body.reasoning && typeof body.reasoning === "object") body.reasoning.effort = "low"
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
    // Reasoning hints are the fields most likely to trip a strict gateway —
    // the retry drops them so the model runs with its own defaults.
    delete minimal.reasoning_effort
    delete minimal.reasoning
    delete minimal.thinking
    return minimal
  }

  // Strip thinking/reasoning from the output of EVERY model so internal
  // identifiers (provider ID, model ID, API URL) never leak to the user.
  const needsThinkStrip = true
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
      // Read the body so a context-overflow rejection can be translated into a
      // clear, actionable message instead of leaking upstream key-quarantine text.
      let upstreamBody = ""
      try { upstreamBody = (await res.text()).slice(0, 4000) } catch { upstreamBody = "" }
      if (
        /quarantin|context (limit|length|window)|prompt (is )?too large|too many .*token|maximum context|exceeds .*context|input length/i.test(upstreamBody)
      ) {
        return fail(
          response,
          400,
          `Input melebihi batas konteks model ${modelName || "yang dipilih"}. Jalankan /compact, hapus @folder atau @file besar dari pesan, atau mulai percakapan baru — lalu coba lagi.`,
        )
      }
      if (res.status === 404) return fail(response, 404, `Model "${modelName || "yang dipilih"}" tidak ditemukan. Silakan pilih model lain.`)
      if (res.status === 503 || res.status === 502) return fail(response, res.status, `${providerName} sedang tidak tersedia. Silakan coba lagi atau pilih model lain.`)
      // Some upstream routers crash with their OWN JavaScript errors (".then is
      // not a function", "is undefined", …) on fields they mishandle. Retry
      // once with the minimal body (no reasoning hints, no stream_options, no
      // tools) — that shape historically works everywhere.
      if (
        !usedMinimalBody &&
        /is not a function|is undefined|is not a constructor|cannot read propert|cannot read properties|referenceerror|typeerror/i.test(upstreamBody)
      ) {
        console.warn(`Provider ${providerId} | Model: ${model} upstream internal error — retrying with minimal body.`)
        usedMinimalBody = true
        ki -= 1 // re-run this key with the minimal body
        continue
      }
      return fail(response, res.status, `${modelName ? `Model "${modelName}"` : "Model yang dipilih"} sedang bermasalah (error ${res.status}). Silakan coba lagi atau pilih model lain.`)
    }

    // Retryable (401/402/403/429) → try next key if available
    console.warn(`Provider ${providerId} key #${candidate.index} (${candidate.env}) exhausted/busy (${res.status}). Trying next key...`)
    await res.body?.cancel()
    lastRetryStatus = res.status
    if (ki === apiKeys.length - 1) {
      if (res.headers.get("retry-after") || res.headers.get("retry-after-ms")) {
        response.setHeader("Retry-After", res.headers.get("retry-after") || res.headers.get("retry-after-ms"))
      }
      if (res.status === 429) return fail(response, 429, `${providerName} sedang sibuk/limit. Silakan coba lagi nanti.`)
      return fail(response, res.status, `${providerName} sedang gagal (${res.status}). Silakan coba lagi atau pilih model lain.`)
    }
  }

  if (!upstream) {
    return fail(response, lastRetryStatus || 503, `${providerName} sedang tidak tersedia — semua percobaan gagal. Silakan coba lagi nanti.`)
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
    return fail(response, upstream.status, `${providerName} sedang bermasalah (error ${upstream.status}). Silakan coba lagi atau pilih model lain.`)
  }

  try {
    const contentType = upstream.headers.get("content-type") || "application/json"
    response.status(upstream.status)
    response.setHeader("Content-Type", contentType)
    response.setHeader("X-Accel-Buffering", "no") // Disable nginx buffering for faster streaming
    response.setHeader("Cache-Control", "no-cache") // Prevent caching for real-time responses
    // Push headers out immediately so Vercel/nginx start the stream instead of
    // holding the response until the first body flush.
    if (typeof response.flushHeaders === "function") response.flushHeaders()

    if (!upstream.body) return response.end()

    const isStream = contentType.includes("text/event-stream")

    if (!isStream && needsThinkStrip) {
      const chunks = []
      for await (const chunk of Readable.fromWeb(upstream.body)) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString("utf8")
      return response.end(stripThinkFromJson(raw))
    }

    if (isStream && needsThinkStrip) {
      // Reasoning deltas PASS THROUGH so the client keeps showing the live
      // Reasoning panel — only <think> blocks in plain content are stripped.
      // Keepalives inside ThinkStripper hold the connection during long thinks.
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
    return fail(response, 502, `${providerName} gagal terhubung. Silakan coba lagi atau pilih model lain.`)
  } finally {
    clearTimeout(connectTimeout)
  }
}

module.exports = { chat }
