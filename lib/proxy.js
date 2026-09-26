const { Readable, Transform } = require("node:stream")
const { requireUser, reserveTokens, settleReservation } = require("./firebase")

const PROVIDERS = {
  atria: { baseUrl: "https://api.atria-asi.ai/v1", secret: "ATRIA_API_KEY" },
  ceo: { baseUrl: "https://dashboard.ceoweb3.dev/v1", secret: "CEO_API_KEY" },
  bacrot: { baseUrl: "https://bacrot.my.id/v1", secret: "BACROT_API_KEY" },
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

function outputTokensFromResponse(text) {
  const match = text.match(/"(?:completion_tokens|output_tokens)"\s*:\s*(\d+)/)
  if (match) return Number(match[1])
  // Some compatible streaming APIs omit final usage. Estimate from streamed
  // delta text so users are not charged the full output reservation.
  const fragments = [...text.matchAll(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/g)]
  if (!fragments.length) return undefined
  const characters = fragments.reduce((total, fragment) => {
    try {
      return total + JSON.parse(`"${fragment[1]}"`).length
    } catch {
      return total + fragment[1].length
    }
  }, 0)
  return Math.ceil(characters / 4)
}

function relayStream(upstream, response, reservation) {
  let captured = ""
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      // Usage is normally supplied in the final SSE event. Keep a bounded
      // sample so a malformed upstream cannot exhaust function memory.
      if (captured.length < 512_000) captured += chunk.toString("utf8")
      callback(null, chunk)
    },
    flush(callback) {
      settleReservation(reservation, outputTokensFromResponse(captured))
        .catch((error) => console.error("Usage settlement failed", error))
        .finally(() => callback())
    },
  })
  Readable.fromWeb(upstream.body).pipe(meter).pipe(response)
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

  let reservation
  try {
    const user = await requireUser(request)
    const requested = typeof request.body?.max_tokens === "number" ? Math.floor(request.body.max_tokens) : 900
    reservation = await reserveTokens(user.uid, Math.max(128, Math.min(requested, 1200)))
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : 503
    return fail(response, status, status === 402 ? error.message : "Sign in is required to use this model.")
  }

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
      await settleReservation(reservation, 0)
      return fail(response, upstream.status, "Selected model is temporarily unavailable.")
    }
    response.status(upstream.status)
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json")
    if (upstream.body) return relayStream(upstream, response, reservation)
    await settleReservation(reservation, 0)
    return response.end()
  } catch (error) {
    if (controller.signal.aborted) {
      await settleReservation(reservation, 0)
      return response.end()
    }
    await settleReservation(reservation, 0)
    console.error("Provider proxy request failed", error)
    return fail(response, 502, "Selected model is temporarily unavailable.")
  }
}

module.exports = { chat }
