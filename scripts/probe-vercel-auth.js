const fs = require("fs")
const { getAuth } = require("firebase-admin/auth")
const { firebaseApp } = require("../lib/firebase")

async function main() {
  const app = firebaseApp()
  const user = (await getAuth(app).listUsers(1)).users[0]
  const customToken = await getAuth(app).createCustomToken(user.uid)
  const source = fs.readFileSync("../m-putra-ramadhani-agents-code-ai-source/packages/kilo-vscode/src/firebase-auth.ts", "utf8")
  const apiKey = source.split('|| "')[1].split('"')[0]
  const signedIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  })
  const session = await signedIn.json()
  if (!signedIn.ok || !session.idToken) throw new Error("Could not create a temporary Firebase test session.")
  const proxyUrl = process.env.PROXY_URL || "https://apikey-pearl.vercel.app"
  const probe = await fetch(`${proxyUrl.replace(/\/$/, "")}/api/profile/bootstrap`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.idToken}` },
  })
  console.log(JSON.stringify({ status: probe.status, ok: probe.ok, body: await probe.text() }))
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
