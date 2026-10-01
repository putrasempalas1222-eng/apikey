const { chat } = require("../../../../lib/proxy")

module.exports = async (request, response) => {
  try {
    return await chat(request, response, request.query.providerId)
  } catch (err) {
    // Last-resort guard: an escaped error makes Vercel kill the function with
    // an opaque 500 FUNCTION_INVOCATION_FAILED. Always answer with JSON.
    console.error("chat handler escaped error:", err && err.message ? err.message : err)
    if (!response.writableEnded) {
      try {
        response.status(502).json({ error: { message: "Model sedang bermasalah (koneksi penyedia terputus). Silakan coba lagi atau pilih model lain." } })
      } catch { /* socket already gone */ }
    }
  }
}
