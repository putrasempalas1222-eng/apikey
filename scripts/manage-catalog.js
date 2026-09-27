const fs = require("fs")
const path = require("path")

// Load .env from vercel-ai-proxy/.env
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
  const catalog = await getRes.json()
  console.log("Current Catalog:", JSON.stringify(catalog, null, 2))

  // 2. Disable bacrot provider and all its models
  if (catalog && catalog.providers && catalog.providers.bacrot) {
    catalog.providers.bacrot.enabled = false
  }
  if (catalog && catalog.models && catalog.models.bacrot) {
    for (const modelKey of Object.keys(catalog.models.bacrot)) {
      catalog.models.bacrot[modelKey].enabled = false
    }
  }

  // 3. Save back to Firebase
  const putRes = await fetch(`${baseUrl}/agents-code-ai/modelCatalog.json`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(catalog)
  })
  console.log("Updated Catalog in Firebase status:", putRes.status)
}

main().catch(console.error)
