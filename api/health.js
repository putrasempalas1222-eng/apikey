module.exports = (_request, response) => {
  response.status(200).json({
    ok: true,
    service: "agents-code-ai-proxy",
    // Boolean only — never expose the values themselves. The OTP URL ships in
    // code as a default, so only the key can be missing.
    otpKeyConfigured: Boolean(process.env.OTP_SEND_API_KEY),
  })
}
