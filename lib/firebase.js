const { getApps, cert, initializeApp } = require("firebase-admin/app")
const { getAuth } = require("firebase-admin/auth")

// ── Global quota configuration (admin dashboard) ───────────────────────────
// Stored at agents-code-ai/quotaConfig in Firebase and applied to EVERY
// account of the tier — free registrations get freeTokenLimit with a
// freeResetDays reset, plus accounts get plusTokenLimit / plusResetDays and
// a burstLimit-per-burstHours rate window. Values the admin has not set fall
// back to the product defaults below.
const QUOTA_CACHE_TTL_MS = 60_000
const quotaConfigCache = { value: null, expiresAt: 0 }

function quotaNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

async function getQuotaConfig() {
  if (quotaConfigCache.expiresAt > Date.now()) return quotaConfigCache.value
  try {
    const app = firebaseApp()
    const baseUrl = app.options.databaseURL.replace(/\/$/, "")
    const accessToken = (await app.options.credential.getAccessToken()).access_token
    const res = await fetch(`${baseUrl}/agents-code-ai/quotaConfig.json`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const value = res.ok ? await res.json() : null
    quotaConfigCache.value = value && typeof value === "object" ? value : null
  } catch {
    quotaConfigCache.value = null
  }
  quotaConfigCache.expiresAt = Date.now() + QUOTA_CACHE_TTL_MS
  return quotaConfigCache.value
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Effective per-plan quota policy from the admin config. */
async function planQuota(plan) {
  const config = (await getQuotaConfig()) || {}
  const plus = plan === "plus"
  return {
    limit: plus ? quotaNumber(config.plusTokenLimit, 500_000) : quotaNumber(config.freeTokenLimit, 50_000),
    resetMs: (plus ? quotaNumber(config.plusResetDays, 7) : quotaNumber(config.freeResetDays, 30)) * DAY_MS,
    burstLimit: quotaNumber(config.burstLimit, 100_000),
    burstWindowMs: quotaNumber(config.burstHours, 5) * 60 * 60 * 1000,
  }
}

function firebaseApp() {
  if (getApps().length) return getApps()[0]
  const projectId = process.env.FIREBASE_PROJECT_ID
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")
  const databaseURL = process.env.FIREBASE_DATABASE_URL
  if (!projectId || !clientEmail || !privateKey || !databaseURL) throw new Error("Server configuration is incomplete.")
  return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), databaseURL })
}

async function profileMutation(uid, mutate) {
  const app = firebaseApp()
  const baseUrl = app.options.databaseURL.replace(/\/$/, "")
  const accessToken = (await app.options.credential.getAccessToken()).access_token
  const url = `${baseUrl}/users/${encodeURIComponent(uid)}/profile.json`
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const read = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, "X-Firebase-ETag": "true" } })
    if (!read.ok) throw new Error("Profile database read failed.")
    const current = await read.json()
    const next = mutate(current)
    if (next === undefined) return { committed: false, profile: current }
    const write = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "if-match": read.headers.get("etag") || "*" },
      body: JSON.stringify(next),
    })
    if (write.ok) return { committed: true, profile: next }
    if (write.status !== 412) throw new Error("Profile database update failed.")
  }
  throw new Error("Profile update conflicted too many times.")
}

async function requireUser(request) {
  const authorization = request.headers.authorization
  const match = typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i) : undefined
  const alternateToken = request.headers["x-api-key"] || request.headers["x-firebase-token"]
  const token = match?.[1] || (typeof alternateToken === "string" ? alternateToken : undefined)
  if (!token) {
    const error = new Error("Sign in is required.")
    error.status = 401
    throw error
  }
  return getAuth(firebaseApp()).verifyIdToken(token)
}

