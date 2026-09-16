const express = require("express");
const authenticate = require("../middleware/authenticate");
const router = express.Router();

router.get("/me", authenticate, async (request, response, next) => {
  try {
    const user = await request.app.locals.database("users")
      .where({ auth_user_id: request.authUser.id, group_id: request.group.id })
      .first("id", "group_id", "first_name", "family_name", "username", "email",
        "phone", "address", "role", "created_at", "updated_at");
    if (!user) {
      return response.status(403).json({ success: false, error: "You do not have a user profile in this group" });
    }
    const { id, name, slug } = request.group;
    return response.json({ success: true, user, group: { id, name, slug } });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
