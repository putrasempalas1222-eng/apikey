const fs = require("fs")
const path = require("path")

// Load .env
const envPath = path.resolve(__dirname, "../.env")
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf8")
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim()
      let val = trimmed.slice(eqIdx + 1).trim()
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1).replace(/\\n/g, "\n")
      }
      process.env[key] = val
    }
  }
}

const { firebaseApp } = require("../lib/firebase")

async function main() {
  const app = firebaseApp()
  const baseUrl = app.options.databaseURL.replace(/\/$/, "")
  const accessToken = (await app.options.credential.getAccessToken()).access_token

  // 1. Fetch current catalog
  const getRes = await fetch(`${baseUrl}/agents-code-ai/modelCatalog.json`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const catalog = (await getRes.json()) || { providers: {}, models: {} }

  // Set CEO provider enabled: false
  if (catalog.providers && catalog.providers.ceo) {
    catalog.providers.ceo.enabled = false
  }

  // Set all CEO models enabled: false
  if (catalog.models && catalog.models.ceo) {
    for (const key of Object.keys(catalog.models.ceo)) {
      catalog.models.ceo[key].enabled = false
    }
  }

  // 2. Save back to Firebase RTDB
  const putRes = await fetch(`${baseUrl}/agents-code-ai/modelCatalog.json`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(catalog)
  })
  console.log("Updated Firebase modelCatalog (disabled CEO) status:", putRes.status)

  // 3. Update local JSON file firebase-ceo-model-catalog.json with enabled: false (saved for later)
  const jsonPath = path.resolve(__dirname, "../../firebase-ceo-model-catalog.json")
  if (fs.existsSync(jsonPath)) {
    const local = JSON.parse(fs.readFileSync(jsonPath, "utf8"))
    if (local.providers && local.providers.ceo) {
      local.providers.ceo.enabled = false
    }
    if (local.models && local.models.ceo) {
      for (const k of Object.keys(local.models.ceo)) {
        local.models.ceo[k].enabled = false
      }
    }
    fs.writeFileSync(jsonPath, JSON.stringify(local, null, 2))
    console.log("Updated firebase-ceo-model-catalog.json (saved with enabled: false)")
  }
}

main().catch(console.error)
