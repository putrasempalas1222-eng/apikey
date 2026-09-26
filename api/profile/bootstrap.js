const { requireUser, bootstrapProfile } = require("../../lib/firebase")

module.exports = async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*")
  response.setHeader("Access-Control-Allow-Headers", "Authorization, X-Api-Key, X-Firebase-Token")
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  if (request.method === "OPTIONS") return response.status(204).end()
  if (request.method !== "POST") return response.status(405).json({ error: { message: "Method not allowed." } })
  try {
    const user = await requireUser(request)
    const result = await bootstrapProfile(user)
    return response.status(200).json({ ok: true, changed: result.changed })
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : 503
    return response.status(status).json({ error: { message: status === 401 ? "Sign in is required." : "Profile service is temporarily unavailable." } })
  }
}
