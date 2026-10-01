module.exports = (_request, response) => {
  response.status(200).json({
    ok: true,
    service: "agents-code-ai-proxy",
    // Boolean only — never expose the key itself.
    otpConfigured: Boolean(process.env.OTP_SEND_API_KEY && process.env.OTP_SEND_URL),
    webFetch: Boolean(process.env.WEB_FETCH_URL || true),
  })
}
