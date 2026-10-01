// Phone verification via OTP.
//
// POST { idToken, phone }  → send stage: validates the Firebase user, checks
//   that the phone is linked to at most 2 other accounts (limit: 3 total),
//   generates a 6-digit code, delivers it through the external kirim-otp API
//   (key from env), and stores a hash with a 10-minute expiry.
// POST { idToken, otp }    → verify stage: matches the code (max 5 attempts),
//   then links users/{uid}/profile/phone and phoneIndex/{phone}/{uid}.
//
// The API key and the OTP never appear in any response.

const { createHash, randomInt } = require("node:crypto")
const { firebaseApp, requireUser } = require("../../lib/firebase")

const MAX_ACCOUNTS_PER_PHONE = 3
const OTP_TTL_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 5
const EXTERNAL_TIMEOUT_MS = 15000

function cors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*")
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, X-Firebase-Token")
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
}

function fail(response, status, message) {
  if (response.writableEnded) return
  response.status(status).json({ error: { message } })
}

async function adminRest(app, path, options) {
  const baseUrl = app.options.databaseURL.replace(/\/$/, "")
  const accessToken = (await app.options.credential.getAccessToken()).access_token
  return fetch(`${baseUrl}/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(options?.headers || {}) },
  })
}

function hashOtp(otp, phone) {
  return createHash("sha256").update(`${otp}:${phone}`).digest("hex")
}

async function countLinkedAccounts(app, phone) {
  const res = await adminRest(app, `phoneIndex/${phone}.json?shallow=true`)
  if (!res.ok) return 0
  const data = await res.json()
  return data ? Object.keys(data).length : 0
}

module.exports = async (request, response) => {
  cors(response)
  if (request.method === "OPTIONS") return response.status(204).end()
  if (request.method !== "POST") return fail(response, 405, "Method not allowed.")
  try {
    const { idToken, phone, otp } = request.body ?? {}
    let user
    try {
      user = await requireUser(request)
      if (!user?.uid) throw new Error("no uid")
    } catch {
      return fail(response, 401, "Sesi tidak valid. Login ulang lalu coba lagi.")
    }
    const app = firebaseApp()

    // ── Send stage ────────────────────────────────────────────────────────
    if (typeof phone === "string") {
      const normalized = phone.replace(/\D/g, "")
      if (!/^\d{8,15}$/.test(normalized)) {
        return fail(response, 400, "Nomor telepon tidak valid. Gunakan 8–15 digit.")
      }
      const linked = await countLinkedAccounts(app, normalized)
      const ownRes = await adminRest(app, `users/${user.uid}/profile/phone.json`)
      const ownPhone = ownRes.ok ? await ownRes.json() : null
      const alreadyLinkedToMe = String(ownPhone || "").replace(/\D/g, "") === normalized
      if (!alreadyLinkedToMe && linked >= MAX_ACCOUNTS_PER_PHONE) {
        return fail(response, 403, `Nomor ini sudah terhubung ke ${MAX_ACCOUNTS_PER_PHONE} akun. Gunakan nomor lain.`)
      }

      const key = process.env.OTP_SEND_API_KEY
      const url = process.env.OTP_SEND_URL
      if (!key || !url) return fail(response, 503, "Layanan OTP belum dikonfigurasi. Hubungi admin.")

      const code = String(randomInt(100000, 1000000))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), EXTERNAL_TIMEOUT_MS)
      try {
        const external = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key },
          body: JSON.stringify({ phone: normalized, otp: code }),
          signal: controller.signal,
        })
        if (!external.ok) {
          console.error(`kirim-otp failed for uid ${user.uid}: HTTP ${external.status}`)
          return fail(response, 502, "Gagal mengirim OTP. Coba lagi beberapa saat.")
        }
      } catch (err) {
        if (controller.signal.aborted) {
          console.error(`kirim-otp timeout for uid ${user.uid}`)
          return fail(response, 504, "Pengiriman OTP timed out. Coba lagi.")
        }
        console.error(`kirim-otp network error for uid ${user.uid}:`, err.message)
        return fail(response, 502, "Gagal mengirim OTP. Coba lagi beberapa saat.")
      } finally {
        clearTimeout(timer)
      }

      const now = Date.now()
      await adminRest(app, `users/${user.uid}/phoneVerification.json`, {
        method: "PUT",
        body: JSON.stringify({ phone: normalized, hash: hashOtp(code, normalized), expiresAt: now + OTP_TTL_MS, attempts: 0, updatedAt: now }),
      })
      return response.status(200).json({ ok: true, sent: true, expiresIn: OTP_TTL_MS })
    }

    // ── Verify stage ──────────────────────────────────────────────────────
    if (typeof otp === "string") {
      const recordRes = await adminRest(app, `users/${user.uid}/phoneVerification.json`)
      const record = recordRes.ok ? await recordRes.json() : null
      if (!record || !record.phone) return fail(response, 400, "Belum ada permintaan OTP. Kirim ulang dari awal.")
      if (Number(record.expiresAt) <= Date.now()) return fail(response, 400, "OTP kedaluwarsa. Kirim ulang.")
      if (Number(record.attempts) >= MAX_ATTEMPTS) return fail(response, 429, "Terlalu banyak percobaan. Kirim ulang OTP.")

      if (hashOtp(otp.replace(/\D/g, ""), record.phone) !== record.hash) {
        await adminRest(app, `users/${user.uid}/phoneVerification/attempts.json`, {
          method: "PUT",
          body: JSON.stringify(Number(record.attempts) + 1),
        })
        return fail(response, 400, "Kode OTP salah.")
      }

      // Enforce the per-phone account cap again right before linking.
      const linked = await countLinkedAccounts(app, record.phone)
      const indexRes = await adminRest(app, `phoneIndex/${record.phone}/${user.uid}.json`)
      const alreadyMine = indexRes.ok ? await indexRes.json() : null
      if (!alreadyMine && linked >= MAX_ACCOUNTS_PER_PHONE) {
        await adminRest(app, `users/${user.uid}/phoneVerification.json`, { method: "PUT", body: "null" })
        return fail(response, 403, `Nomor ini sudah terhubung ke ${MAX_ACCOUNTS_PER_PHONE} akun. Gunakan nomor lain.`)
      }

      const now = Date.now()
      await adminRest(app, `users/${user.uid}/profile/phone.json`, { method: "PUT", body: JSON.stringify(record.phone) })
      await adminRest(app, `users/${user.uid}/profile/phoneVerifiedAt.json`, { method: "PUT", body: JSON.stringify(now) })
      await adminRest(app, `phoneIndex/${record.phone}/${user.uid}.json`, { method: "PUT", body: "true" })
      await adminRest(app, `users/${user.uid}/phoneVerification.json`, { method: "PUT", body: "null" })
      return response.status(200).json({ ok: true, verified: true, phone: record.phone })
    }

    return fail(response, 400, "Kirim 'phone' untuk meminta OTP, atau 'otp' untuk verifikasi.")
  } catch (err) {
    console.error("phone otp handler error:", err && err.message ? err.message : err)
    if (!response.writableEnded) {
      try {
        response.status(502).json({ error: { message: "Layanan OTP bermasalah. Coba lagi nanti." } })
      } catch { /* socket gone */ }
    }
  }
}
