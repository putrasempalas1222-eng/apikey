const { chat } = require("../lib/proxy")

module.exports = async (request, response) => {
  try {
    return await chat(request, response, request.body?.providerId || "atria")
  } catch (err) {
    console.error("chat handler escaped error:", err && err.message ? err.message : err)
    if (!response.writableEnded) {
      try {
        response.status(502).json({ error: { message: "Model sedang bermasalah (koneksi penyedia terputus). Silakan coba lagi atau pilih model lain." } })
      } catch { /* socket already gone */ }
    }
  }
}
