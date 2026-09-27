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

const codeCraftProvider = {
  name: "CodeCraft API",
  enabled: true,
  baseUrl: "https://codecraftapi.com/v1",
  protocol: "openai-compatible"
}

const codeCraftModels = {
  "muse-spark-1-1": { modelId: "muse-spark-1.1", name: "Muse Spark 1.1", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Meta Muse Spark series. Fast and capable with strong reasoning scores." },
  "gemma-2-2b": { modelId: "gemma-2-2b", name: "Gemma 2 2B", enabled: true, free: false, reasoning: false, contextWindow: 8192, maxOutput: 8192, description: "Lightweight open model by Google. Fast and efficient for everyday tasks." },
  "gpt-5-6-sol": { modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol", enabled: true, free: false, reasoning: true, contextWindow: 1050000, maxOutput: 16000, description: "OpenAI flagship model. Top-tier reasoning, coding, and agentic capability." },
  "claude-opus-5": { modelId: "claude-opus-5", name: "Claude Opus 5", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Anthropic most capable model. Exceptional reasoning and agentic performance." },
  "claude-fable-5": { modelId: "claude-fable-5", name: "Claude Fable 5", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Anthropic premium model. Outstanding coding and reasoning with top Code Arena score." },
  "claude-mythos-preview": { modelId: "claude-mythos-preview", name: "Claude Mythos Preview", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Anthropic next-gen preview model. Cutting-edge reasoning, not yet generally released." },
  "kimi-k3": { modelId: "kimi-k3", name: "Kimi K3", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Moonshot AI open-source flagship. Strong reasoning and coding, 2.8T params." },
  "glm-5-3": { modelId: "glm-5.3", name: "GLM-5.3", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Zhipu AI latest model. Strong reasoning and agentic capability, 753B params." },
  "deepseek-v4-pro-0813": { modelId: "deepseek-v4-pro-0813", name: "DeepSeek-V4-Pro-0813", enabled: true, free: false, reasoning: true, contextWindow: 1048576, maxOutput: 16000, description: "DeepSeek open-source pro model. Excellent reasoning and coding, 1.6T params." },
  "qwen3-8-max": { modelId: "qwen3.8-max", name: "Qwen3.8 Max", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Alibaba Qwen flagship open model. Strong all-round capability, 2.4T params." },
  "gpt-5-6-terra": { modelId: "gpt-5.6-terra", name: "GPT-5.6 Terra", enabled: true, free: false, reasoning: true, contextWindow: 1050000, maxOutput: 16000, description: "OpenAI high-end model. Strong reasoning and coding at a mid price point." },
  "claude-opus-4-8": { modelId: "claude-opus-4.8", name: "Claude Opus 4.8", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Anthropic Opus-class model. Reliable reasoning and coding performance." },
  "gemini-3-7-flash": { modelId: "gemini-3.7-flash", name: "Gemini 3.7 Flash", enabled: true, free: false, reasoning: true, contextWindow: 1048576, maxOutput: 16000, description: "Google latest Flash model. Very fast with strong reasoning." },
  "claude-sonnet-5": { modelId: "claude-sonnet-5", name: "Claude Sonnet 5", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Anthropic balanced model. Great coding and reasoning at a lower cost." },
  "gpt-5-5": { modelId: "gpt-5.5", name: "GPT-5.5", enabled: true, free: false, reasoning: true, contextWindow: 1050000, maxOutput: 16000, description: "OpenAI capable model. Solid reasoning and coding performance." },
  "grok-4-5": { modelId: "grok-4.5", name: "Grok 4.5", enabled: true, free: false, reasoning: true, contextWindow: 500000, maxOutput: 16000, description: "xAI model. Strong reasoning and agentic capability." },
  "deepseek-v4-flash-0731": { modelId: "deepseek-v4-flash-0731", name: "DeepSeek-V4-Flash-0731", enabled: true, free: false, reasoning: true, contextWindow: 1048576, maxOutput: 16000, description: "DeepSeek fast open model. Very affordable with solid reasoning, 304B params." },
  "grok-4-6": { modelId: "grok-4.6", name: "Grok 4.6", enabled: true, free: false, reasoning: true, contextWindow: 500000, maxOutput: 16000, description: "xAI latest model. Improved reasoning and coding over 4.5." },
  "seed-2-1-pro": { modelId: "seed-2.1-pro", name: "Seed 2.1 Pro", enabled: true, free: false, reasoning: true, contextWindow: 262144, maxOutput: 16000, description: "ByteDance Seed series pro model. Strong reasoning and coding." },
  "glm-5-2": { modelId: "glm-5.2", name: "GLM-5.2", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Zhipu AI open model. Good reasoning and coding, 753B params." },
  "qwen3-8-27b": { modelId: "qwen3.8-27b", name: "Qwen3.8-27B", enabled: true, free: false, reasoning: true, contextWindow: 262144, maxOutput: 16000, description: "Alibaba Qwen compact open model. Efficient 27.8B params with solid capability." },
  "gpt-5-6-luna": { modelId: "gpt-5.6-luna", name: "GPT-5.6 Luna", enabled: true, free: false, reasoning: true, contextWindow: 1050000, maxOutput: 16000, description: "OpenAI efficient model. Great value with strong reasoning." },
  "qwen3-7-max": { modelId: "qwen3.7-max", name: "Qwen3.7 Max", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Alibaba Qwen pro model. Strong reasoning and coding performance." },
  "claude-opus-4-6": { modelId: "claude-opus-4.6", name: "Claude Opus 4.6", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Anthropic Opus-class model. Reliable reasoning and agentic performance." },
  "gpt-5-5-pro": { modelId: "gpt-5.5-pro", name: "GPT-5.5 Pro", enabled: true, free: false, reasoning: true, contextWindow: 1050000, maxOutput: 16000, description: "OpenAI pro-tier model. Enhanced reasoning and coding over base 5.5." },
  "claude-opus-4-7": { modelId: "claude-opus-4.7", name: "Claude Opus 4.7", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Anthropic Opus-class model. Strong coding and reasoning, high Code Arena score." },
  "gemini-3-6-flash": { modelId: "gemini-3.6-flash", name: "Gemini 3.6 Flash", enabled: true, free: false, reasoning: true, contextWindow: 1048576, maxOutput: 16000, description: "Google fast model. Very quick responses with good reasoning." },
  "kimi-k2-6": { modelId: "kimi-k2.6", name: "Kimi K2.6", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Moonshot AI open model. Strong reasoning and coding, 1.0T params." },
  "seed-2-1-turbo": { modelId: "seed-2.1-turbo", name: "Seed 2.1 Turbo", enabled: true, free: false, reasoning: true, contextWindow: 262144, maxOutput: 16000, description: "ByteDance Seed turbo model. Fast with solid reasoning and coding." },
  "gemini-3-1-pro": { modelId: "gemini-3.1-pro", name: "Gemini 3.1 Pro", enabled: true, free: false, reasoning: true, contextWindow: 1048576, maxOutput: 16000, description: "Google pro model. Strong reasoning and coding with high Code Arena score." },
  "deepseek-v4-pro-max": { modelId: "deepseek-v4-pro-max", name: "DeepSeek-V4-Pro-Max", enabled: true, free: false, reasoning: true, contextWindow: 1048576, maxOutput: 16000, description: "DeepSeek top open model. Maximum capability with 1.6T params." },
  "claude-fable-5-1": { modelId: "claude-fable-5.1", name: "Claude Fable 5.1", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Anthropic premium model. Outstanding coding and reasoning with top Code Arena score." },
  "claude-opus-5-5": { modelId: "claude-opus-5.5", name: "Claude Opus 5.5", enabled: true, free: false, reasoning: true, contextWindow: 1000000, maxOutput: 16000, description: "Anthropic most capable model. Exceptional reasoning and agentic performance." },
}

async function main() {
  const app = firebaseApp()
  const baseUrl = app.options.databaseURL.replace(/\/$/, "")
  const accessToken = (await app.options.credential.getAccessToken()).access_token

  const getRes = await fetch(`${baseUrl}/agents-code-ai/modelCatalog.json`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const catalog = (await getRes.json()) || { providers: {}, models: {} }

  catalog.providers = catalog.providers || {}
  catalog.providers.codecraft = codeCraftProvider

  catalog.models = catalog.models || {}
  catalog.models.codecraft = codeCraftModels

  const putRes = await fetch(`${baseUrl}/agents-code-ai/modelCatalog.json`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(catalog)
  })
  console.log("Updated CodeCraft models in Firebase RTDB status:", putRes.status)

  fs.writeFileSync(
    path.resolve(__dirname, "../../firebase-codecraft-model-catalog.json"),
    JSON.stringify({ providers: { codecraft: codeCraftProvider }, models: { codecraft: codeCraftModels } }, null, 2)
  )
  console.log("Wrote firebase-codecraft-model-catalog.json")
  console.log("Total models:", Object.keys(codeCraftModels).length)
}

main().catch(console.error)