async function reserveTokens(user, requested) {
  const uid = user.uid
  const now = Date.now()
  let reservation
  const freeQuota = await planQuota("free")
  const plusQuota = await planQuota("plus")
  const result = await profileMutation(uid, (profile) => {
    if (!profile) {
      profile = {
        uid,
        email: user.email || "",
        displayName: user.name || (user.email ? user.email.split("@")[0] : "User"),
        photoURL: user.picture || "",
        chatLimit: 10,
        createdAt: now,
        lastLoginAt: now,
        plan: "free",
        planName: "Free",
        role: "user",
        status: "active",
        tokenLimit: 100000,
        tokenUsed: 0,
        tokenRemaining: 100000,
        lifetimeTokenUsed: 0,
        creditTokens: 0,
        quotaResetsAt: now + 30 * 24 * 60 * 60 * 1000,
      }
    }
    if (profile.status === "disabled") return
    const plusExpired =
      profile.plan === "plus" && Number(profile.plusExpiresAt) > 0 && Number(profile.plusExpiresAt) <= now
    const plan = plusExpired ? "free" : profile.plan === "plus" ? "plus" : "free"
    // The admin-configured global quota for the tier is authoritative for
    // every account of that plan.
    const quota = plan === "plus" ? plusQuota : freeQuota
    // Plus is time-limited: once plusExpiresAt passes, the account drops back
    // to Free (limits included) — enforced here, the quota authority.
    if (plusExpired) {
      profile.plan = "free"
      profile.planName = "Free"
      profile.plusExpiresAt = null
      profile.quotaResetsAt = now + quota.resetMs
      profile.burstLimit = 0
      profile.burstUsed = 0
    }
    const limit = quota.limit
    const resetExpired = !Number.isFinite(profile.quotaResetsAt) || profile.quotaResetsAt <= now
    const used = resetExpired ? 0 : Math.max(0, Number(profile.tokenUsed) || 0)
    // Token tambahan (top-up) berjangka: setelah creditExpiresAt lewat,
    // saldonya dihitung 0 sampai admin menambah lagi.
    const creditExpired = Number(profile.creditExpiresAt) > 0 && Number(profile.creditExpiresAt) <= now
    const credits = creditExpired ? 0 : Math.max(0, Math.floor(Number(profile.creditTokens) || 0))
    const primaryAvailable = Math.max(0, limit - used)
    const totalAvailable = primaryAvailable + credits
    // The proxy always requests at least 128 output tokens. Rejecting here
    // avoids starting an upstream request that cannot be paid for.
    if (totalAvailable < 128) return
    const reserved = Math.min(Math.max(128, requested), totalAvailable)
    const primaryCharge = Math.min(primaryAvailable, reserved)
    const creditCharge = reserved - primaryCharge
    reservation = { uid, reserved, primaryCharge, creditCharge }
    profile.tokenLimit = limit
    profile.tokenUsed = used + primaryCharge
    profile.tokenRemaining = Math.max(0, limit - profile.tokenUsed)
    profile.creditTokens = credits - creditCharge
    profile.lifetimeTokenUsed = Math.max(0, Number(profile.lifetimeTokenUsed) || 0) + reserved
    profile.quotaResetsAt = resetExpired ? now + quota.resetMs : profile.quotaResetsAt
    profile.lastTokenUsageAt = now
    profile.updatedAt = now
    return profile
  })
  if (!result.committed) {
    const error = new Error("Token sudah habis. Tambah tokens melalui website (tombol Tambah Tokens di extension) untuk melanjutkan.")
    error.status = 402
    throw error
  }
  return reservation
}

async function settleReservation(reservation, actualTokens) {
  if (!reservation || !Number.isFinite(actualTokens)) return
  const actual = Math.max(0, Math.ceil(actualTokens * 1.1))
  const refund = Math.max(0, reservation.reserved - actual)
  if (!refund) return
  await profileMutation(reservation.uid, (profile) => {
    if (!profile) return profile
    // Return the reservation to its original pools. This keeps credit balance
    // separate from the periodic quota even when other requests are active.
    const used = Math.max(0, Number(profile.tokenUsed) || 0)
    const quotaRefund = Math.min(used, reservation.primaryCharge, refund)
    profile.tokenUsed = used - quotaRefund
    profile.tokenRemaining = Math.max(0, (Number(profile.tokenLimit) || 0) - profile.tokenUsed)
    const creditRefund = Math.min(reservation.creditCharge, refund - quotaRefund)
    profile.creditTokens = Math.max(0, Number(profile.creditTokens) || 0) + creditRefund
    profile.lifetimeTokenUsed = Math.max(0, (Number(profile.lifetimeTokenUsed) || 0) - refund)
    profile.updatedAt = Date.now()
    return profile
  })
}

