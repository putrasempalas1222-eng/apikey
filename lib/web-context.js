// Web grounding for chat requests.
//
// 1. URL fetch: when the user's latest message contains a link, fetch the page
//    server-side and inject its readable text into the message so the model
//    discusses the real page. Preferred fetcher: the 9Router web-fetch endpoint
//    (same key as the abc provider); fallback: direct fetch (always works).
// 2. Web search: when the user asks to look something up, query the 9Router
//    search endpoint and inject the top results — plus the CONTENT of the top
//    result pages, so the agent gets broad, ready-to-use context.
//
// Everything here is best-effort: any failure silently skips the injection.

const WEB_SEARCH_URL = process.env.WEB_SEARCH_URL || "http://203.194.114.5:20128/v1/search"
const WEB_SEARCH_PROVIDER = process.env.WEB_SEARCH_PROVIDER || "ollama"
const WEB_FETCH_URL = process.env.WEB_FETCH_URL || "http://203.194.114.5:20128/v1/web/fetch"
const WEB_FETCH_PROVIDER = process.env.WEB_FETCH_PROVIDER || "ollama"
const WEB_FETCH_TIMEOUT_MS = 12000
const WEB_CONTEXT_MAX_CHARS = 12000
const SEARCH_PAGE_MAX_CHARS = 8000
const MAX_PAGES = 2
const MAX_SEARCH_PAGES = 2

const URL_RE = /https?:\/\/[^\s<>"')\]]+/
const URL_RE_G = /https?:\/\/[^\s<>"')\]]+/g
const SEARCH_INTENT_RE = /\b(cari|carikan|search|searching|googling|google it|di internet|di web|berita|trending|terbaru|kabar)\b/i

function messageText(message) {
  if (!message) return ""
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join(" ")
  }
  return ""
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|table|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Preferred fetcher: the 9Router web-fetch endpoint (provider-configurable). */
async function routerFetchPage(url, apiKeys) {
  const key = apiKeys && apiKeys[0] && apiKeys[0].value
  if (!key) return null
  try {
    const res = await fetchWithTimeout(WEB_FETCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ url, provider: WEB_FETCH_PROVIDER }),
    })
    if (!res.ok) return null
    const data = await res.json()
    let content = typeof data === "string" ? data : data.content ?? data.text ?? data.html ?? data.data
    if (typeof content !== "string" || content.length < 80) return null
    // HTML payloads get the same cleanup as direct fetches.
    const cleaned = /<[a-z]/i.test(content.slice(0, 200)) ? htmlToText(content) : String(content).replace(/\s+/g, " ").trim()
    if (cleaned.length < 80) return null
    return cleaned.slice(0, WEB_CONTEXT_MAX_CHARS)
  } catch {
    return null
  }
}

/** Direct fetcher — the always-available fallback. */
async function fetchPageText(url) {
  try {
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AgentsCodeAI/1.0; +web preview)" },
      redirect: "follow",
    })
    if (!res.ok) return null
    const type = res.headers.get("content-type") || ""
    let text = ""
    if (type.includes("application/json")) {
      text = JSON.stringify(await res.json())
    } else {
      text = htmlToText(await res.text())
    }
    if (text.length < 80) return null
    return text.slice(0, WEB_CONTEXT_MAX_CHARS)
  } catch {
    return null
  }
}

/** Router fetch first, direct fetch as guaranteed fallback. */
async function fetchPage(url, apiKeys) {
  return (await routerFetchPage(url, apiKeys)) || (await fetchPageText(url))
}

async function routerSearch(query, apiKeys) {
  const key = apiKeys && apiKeys[0] && apiKeys[0].value
  if (!key) return null
  try {
    const res = await fetchWithTimeout(WEB_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ provider: WEB_SEARCH_PROVIDER, query: query.slice(0, 300), max_results: 5 }),
    })
    if (!res.ok) return null
    const data = await res.json()
    if (Array.isArray(data)) return data
    if (Array.isArray(data.results)) return data.results
    if (Array.isArray(data.data)) return data.data
    return null
  } catch {
    return null
  }
}

function injectUserBlock(body, content) {
  if (!Array.isArray(body.messages)) return
  // Append to the LAST user message — some routers keep only the first system
  // message, so a separate system block can silently never reach the model.
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    const msg = body.messages[i]
    if (!msg || msg.role !== "user") continue
    if (typeof msg.content === "string") {
      msg.content = msg.content + "\n\n" + content
    } else if (Array.isArray(msg.content)) {
      msg.content.push({ type: "text", text: content })
    } else {
      msg.content = content
    }
    return
  }
}

/** Fetch pages for URLs found in the latest user message. */
async function injectWebContext(body, apiKeys) {
  try {
    if (!Array.isArray(body.messages)) return
    const lastUser = [...body.messages].reverse().find((m) => m && m.role === "user")
    const text = messageText(lastUser)
    const urls = [...new Set(text.match(URL_RE_G) || [])].slice(0, MAX_PAGES)
    if (urls.length === 0) return
    const blocks = []
    for (const url of urls) {
      const page = await fetchPage(url, apiKeys)
      if (page) blocks.push("[Web page content — " + url + "] The full page has ALREADY been fetched for you; treat it as retrieved and discuss it directly. Never say you cannot browse.\n" + page)
    }
    if (blocks.length > 0) {
      injectUserBlock(body, blocks.join("\n\n"))
    }
  } catch {
    // Grounding is best-effort; never block the chat.
  }
}

/**
 * Search, then fetch the top result pages so the agent gets broad,
 * ready-to-use context — the "web agent" behaviour.
 */
async function injectSearchResults(body, apiKeys) {
  try {
    if (!Array.isArray(body.messages)) return
    const lastUser = [...body.messages].reverse().find((m) => m && m.role === "user")
    const text = messageText(lastUser)
    // A link in the message means the page-fetch path handles grounding.
    if (!text || URL_RE.test(text) || !SEARCH_INTENT_RE.test(text)) return
    const results = await routerSearch(text, apiKeys)
    if (!results || results.length === 0) return
    const lines = results
      .map((r) => {
        const url = r.url || r.link || ""
        const title = r.title || url
        const snippet = String(r.content || r.snippet || r.description || "").replace(/\s+/g, " ").slice(0, 400)
        return "- " + title + (url ? "\n  " + url : "") + (snippet ? "\n  " + snippet : "")
      })
      .filter((line) => line.trim() !== "-")
      .join("\n")
    if (!lines) return
    let block = "[Web search results — query: " + text.slice(0, 150) + "] These results have ALREADY been fetched for you; use them directly. Never say you cannot search.\n" + lines
    // Deepen: fetch the top result pages so the answer can go beyond snippets.
    const pageUrls = results.map((r) => r.url || r.link || "").filter((u) => URL_RE.test(u)).slice(0, MAX_SEARCH_PAGES)
    for (const url of pageUrls) {
      const page = await fetchPage(url, apiKeys)
      if (page) block += "\n\n[Web page content — " + url + "]\n" + page.slice(0, SEARCH_PAGE_MAX_CHARS)
    }
    injectUserBlock(body, block)
  } catch {
    // Search is best-effort; never block the chat.
  }
}

module.exports = { injectWebContext, injectSearchResults, htmlToText, fetchPageText, routerFetchPage, routerSearch }
