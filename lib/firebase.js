const { getApps, cert, initializeApp } = require("firebase-admin/app")
const { getAuth } = require("firebase-admin/auth")
const { getDatabase } = require("firebase-admin/database")

function firebaseApp() {
  if (getApps().length) return getApps()[0]
  const projectId = process.env.FIREBASE_PROJECT_ID
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")
  const databaseURL = process.env.FIREBASE_DATABASE_URL
  if (!projectId || !clientEmail || !privateKey || !databaseURL) throw new Error("Server configuration is incomplete.")
  return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), databaseURL })
}

async function requireUser(request) {
  const authorization = request.headers.authorization
  const match = typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i) : undefined
  if (!match) {
    const error = new Error("Sign in is required.")
    error.status = 401
    throw error
  }
  return getAuth(firebaseApp()).verifyIdToken(match[1])
}

async function reserveTokens(uid, requested) {
  const ref = getDatabase(firebaseApp()).ref(`users/${uid}/profile`)
  const now = Date.now()
  let reservation
  const result = await ref.transaction((profile) => {
    if (!profile || profile.status === "disabled") return
    const plan = profile.plan === "plus" ? "plus" : "free"
    const limit = Number.isFinite(profile.tokenLimit) && profile.tokenLimit >= 0 ? profile.tokenLimit : plan === "plus" ? 500000 : 100000
    const resetExpired = !Number.isFinite(profile.quotaResetsAt) || profile.quotaResetsAt <= now
    const used = resetExpired ? 0 : Math.max(0, Number(profile.tokenUsed) || 0)
    const credits = Math.max(0, Math.floor(Number(profile.creditTokens) || 0))
    const primaryAvailable = Math.max(0, limit - used)
    const totalAvailable = primaryAvailable + credits
    // The proxy always requests at least 128 output tokens. Rejecting here
    // avoids starting an upstream request that cannot be paid for.
    if (totalAvailable < 128) return
    const reserved = Math.min(Math.max(128, requested), totalAvailable)
    const primaryCharge = Math.min(primaryAvailable, reserved)
    const creditCharge = reserved - primaryCharge
    reservation = { ref, reserved, primaryCharge, creditCharge }
    profile.tokenLimit = limit
    profile.tokenUsed = used + primaryCharge
    profile.tokenRemaining = Math.max(0, limit - profile.tokenUsed)
    profile.creditTokens = credits - creditCharge
    profile.lifetimeTokenUsed = Math.max(0, Number(profile.lifetimeTokenUsed) || 0) + reserved
    profile.quotaResetsAt = resetExpired ? now + (plan === "plus" ? 7 : 30) * 24 * 60 * 60 * 1000 : profile.quotaResetsAt
    profile.lastTokenUsageAt = now
    profile.updatedAt = now
    return profile
  })
  if (!result.committed) {
    const error = new Error("Token quota and credit balance are used up. Top up credits to continue.")
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
  await reservation.ref.transaction((profile) => {
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

module.exports = { requireUser, reserveTokens, settleReservation }
