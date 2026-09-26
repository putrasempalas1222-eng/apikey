const { getDatabase } = require("firebase-admin/database")
const { getAuth } = require("firebase-admin/auth")
const { firebaseApp, bootstrapProfile } = require("../lib/firebase")

async function main() {
  const app = firebaseApp()
  const users = (await getDatabase(app).ref("users").once("value")).val() || {}
  let checked = 0
  let updated = 0
  let skipped = 0
  for (const [uid, record] of Object.entries(users)) {
    try {
      const authUser = await getAuth(app).getUser(uid)
      const result = await bootstrapProfile({ uid, email: authUser.email, name: authUser.displayName, picture: authUser.photoURL })
      checked += 1
      if (result.changed) updated += 1
    } catch (error) {
      // Keep the migration moving if an old/deleted Auth account is found.
      skipped += 1
      console.warn(`Skipped profile ${uid.slice(0, 8)}…`, error instanceof Error ? error.message : "unknown error")
    }
  }
  console.log(JSON.stringify({ checked, updated, skipped }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
