module.exports = async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*")
  response.setHeader("Access-Control-Allow-Headers", "Authorization, X-Api-Key, X-Firebase-Token")
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  if (request.method === "OPTIONS") return response.status(204).end()
  if (request.method !== "POST") return response.status(405).json({ error: { message: "Method not allowed." } })
  return response.status(200).json({ ok: true, changed: false })
}

