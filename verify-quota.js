/* Verify the quotaConfig node via the admin service account (no keys printed). */
const path = require("path")
function loadEnv() {
  for (const line of require("fs").readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m || process.env[m[1]] !== undefined) continue
    let value = m[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    process.env[m[1]] = value
  }
}
loadEnv()
const { getApps, cert, initializeApp } = require("firebase-admin/app")
const app =
  getApps()[0] ||
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  })
;(async () => {
  const token = (await app.options.credential.getAccessToken()).access_token
  const base = app.options.databaseURL.replace(/\/$/, "")
  const res = await fetch(`${base}/agents-code-ai/quotaConfig.json`, { headers: { Authorization: `Bearer ${token}` } })
  console.log("quotaConfig status:", res.status)
  console.log(JSON.stringify(await res.json()))
})().catch((e) => console.error("ERR", e.message))
