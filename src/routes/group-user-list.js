const express = require("express");
const authenticate = require("../middleware/authenticate");
const router = express.Router();

router.get("/users", authenticate, async (request, response, next) => {
  try {
    const db = request.app.locals.database;
    const actor = await db("users")
      .where({ auth_user_id: request.authUser.id, group_id: request.group.id })
      .first("id", "role");
    if (!actor || !["OWNER", "ADMIN"].includes(actor.role)) {
      return response.status(403).json({ success: false, error: "Only an OWNER or ADMIN of this group can list users" });
    }

    const cycle = await db("cycles").where({ group_id: request.group.id })
      .orderBy("created_at", "desc").orderBy("id", "desc").first("id");
    const users = await db("users as u")
      .leftJoin("cycle_members as cm", function () {
        this.on("cm.user_id", "=", "u.id").andOnVal("cm.cycle_id", "=", cycle?.id ?? null);
      })
      .where("u.group_id", request.group.id)
      .select("u.id", "u.group_id", "u.first_name", "u.family_name", "u.username",
        "u.email", "u.phone", "u.address", "u.role", "u.created_at", "u.updated_at",
        db.raw("cm.user_id IS NOT NULL AS is_current_cycle_member"))
      .orderBy("u.family_name").orderBy("u.first_name").orderBy("u.id");
    return response.json({ success: true, current_cycle_id: cycle?.id ?? null, users });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
