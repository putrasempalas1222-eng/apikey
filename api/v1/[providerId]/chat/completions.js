const { chat } = require("../../../../lib/proxy")

module.exports = (request, response) => chat(request, response, request.query.providerId)
