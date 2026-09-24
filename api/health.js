module.exports = (_request, response) => {
  response.status(200).json({ ok: true, service: "agents-code-ai-proxy" })
}
