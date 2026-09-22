const bcrypt = require("bcryptjs");
const { randomBytes } = require("node:crypto");

// Unknown users still perform a password comparison to reduce timing differences.
let dummyHash;

class LegacyAuthHandler {
  index(_request, response) {
    response.json({
      success: true,
      message: "Authentication endpoint",
    });
  }

  async login(request, response, next) {
    const { username, password } = request.body || {};
    if (
      typeof username !== "string" || !username.trim() || username.length > 255 ||
      typeof password !== "string" || !password || Buffer.byteLength(password, "utf8") > 72
    ) {
      return response.status(400).json({
        success: false,
        error: "A username and password (maximum 72 bytes) are required",
      });
    }

    try {
      const user = await request.app.locals.database.transaction(async (trx) => {
        await trx.raw("SET LOCAL ROLE comsca_login");
        await trx.raw("SELECT set_config('app.group_id', ?, true)", [String(request.group.id)]);
        return trx("users")
          .select("id", "group_id", "username", "first_name", "family_name", "password")
          .where({ group_id: request.group.id, username: username.trim() })
          .first();
      });
      const validHash = typeof user?.password === "string" &&
        /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(user.password);
      if (!validHash) dummyHash ||= bcrypt.hash(randomBytes(32).toString("hex"), 12);
      const matches = await bcrypt.compare(password, validHash ? user.password : await dummyHash);
      if (!user || !validHash || !matches) {
        return response.status(401).json({ success: false, error: "Invalid username or password" });
      }
      response.set("Cache-Control", "no-store");
      return response.json({
        success: true,
        user: {
          id: user.id,
          group_id: user.group_id,
          username: user.username,
          first_name: user.first_name,
          family_name: user.family_name,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = LegacyAuthHandler;
