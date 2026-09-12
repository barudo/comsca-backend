const express = require("express");
const router = express.Router();

router.get("/validate-slug", async (request, response) => {
  response.set("Cache-Control", "no-store");
  const value = request.query.slug;
  if (typeof value !== "string" || !value.trim()) {
    return response.status(400).json({ success: false, message: "Slug is required" });
  }
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) ||
    ["www", "api", "app", "admin", "auth"].includes(slug)) {
    return response.status(400).json({ success: false, message: "Provide a valid, non-reserved group subdomain slug" });
  }
  try {
    const group = await request.app.locals.database("groups").where({ slug }).first("id");
    return response.json({
      success: !group,
      message: group ? "Group slug is already in use" : "Group slug is available",
    });
  } catch {
    return response.status(503).json({ success: false, message: "Slug validation service unavailable" });
  }
});

module.exports = router;