/**
 * Migration/default guard for every authenticated profile. It only supplies
 * absent fields, preserving an existing role, plan, quota, credit balance,
 * and all user/admin data exactly as stored.
 */
async function bootstrapProfile(user) {
  const now = Date.now()
  let changed = false
  const config = (await getQuotaConfig()) || {}
  const freeLimit = quotaNumber(config.freeTokenLimit, 50_000)
  const plusLimit = quotaNumber(config.plusTokenLimit, 500_000)
  const freeResetMs = quotaNumber(config.freeResetDays, 30) * DAY_MS
  const plusResetMs = quotaNumber(config.plusResetDays, 7) * DAY_MS
  const burstLimit = quotaNumber(config.burstLimit, 100_000)
  const burstWindowMs = quotaNumber(config.burstHours, 5) * 60 * 60 * 1000
  const result = await profileMutation(user.uid, (profile) => {
    const record = profile && typeof profile === "object" ? profile : {}
    let modified = false
    const setMissing = (key, value) => {
      if (record[key] === undefined || record[key] === null) {
        record[key] = value
        modified = true
      }
    }
    let plan = record.plan === "plus" ? "plus" : "free"
    // Time-limited Plus: an expired plusExpiresAt downgrades the profile to
    // Free on first contact so every surface (admin, extension, proxy) agrees.
    if (plan === "plus" && Number(record.plusExpiresAt) > 0 && Number(record.plusExpiresAt) <= now) {
      plan = "free"
      record.plan = "free"
      record.planName = "Free"
      record.plusExpiresAt = null
      if (Number(record.tokenLimit) > freeLimit) record.tokenLimit = freeLimit
      record.tokenRemaining = Math.max(0, Number(record.tokenLimit) || 0)
      record.quotaResetsAt = now + freeResetMs
      record.burstLimit = 0
      record.burstUsed = 0
      modified = true
    }
    const defaultLimit = plan === "plus" ? plusLimit : freeLimit
    const limit = Number.isFinite(record.tokenLimit) && record.tokenLimit >= 0 ? record.tokenLimit : defaultLimit
    setMissing("uid", user.uid)
    setMissing("email", user.email || "")
    setMissing("displayName", user.name || (user.email ? user.email.split("@")[0] : "User"))
    setMissing("photoURL", user.picture || "")
    setMissing("chatLimit", 10)
    setMissing("createdAt", now)
    setMissing("lastLoginAt", now)
    setMissing("plan", "free")
    setMissing("planName", "Free")
    setMissing("role", "user")
    setMissing("status", "active")
    if (!(Number.isFinite(record.tokenLimit) && record.tokenLimit >= 0)) {
      record.tokenLimit = limit
      modified = true
    }
    if (!(Number.isFinite(record.tokenUsed) && record.tokenUsed >= 0)) {
      record.tokenUsed = 0
      modified = true
    }
    if (!(Number.isFinite(record.tokenRemaining) && record.tokenRemaining >= 0)) {
      record.tokenRemaining = Math.max(0, limit - record.tokenUsed)
      modified = true
    }
    if (!(Number.isFinite(record.lifetimeTokenUsed) && record.lifetimeTokenUsed >= 0)) {
      record.lifetimeTokenUsed = 0
      modified = true
    }
    if (!(Number.isFinite(record.creditTokens) && record.creditTokens >= 0)) {
      record.creditTokens = 0
      modified = true
    }
    if (!(Number.isFinite(record.quotaResetsAt) && record.quotaResetsAt > 0)) {
      record.quotaResetsAt = now + (plan === "plus" ? plusResetMs : freeResetMs)
    setMissing("burstLimit", plan === "plus" ? burstLimit : 0)
    setMissing("burstUsed", 0)
    setMissing("burstResetsAt", now + burstWindowMs)
      modified = true
    }
    if (!modified) return
    record.updatedAt = now
    changed = true
    return record
  })
  return { changed: changed && result.committed, profile: result.profile }
}

module.exports = { firebaseApp, requireUser, reserveTokens, settleReservation, bootstrapProfile }
