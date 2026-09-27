async function testDahl() {
  const key = "dahl_Mty63w3ADsVsmia9614KXHBJNPU6DPrfp";
  const baseUrl = "https://inference.dahl.global/v1";

  // 1. Fetch models list
  console.log("=== 1. Checking GET /v1/models ===");
  try {
    const mRes = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    console.log("Models Status:", mRes.status);
    if (mRes.ok) {
      const data = await mRes.json();
      console.log("Available models:", JSON.stringify(data, null, 2));
    } else {
      console.log("Models response:", await mRes.text());
    }
  } catch(e) {
    console.log("Models fetch error:", e.message);
  }

  // 2. Test specific models
  const models = [
    "MiniMaxAI/MiniMax-M2.7",
    "deepseek-ai/DeepSeek-V4-Flash-0731",
    "zai-org/GLM-5.3-Flash"
  ];

  console.log("\n=== 2. Testing Chat Completions ===");
  for (const model of models) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Say hello in 1 sentence." }],
          max_tokens: 50
        })
      });
      const text = await res.text();
      console.log(`Model: ${model}`);
      console.log(`Status: ${res.status}`);
      console.log(`Response: ${text}\n`);
    } catch(err) {
      console.log(`Model: ${model} Error:`, err.message);
    }
  }
}

testDahl().catch(console.error);
