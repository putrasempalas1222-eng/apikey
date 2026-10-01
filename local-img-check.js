process.env.NO_COLOR = "1"
for (const line of require("fs").readFileSync("D:/3D POSTER/agents ai/vercel-ai-proxy/.env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) {
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
}
const { chat } = require("D:/3D POSTER/agents ai/vercel-ai-proxy/lib/proxy.js")
const img = require("fs").readFileSync("D:/3D POSTER/agents ai/probe-img-url.txt", "utf8")

async function main() {
  const res = {
    statusCode: 0,
    body: "",
    status(c) { res.statusCode = c; return res },
    setHeader() { return res },
    json(o) { res.body = JSON.stringify(o); return res },
    end(t) { if (t) res.body += t; return res },
    write(t) { res.body += t; return res },
    once() { return res },
    flushHeaders() {},
    on() { return res },
  }
  const req = {
    method: "POST",
    body: {
      model: "Deep-6-Pro",
      stream: false,
      messages: [
        { role: "user", content: [
          { type: "text", text: "Apa isi gambar ini? Satu kalimat singkat." },
          { type: "image_url", image_url: { url: img } },
        ] },
      ],
    },
    on() {},
  }
  req.once = () => req
  await chat(req, res, "abc")
  console.log("STATUS=" + res.statusCode)
  console.log("BODY=" + res.body.slice(0, 400).replace(/\s+/g, " "))
}

main().catch((e) => { console.error("FAIL", e && e.message); process.exitCode = 1 })
