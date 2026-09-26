const { getAuth } = require("firebase-admin/auth")
const { firebaseApp, bootstrapProfile } = require("../lib/firebase")

async function main() {
  const app = firebaseApp()
  let checked = 0
  let updated = 0
  let skipped = 0
  let pageToken
  do {
    const page = await getAuth(app).listUsers(1000, pageToken)
    for (const authUser of page.users) {
      try {
        const result = await bootstrapProfile({ uid: authUser.uid, email: authUser.email, name: authUser.displayName, picture: authUser.photoURL })
        checked += 1
        if (result.changed) updated += 1
      } catch (error) {
        skipped += 1
        console.warn(`Skipped profile ${authUser.uid.slice(0, 8)}…`, error instanceof Error ? error.message : "unknown error")
      }
    }
    pageToken = page.pageToken
  } while (pageToken)
  console.log(JSON.stringify({ checked, updated, skipped }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
