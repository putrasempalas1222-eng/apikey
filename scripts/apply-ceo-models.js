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

const ceoModels = {
  "claude-haiku-4_5": {
    modelId: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    enabled: true,
    free: true,
    reasoning: true,
    contextWindow: 200000,
    description: "Fast and intelligent Claude Haiku 4.5 via CEO AI."
  },
  "deepseek-v4-flash": {
    modelId: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    enabled: true,
    free: true,
    reasoning: true,
    contextWindow: 128000,
    description: "High performance DeepSeek V4 Flash via CEO AI."
  },
  "gemini-2_5-flash": {
    modelId: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    enabled: true,
    free: true,
    reasoning: false,
    contextWindow: 1000000,
    description: "Fast Google Gemini 2.5 Flash via CEO AI."
  },
  "gemini-3_5-flash-lite": {
    modelId: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    enabled: true,
    free: true,
    reasoning: false,
    contextWindow: 128000,
    description: "Lightweight Gemini 3.5 Flash Lite via CEO AI."
  },
  "gpt-4_1": {
    modelId: "gpt-4.1",
    name: "GPT-4.1",
    enabled: true,
    free: true,
    reasoning: true,
    contextWindow: 128000,
    description: "Next generation OpenAI GPT-4.1 via CEO AI."
  },
  "gpt-4_1-mini": {
    modelId: "gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    enabled: true,
    free: true,
    reasoning: false,
    contextWindow: 128000,
    description: "Efficient and cost-effective GPT-4.1 Mini via CEO AI."
  },
  "gpt-4_1-nano": {
    modelId: "gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    enabled: true,
    free: true,
    reasoning: false,
    contextWindow: 128000,
    description: "Ultra fast GPT-4.1 Nano via CEO AI."
  },
  "gpt-4o-mini": {
    modelId: "gpt-4o-mini",
    name: "GPT-4o Mini",
    enabled: true,
    free: true,
    reasoning: false,
    contextWindow: 128000,
    description: "Fast and lightweight GPT-4o Mini via CEO AI."
  },
  "gpt-4o": {
    modelId: "gpt-4o-2024-11-20",
    name: "GPT-4o",
    enabled: true,
    free: false,
    reasoning: false,
    contextWindow: 128000,
    description: "Flagship OpenAI GPT-4o via CEO AI."
  },
  "gpt-5": {
    modelId: "gpt-5",
    name: "GPT-5",
    enabled: true,
    free: false,
    reasoning: true,
    contextWindow: 256000,
    description: "State-of-the-art OpenAI GPT-5 via CEO AI."
  },
  "gpt-5-mini": {
    modelId: "gpt-5-mini",
    name: "GPT-5 Mini",
    enabled: true,
    free: true,
    reasoning: true,
    contextWindow: 128000,
    description: "Compact GPT-5 Mini via CEO AI."
  },
  "gpt-5-nano": {
    modelId: "gpt-5-nano",
    name: "GPT-5 Nano",
    enabled: true,
    free: true,
    reasoning: false,
    contextWindow: 128000,
    description: "Ultra lightweight GPT-5 Nano via CEO AI."
  },
  "kimi-k2_5": {
    modelId: "kimi-k2.5",
    name: "Kimi K2.5",
    enabled: true,
    free: true,
    reasoning: true,
    contextWindow: 200000,
    description: "Moonshot Kimi K2.5 long context model via CEO AI."
  },
  "minimax-m2_5": {
    modelId: "minimax-m2.5",
    name: "MiniMax M2.5",
    enabled: true,
    free: true,
    reasoning: true,
    contextWindow: 1000000,
    description: "MiniMax M2.5 with 1M context via CEO AI."
  },
  "qwen3_6-flash": {
    modelId: "qwen3.6-flash",
    name: "Qwen 3.6 Flash",
    enabled: true,
    free: true,
    reasoning: true,
    contextWindow: 128000,
    description: "Qwen 3.6 Flash fast reasoning model via CEO AI."
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
  catalog.providers.ceo = {
    name: "CEO AI",
    enabled: true,
    baseUrl: "https://dashboard.ceoweb3.dev/v1",
    protocol: "openai-compatible"
  }

  // Set models
  catalog.models = catalog.models || {}
  catalog.models.ceo = ceoModels

  // 2. Save back to Firebase
  const putRes = await fetch(`${baseUrl}/agents-code-ai/modelCatalog.json`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(catalog)
  })
  console.log("Updated CEO models in Firebase RTDB status:", putRes.status)

  // 3. Write local JSON file
  fs.writeFileSync(
    path.resolve(__dirname, "../../firebase-ceo-model-catalog.json"),
    JSON.stringify({ providers: { ceo: catalog.providers.ceo }, models: { ceo: ceoModels } }, null, 2)
  )
  console.log("Wrote firebase-ceo-model-catalog.json")
}

main().catch(console.error)
