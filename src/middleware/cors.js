const methods = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
const headers = "Content-Type,Authorization,X-Group-Slug";

function allowedOrigin(origin) {
  const extraOrigins = (process.env.CORS_ALLOWED_ORIGINS || "").split(",").map((v) => v.trim());
  if (extraOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.origin !== origin) return false;
    const production = url.protocol === "https:" && !url.port &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?comsca\.com$/.test(url.hostname);
    const development = url.protocol === "http:" &&
      /^(?:127\.0\.0\.1|(?:[a-z0-9-]+\.)?localhost)$/.test(url.hostname);
    return production || development;
  } catch {
    return false;
  }
}

module.exports = function cors(request, response, next) {
  response.vary("Origin");
  const origin = request.get("Origin");
  if (!origin || !allowedOrigin(origin)) return next();
  response.set("Access-Control-Allow-Origin", origin);
  if (request.method === "OPTIONS" && /^\/api\/v1(?:\/|$)/i.test(request.path)) {
    response.set("Access-Control-Allow-Methods", methods);
    response.set("Access-Control-Allow-Headers", headers);
    response.set("Access-Control-Max-Age", "600");
    return response.status(204).end();
  }
  next();
};
