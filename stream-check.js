/** Stream integrity test: every data line parses as JSON; no model ids leak;
 *  keepalive comments only ever appear on their own lines. */
const http = require("http")

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
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (obj) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)) }
  let raw = ""
  req.on("data", (c) => (raw += c))
  req.on("end", () => {
    try { req.body = JSON.parse(raw || "{}") } catch { req.body = {} }
    chat(req, res, "abc").catch((e) => console.error("[escape]", e.message))
  })
})

server.listen(3113, "127.0.0.1", () => {
  const data = JSON.stringify({
    model: "Deep-6-Pro",
    stream: true,
    messages: [{ role: "user", content: "Bahas singkat isi halaman ini ya https://nodejs.org/en/learn" }],
  })
  const req = http.request({ host: "127.0.0.1", port: 3113, path: "/api/v1/abc/chat/completions", method: "POST", timeout: 120000 }, (res) => {
    let buf = ""
    let dataLines = 0, badJson = 0, idLeaks = 0, midLineKeepalive = 0, done = false
    res.on("data", (c) => {
      buf += c.toString()
      let idx
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, "")
        buf = buf.slice(idx + 1)
        if (line.startsWith("data:")) {
          dataLines++
          const payload = line.slice(5).trim()
          if (payload && payload !== "[DONE]") {
            try {
              const j = JSON.parse(payload)
              if (j.model && /agnes|deepseek|glm|minimax|cbai|cmb-/i.test(j.model)) idLeaks++
            } catch { badJson++ }
          }
        } else if (line.includes(": keepalive") && !line.startsWith(":")) {
          midLineKeepalive++
        }
        if (line.includes("[DONE]")) done = true
      }
    })
    res.on("end", () => {
      console.log("status:", res.statusCode)
      console.log("data lines:", dataLines, "| bad JSON:", badJson, "| id leaks:", idLeaks, "| mid-line keepalive:", midLineKeepalive, "| done:", done)
      const verdict = res.statusCode === 200 && badJson === 0 && idLeaks === 0 && midLineKeepalive === 0 && done
      console.log(verdict ? "STREAM_OK" : "STREAM_FAIL")
      server.close()
      process.exit(verdict ? 0 : 1)
    })
  })
  req.on("error", (e) => { console.log("ERR", e.message); process.exit(1) })
  req.setHeader("Content-Type", "application/json")
  req.setHeader("Content-Length", Buffer.byteLength(data))
  req.write(data)
  req.end()
})
