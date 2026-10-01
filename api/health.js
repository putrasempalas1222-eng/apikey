module.exports = (_request, response) => {
  response.status(200).json({
    ok: true,
    service: "agents-code-ai-proxy",
    // Booleans only — never expose the values themselves.
    otpUrlConfigured: Boolean(process.env.OTP_SEND_URL),
    otpKeyConfigured: Boolean(process.env.OTP_SEND_API_KEY),
  })
}
