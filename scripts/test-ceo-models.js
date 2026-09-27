async function run() {
  const key = "CEO-144C23E67371A9FDDE9A8420CD99F2945A26662C5F50C11F";
  const mRes = await fetch("https://dashboard.ceoweb3.dev/v1/models", {
    headers: { Authorization: `Bearer ${key}` }
  });
  const list = (await mRes.json()).data || [];

  for (const m of list) {
    // Test standard request
    const res = await fetch("https://dashboard.ceoweb3.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: m.id,
        messages: [{ role: "user", content: "Hi" }],
        stream: false
      })
    });
    const data = await res.json().catch(() => ({}));
    console.log(m.id, "=>", res.status, data?.error?.message || (data?.choices?.[0]?.message?.content || "").slice(0, 50));
  }
}

run().catch(console.error);
