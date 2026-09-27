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

const dahlProvider = {
  name: "Dahl Global",
  enabled: true,
  baseUrl: "https://inference.dahl.global/v1",
  protocol: "openai-compatible"
}

const dahlModels = {
  "minimax-m2_7": {
    modelId: "MiniMaxAI/MiniMax-M2.7",
    name: "MiniMax M2.7",
    enabled: true,
    free: true,
    reasoning: true,
    contextWindow: 1000000,
    maxOutput: 8000,
    description: "MiniMax M2.7 flagship model via Dahl Global."
  },
      "deepseek-v4-flash-0731": {
    modelId: "deepseek-ai/DeepSeek-V4-Flash-0731",
    name: "DeepSeek V4 Flash",
    enabled: false,
    free: true,
    reasoning: false,
    contextWindow: 128000,
    maxOutput: 8000,
    description: "High performance DeepSeek V4 Flash via Dahl Global."
  },
  "glm-5_3-flash": {
    modelId: "zai-org/GLM-5.3-Flash",
    name: "GLM 5.3 Flash",
    enabled: true,
    free: true,
    reasoning: false,
    contextWindow: 128000,
    maxOutput: 8000,
    description: "GLM 5.3 Flash multilingual reasoning model via Dahl Global."
  }
}

async function main() {
  const app = firebaseApp()
  const baseUrl = app.options.databaseURL.replace(/\/$/, "")
  const accessToken = (await app.options.credential.getAccessToken()).access_token

  // 1. Fetch current catalog
  const getRes = await fetch(`${baseUrl}/agents-code-ai/modelCatalog.json`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const catalog = (await getRes.json()) || { providers: {}, models: {} }

  // Set provider
  catalog.providers = catalog.providers || {}
  catalog.providers.dahl = dahlProvider

  // Set models
  catalog.models = catalog.models || {}
  catalog.models.dahl = dahlModels

  // 2. Save back to Firebase RTDB
  const putRes = await fetch(`${baseUrl}/agents-code-ai/modelCatalog.json`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(catalog)
  })
  console.log("Updated Dahl models in Firebase RTDB status:", putRes.status)

  // 3. Write local JSON file
  fs.writeFileSync(
    path.resolve(__dirname, "../../firebase-dahl-model-catalog.json"),
    JSON.stringify({ providers: { dahl: dahlProvider }, models: { dahl: dahlModels } }, null, 2)
  )
  console.log("Wrote firebase-dahl-model-catalog.json")
}

main().catch(console.error)
