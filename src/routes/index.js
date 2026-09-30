const express = require("express");
const authenticate = require("../middleware/authenticate");
const groupSlugMiddleware = require("../middleware/group-slug");
const CyclesHandler = require("../handlers/cycles");
const CycleAccountsHandler = require("../handlers/cycle-accounts");
const CycleMembersHandler = require("../handlers/cycle-members");
const ContributionsHandler = require("../handlers/contributions");
const PenaltiesHandler = require("../handlers/penalties");
const InterestsHandler = require("../handlers/interests");
const LoanDisbursementsHandler = require("../handlers/loan-disbursements");
const PaymentTransactionsHandler = require("../handlers/payment-transactions");
const GroupUsersHandler = require("../handlers/group-users");
const GroupUserListHandler = require("../handlers/group-user-list");
const GroupUserAccountsHandler = require("../handlers/group-user-accounts");
const UsersHandler = require("../handlers/users");
const LegacyAuthHandler = require("../handlers/legacy-auth");
const GroupsHandler = require("../handlers/groups");
const HooksHandler = require("../handlers/hooks");
const RegistrationHandler = require("../handlers/registration");
const SupabaseAuthHandler = require("../handlers/supabase-auth");

function createRouter(database) {
  const router = express.Router();
  const cycles = new CyclesHandler();
  const cycleAccounts = new CycleAccountsHandler();
  const cycleMembers = new CycleMembersHandler();
  const contributions = new ContributionsHandler();
  const penalties = new PenaltiesHandler();
  const interests = new InterestsHandler();
  const loanDisbursements = new LoanDisbursementsHandler();
  const paymentTransactions = new PaymentTransactionsHandler();
  const groupUsers = new GroupUsersHandler();
  const groupUserList = new GroupUserListHandler();
  const groupUserAccounts = new GroupUserAccountsHandler();
  const users = new UsersHandler();
  const legacyAuth = new LegacyAuthHandler();
  const groups = new GroupsHandler();
  const hooks = new HooksHandler();
  const registration = new RegistrationHandler();
  const auth = new SupabaseAuthHandler();

  // Include early JSON/group errors in the current-user update cache policy.
  router.use(["/api/v1/users/me", "/api/v1/users/me/password"], (request, response, next) => {
    if (request.method === "PUT") response.set("Cache-Control", "no-store");
    next();
  });

  const publicRoutes = express.Router();
  // Verify webhook signatures against the original bytes before JSON parsing.
  publicRoutes.use("/api/v1/hooks", express.raw({ type: "application/json", limit: "32kb" }));
  publicRoutes.post("/api/v1/hooks/sms", hooks.sms.bind(hooks));
  publicRoutes.use(express.json({ limit: "32kb" }));

  // Registration and authentication resolve identity without a group header.
  publicRoutes.post("/api/v1/user/register", registration.register.bind(registration));
  publicRoutes.post("/api/v1/user/verify", registration.verify.bind(registration));
  publicRoutes.get("/api/v1/groups/validate-slug", groups.validateSlug.bind(groups));
  publicRoutes.post("/api/v1/auth/login/password", auth.loginPassword.bind(auth));
  publicRoutes.post("/api/v1/auth/login/otp/request", auth.requestOtp.bind(auth));
  publicRoutes.post("/api/v1/auth/login/otp/verify", auth.verifyOtp.bind(auth));
  publicRoutes.post("/api/v1/auth/refresh", auth.refresh.bind(auth));
  publicRoutes.post("/api/v1/auth/logout", auth.logout.bind(auth));

  // Finish public OPTIONS responses before entering group-scoped routes.
  router.use(publicRoutes);

  router.use(groupSlugMiddleware(database));
  router.get("/api/v1/groups/users", authenticate, groupUserList.list.bind(groupUserList));
  router.post("/api/v1/groups/users/:id/account",
    authenticate, groupUserAccounts.create.bind(groupUserAccounts));
  router.post(["/api/v1/user", "/api/v1/groups/users"],
    authenticate, groupUsers.create.bind(groupUsers));
  router.put("/api/v1/groups/users/:id", authenticate, groupUsers.update.bind(groupUsers));
  router.get("/api/v1/users/me", authenticate, users.me.bind(users));
  router.put("/api/v1/users/me", authenticate, users.update.bind(users));
  router.put("/api/v1/users/me/password", authenticate, users.password.bind(users));
  router.get("/api/v1/cycles", authenticate, cycles.list.bind(cycles));
  router.get("/api/v1/cycles/accounts", authenticate, cycleAccounts.list.bind(cycleAccounts));
  router.get(["/api/v1/cylces/members", "/api/v1/cycles/members"], authenticate, cycleMembers.list.bind(cycleMembers));
  router.post("/api/v1/cycles/members", authenticate, cycleMembers.create.bind(cycleMembers));
  router.post("/api/v1/contributions/charge", authenticate, contributions.create.bind(contributions));
  router.post("/api/v1/penalties/charge", authenticate, penalties.create.bind(penalties));
  router.post("/api/v1/interests/charge", authenticate, interests.charge.bind(interests));
  router.post("/api/v1/transactions/disburse-loans", authenticate, loanDisbursements.create.bind(loanDisbursements));
  router.post("/api/v1/transactions/payments", authenticate, paymentTransactions.create.bind(paymentTransactions));
  router.post("/api/v1/cycles", authenticate, cycles.create.bind(cycles));
  router.put("/api/v1/cycles/:id", authenticate, cycles.update.bind(cycles));
  router.patch("/api/v1/cycles/:id", authenticate, cycles.update.bind(cycles));
  // The legacy username/password login still requires a resolved group.
  router.get("/api/v1/auth", legacyAuth.index.bind(legacyAuth));
  router.post("/api/v1/auth/login", legacyAuth.login.bind(legacyAuth));

  return router;
}

module.exports = createRouter;
