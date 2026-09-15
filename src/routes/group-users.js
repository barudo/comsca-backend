const express = require("express");
const authenticate = require("../middleware/authenticate");
const router = express.Router();

function memberInput(body) {
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("A user object is required");
  const allowed = ["firstname", "lastname", "username", "email", "phone", "address", "role"];
  if (Object.keys(body).some(key => !allowed.includes(key))) fail("Unsupported user field");
  if (body.role !== undefined && body.role !== "MEMBER") fail("New users must have the MEMBER role");
  const user = { role: "MEMBER" };
  for (const [input, column, limit, required] of [
    ["firstname", "first_name", 255, true], ["lastname", "family_name", 255, true],
    ["username", "username", 255, false], ["email", "email", 320, false],
    ["phone", "phone", 32, false], ["address", "address", 4000, false],
  ]) {
    const value = body[input];
    if (!required && (value === undefined || value === null)) continue;
    if (typeof value !== "string" || !value.trim() || value.trim().length > limit) {
      fail(`${input} must be a nonempty string of at most ${limit} characters`);
    }
    user[column] = value.trim();
  }
  if (user.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) fail("Provide a valid email address");
  if (user.phone) {
    if (/^9\d{9}$/.test(user.phone)) user.phone = `+63${user.phone}`;
    else if (/^09\d{9}$/.test(user.phone)) user.phone = `+63${user.phone.slice(1)}`;
    else if (/^639\d{9}$/.test(user.phone)) user.phone = `+${user.phone}`;
    if (!/^\+639\d{9}$/.test(user.phone)) fail("Provide a valid phone number");
  }
  return user;
}

router.post("/", authenticate, async (request, response, next) => {
  try {
    const user = await request.app.locals.database.transaction(async (trx) => {
      // Lock the actor so role revocation or group reassignment cannot race this write.
      const actor = await trx("users").where({
        auth_user_id: request.authUser.id, group_id: request.group.id,
      }).forUpdate().first("id", "role");
      if (!actor || !["OWNER", "ADMIN"].includes(actor.role)) {
        throw Object.assign(new Error("Only an OWNER or ADMIN of this group can add users"), { status: 403 });
      }
      const values = memberInput(request.body);
      const [created] = await trx("users").insert({ ...values, group_id: request.group.id })
        .returning(["id", "group_id", "first_name", "family_name", "username", "email", "phone", "address", "role", "created_at"]);
      return created;
    });
    return response.status(201).json({ success: true, user });
  } catch (error) {
    if (error.code === "23505") {
      return response.status(409).json({ success: false, error: "User already exists in this group" });
    }
    if ([400, 403].includes(error.status)) {
      return response.status(error.status).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

module.exports = router;
