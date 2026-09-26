# Agents Code AI — Vercel proxy

This is a server-only proxy. It keeps provider API keys in Vercel, not in the
extension, Firebase, source files, or the deployed VSIX.

It also verifies the signed-in Firebase user and charges token quota / backup
credits atomically on the server. Configure the Firebase Admin variables from
`.env.example` in Vercel before deploying. Do not place their values in this
repository or the extension.

## Deploy

1. Import this folder into a new Vercel project (or run `npx vercel` here).
2. In **Project Settings → Environment Variables**, add these as **Sensitive**,
   selecting **Production**:
   - `ATRIA_API_KEY`
   - `CEO_API_KEY`
   - `BACROT_API_KEY`
3. Deploy/redeploy the project.
4. Verify `https://YOUR-VERCEL-DOMAIN/api/health` returns `{ "ok": true }`.

The chat endpoint is `POST /api/chat` with this body:

```json
{
  "providerId": "atria",
  "model": "Atria-Dawn-Preview",
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

After deployment, use the generated Vercel URL as the provider base URL in the
extension integration. Do not add API keys to Firebase or extension settings.
