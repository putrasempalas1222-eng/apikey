const { chat } = require("../lib/proxy")

module.exports = (request, response) => chat(request, response, request.body?.providerId || "atria")
