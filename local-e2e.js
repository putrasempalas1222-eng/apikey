/**
 * Local end-to-end test: boot the REAL chat() handler on localhost with .env,
 * then hit it like the extension would. 200 OK = the update is safe.
 * Does not print any secret.
 */
const http = require("http")

// Load .env into process.env; strip surrounding quotes like Vercel would not have.
for (const line of require("fs").readFileSync("D:/3D POSTER/agents ai/vercel-ai-proxy/.env", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) {
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
}

const { chat } = require("D:/3D POSTER/agents ai/vercel-ai-proxy/lib/proxy.js")

const server = http.createServer((req, res) => {
  // Vercel-style response helpers the handler expects.
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)) }
  let raw = ""
  req.on("data", (c) => (raw += c))
  req.on("end", () => {
    try { req.body = JSON.parse(raw || "{}") } catch { req.body = {} }
    chat(req, res, "abc").catch((e) => {
      console.error("[handler escape]", e.message)
      if (!res.writableEnded) { res.statusCode = 502; res.end(JSON.stringify({ error: { message: "escaped" } })) }
    })
  })
})

function post(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const req = http.request(
      { host: "127.0.0.1", port: 3111, path: "/api/v1/abc/chat/completions", method: "POST", timeout: 90000 },
      (res) => {
        let body = ""
        res.on("data", (c) => (body += c))
        res.on("end", () => {
          let content = ""
          try {
            const j = JSON.parse(body)
            content = j.choices?.[0]?.message?.content ?? j.error?.message ?? ""
            content = String(content).replace(/<think>[\s\S]*?<\/think>/g, "").replace(/\s+/g, " ").trim().slice(0, 130)
          } catch { content = body.slice(0, 130) }
          resolve("HTTP " + res.statusCode + " :: " + content)
        })
      },
    )
    req.on("error", reject)
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")) })
    req.setHeader("Content-Type", "application/json")
    req.setHeader("Content-Length", Buffer.byteLength(data))
    req.write(data)
    req.end()
  })
}

server.listen(3111, "127.0.0.1", async () => {
  console.log("local proxy up")
  console.log("1 plain   ->", await post({ model: "Deep-6-Pro", stream: false, messages: [{ role: "user", content: "Reply with exactly: OK" }] }))
  console.log("2 link    ->", await post({ model: "Deep-6-Pro", stream: false, messages: [{ role: "user", content: "Bahas singkat isi halaman ini ya https://nodejs.org/en/learn" }] }))
  console.log("3 search  ->", await post({ model: "Deep-6-Pro", stream: false, messages: [{ role: "user", content: "Cari berita terbaru tentang Node.js rilis minggu ini" }] }))
  server.close()
  process.exit(0)
})
