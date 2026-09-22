const express = require("express");
const authenticate = require("../middleware/authenticate");
const groupSlugMiddleware = require("../middleware/group-slug");
const CyclesHandler = require("../handlers/cycles");
const GroupUsersHandler = require("../handlers/group-users");
const GroupUserListHandler = require("../handlers/group-user-list");
const GroupUserAccountsHandler = require("../handlers/group-user-accounts");
const UsersHandler = require("../handlers/users");
const LegacyAuthHandler = require("../handlers/legacy-auth");
const GroupsHandler = require("../handlers/groups");
const HooksHandler = require("../handlers/hooks");
const RegistrationHandler = require("../handlers/registration");
const SupabaseAuthHandler = require("../handlers/supabase-auth");
const HomeHandler = require("../handlers/home");

function createRouter(database) {
  const router = express.Router();
  const cycles = new CyclesHandler();
  const groupUsers = new GroupUsersHandler();
  const groupUserList = new GroupUserListHandler();
  const groupUserAccounts = new GroupUserAccountsHandler();
  const users = new UsersHandler();
  const legacyAuth = new LegacyAuthHandler();
  const groups = new GroupsHandler();
  const hooks = new HooksHandler();
  const registration = new RegistrationHandler();
  const auth = new SupabaseAuthHandler();
  const home = new HomeHandler();

  const publicRoutes = express.Router();
  // Verify webhook signatures against the original bytes before JSON parsing.
  publicRoutes.use("/api/v1/hooks", express.raw({ type: "application/json", limit: "32kb" }));
  publicRoutes.post("/api/v1/hooks/sms", hooks.sms.bind(hooks));
  publicRoutes.use(express.json({ limit: "32kb" }));

  // Registration and authentication resolve identity without a group header.
  publicRoutes.post("/api/v1/user/register", registration.register.bind(registration));
  publicRoutes.post("/api/v1/user/verify", registration.verify.bind(registration));
  publicRoutes.get(["/groups/validate-slug", "/api/v1/groups/validate-slug"], groups.validateSlug.bind(groups));
  publicRoutes.post("/api/v1/auth/login/password", auth.loginPassword.bind(auth));
  publicRoutes.post("/api/v1/auth/login/otp/request", auth.requestOtp.bind(auth));
  publicRoutes.post("/api/v1/auth/login/otp/verify", auth.verifyOtp.bind(auth));
  publicRoutes.post("/api/v1/auth/refresh", auth.refresh.bind(auth));
  publicRoutes.post("/api/v1/auth/logout", auth.logout.bind(auth));

  // Finish public OPTIONS responses before entering group-scoped routes.
  router.use(publicRoutes);

  router.use(groupSlugMiddleware(database));
  router.get(["/groups/users", "/api/v1/groups/users"], authenticate, groupUserList.list.bind(groupUserList));
  router.post(["/groups/users/:id/account", "/api/v1/groups/users/:id/account"],
    authenticate, groupUserAccounts.create.bind(groupUserAccounts));
  router.post(["/user", "/api/v1/user", "/groups/users", "/api/v1/groups/users"],
    authenticate, groupUsers.create.bind(groupUsers));
  router.get(["/users/me", "/api/v1/users/me"], authenticate, users.me.bind(users));
  router.get(["/cycles", "/api/v1/cycles"], authenticate, cycles.list.bind(cycles));
  router.post(["/cycles", "/api/v1/cycles"], authenticate, cycles.create.bind(cycles));
  router.patch(["/cycles/:id", "/api/v1/cycles/:id"], authenticate, cycles.update.bind(cycles));
  router.get("/", home.index.bind(home));
  // The legacy username/password login still requires a resolved group.
  router.get("/api/v1/auth", legacyAuth.index.bind(legacyAuth));
  router.post("/api/v1/auth/login", legacyAuth.login.bind(legacyAuth));

  return router;
}

module.exports = createRouter;
