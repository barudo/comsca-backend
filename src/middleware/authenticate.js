const { getUser } = require("../services/supabase-auth");

module.exports = async function authenticate(request, response, next) {
  response.set("Cache-Control", "no-store");
  const match = /^Bearer ([^\s]+)$/i.exec(request.get("Authorization") || "");
  if (!match) {
    return response.status(401).json({ success: false, error: "A Bearer access token is required" });
  }
  try {
    request.authUser = await (request.app.locals.services.getUser || getUser)({ access_token: match[1] });
    return next();
  } catch (error) {
    if ([400, 401, 403, 429, 502, 503].includes(error.status)) {
      return response.status(error.status).json({ success: false, error: error.message });
    }
    return next(error);
  }
};
