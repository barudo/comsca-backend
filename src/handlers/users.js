const { updatePassword } = require("../services/supabase-auth");

const profileColumns = ["id", "group_id", "first_name", "family_name", "username", "email",
  "phone", "address", "role", "created_at", "updated_at"];
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

function inputObject(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("A user object is required");
  if (!Object.keys(body).length) fail("At least one field is required");
  if (Object.keys(body).some(key => !allowed.includes(key))) fail("Unsupported user field");
  return body;
}

class UsersHandler {
  async update(request, response, next) {
    try {
      const body = inputObject(request.body, ["first_name", "family_name", "address"]);
      const values = {};
      for (const [field, value] of Object.entries(body)) {
        if (field === "address" && value === null) {
          values.address = null;
          continue;
        }
        const limit = field === "address" ? 4000 : 255;
        if (typeof value !== "string" || !value.isWellFormed() || !value.trim() || value.includes("\u0000") || [...value.trim()].length > limit) {
          fail(`${field} must be a nonempty string of at most ${limit} characters`);
        }
        values[field] = value.trim();
      }
      const db = request.app.locals.database;
      const [user] = await db("users")
        .where({ auth_user_id: request.authUser.id, group_id: request.group.id })
        .update({ ...values, updated_at: db.raw("clock_timestamp()") }).returning(profileColumns);
      if (!user) return response.status(403).json({ success: false, error: "You do not have a user profile in this group" });
      const { id, name, slug } = request.group;
      return response.json({ success: true, user, group: { id, name, slug } });
    } catch (error) {
      if (error.status === 400) return response.status(400).json({ success: false, error: error.message });
      return next(error);
    }
  }

  async password(request, response, next) {
    try {
      const { new_password, repeat_new_password } = inputObject(request.body, ["new_password", "repeat_new_password"]);
      if (typeof new_password !== "string" || !new_password.isWellFormed() || [...new_password].length < 8 || Buffer.byteLength(new_password, "utf8") > 72) {
        fail("Password must contain at least 8 characters and at most 72 UTF-8 bytes");
      }
      if (new_password !== repeat_new_password) fail("Passwords must match");
      const user = await request.app.locals.database("users")
        .where({ auth_user_id: request.authUser.id, group_id: request.group.id }).first("id");
      if (!user) return response.status(403).json({ success: false, error: "You do not have a user profile in this group" });
      await (request.app.locals.services.updatePassword || updatePassword)({
        access_token: request.get("Authorization").split(" ")[1], password: new_password,
      });
      return response.json({ success: true, message: "Password updated successfully" });
    } catch (error) {
      if ([400, 401, 403, 429, 502, 503].includes(error.status)) {
        return response.status(error.status).json({ success: false, error: error.message });
      }
      return next(error);
    }
  }

  async me(request, response, next) {
    try {
      const user = await request.app.locals.database("users")
        .where({ auth_user_id: request.authUser.id, group_id: request.group.id })
        .first(...profileColumns);
      if (!user) {
        return response.status(403).json({ success: false, error: "You do not have a user profile in this group" });
      }
      const { id, name, slug } = request.group;
      return response.json({ success: true, user, group: { id, name, slug } });
    } catch (error) {
      return next(error);
    }
  }
}

module.exports = UsersHandler;
