import type { Knex } from "knex";

export type Id = string | number;
export interface FreezeScope { groupId: Id; authUserId: string; cycleId: Id }
export interface CycleFreezeState {
  id: Id;
  group_id: Id;
  status: "draft" | "active" | "distributing" | "closed";
  updated_at: Date;
  transactions_frozen: boolean;
  transactions_frozen_at: Date | null;
  transactions_frozen_by: Id | null;
  transactions_unfrozen_at: Date | null;
  transactions_unfrozen_by: Id | null;
}
export interface FreezeStatus {
  cycleId: Id;
  transactionsFrozen: boolean;
  frozenAt: Date | null;
  frozenBy: { id: Id; name: string } | null;
  unfrozenAt: Date | null;
  unfrozenBy: { id: Id; name: string } | null;
  canManageFreeze: boolean;
}
export const FROZEN_MESSAGE = "Transactions are currently frozen. Only the group owner or administrator can unfreeze transactions.";
function fail(message: string, status: number, code?: string): never {
  throw Object.assign(new Error(message), { status, code });
}
export function validateCycleId(value: unknown): string {
  if ((typeof value !== "string" && typeof value !== "number") ||
      (typeof value === "number" && !Number.isSafeInteger(value)) ||
      !/^[1-9][0-9]{0,18}$/.test(String(value)) || BigInt(value) > 9223372036854775807n) {
    fail("cycleId must be a positive bigint ID", 400);
  }
  return String(value);
}
export function validateReason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 4000 || value.includes("\u0000")) {
    fail("reason must be text of at most 4000 characters without null characters", 400);
  }
  return value.trim() || null;
}
// The caller must keep this transaction open through every dependent financial write.
// No bypass parameter: distribution posting uses its separately authorized service.
export async function assertCycleTransactionsUnfrozen(cycleId: Id | null, trx: Knex.Transaction,
  context: { groupId: Id }) {
  if (!trx.isTransaction) fail("A posting transaction is required", 500);
  if (cycleId === null || cycleId === undefined) fail("Assign a cycle before modifying this transaction", 409);
  const cycle = await trx("cycles").where({ id: validateCycleId(cycleId), group_id: context.groupId })
    .forUpdate().first("id", "status", "transactions_frozen");
  if (!cycle) fail("Cycle not found in this group", 404);
  if (cycle.status !== "active") fail("Only active cycles accept ordinary financial transactions", 409);
  if (cycle.transactions_frozen !== false) fail(FROZEN_MESSAGE, 423, "TRANSACTIONS_FROZEN");
  return cycle;
}
async function actorFor(trx: Knex.Transaction, scope: FreezeScope) {
  const actor = await trx("users").where({ group_id: scope.groupId, auth_user_id: scope.authUserId })
    .forShare().first("id", "role");
  if (!actor) fail("Group membership is required", 403);
  return actor;
}
async function statusData(trx: Knex.Transaction, cycle: CycleFreezeState, canManageFreeze: boolean): Promise<FreezeStatus> {
  const actorIds = [cycle.transactions_frozen_by, cycle.transactions_unfrozen_by].filter(value => value !== null && value !== undefined);
  const actors = actorIds.length ? await trx("users").where({ group_id: cycle.group_id })
    .whereIn("id", actorIds).select("id", "first_name", "family_name") : [];
  const identity = (id: Id | null) => {
    const actor = actors.find(actor => String(actor.id) === String(id));
    return actor ? { id: actor.id, name: `${actor.first_name} ${actor.family_name}` } : null;
  };
  return { cycleId: cycle.id, transactionsFrozen: cycle.transactions_frozen,
    frozenAt: cycle.transactions_frozen_at, frozenBy: identity(cycle.transactions_frozen_by),
    unfrozenAt: cycle.transactions_unfrozen_at, unfrozenBy: identity(cycle.transactions_unfrozen_by), canManageFreeze };
}
export async function getCycleFreezeStatus(trx: Knex.Transaction, scope: FreezeScope) {
  const cycleId = validateCycleId(scope.cycleId);
  const actor = await actorFor(trx, scope);
  const cycle = await trx<CycleFreezeState>("cycles").where({ id: cycleId, group_id: scope.groupId }).first("*");
  if (!cycle) fail("Cycle not found in this group", 404);
  return statusData(trx, cycle, ["OWNER", "ADMIN"].includes(actor.role));
}
export async function transitionCycleFreeze(trx: Knex.Transaction,
  scope: FreezeScope & { frozen: boolean; reason?: unknown }) {
  if (!trx.isTransaction) fail("A freeze transaction is required", 500);
  const cycleId = validateCycleId(scope.cycleId);
  const reason = validateReason(scope.reason);
  const actor = await actorFor(trx, scope);
  if (!["OWNER", "ADMIN"].includes(actor.role)) fail("Only an OWNER or ADMIN of this group can manage transaction freeze", 403);
  let cycle = await trx<CycleFreezeState>("cycles").where({ id: cycleId, group_id: scope.groupId }).forUpdate().first("*");
  if (!cycle) fail("Cycle not found in this group", 404);
  if (!scope.frozen && cycle.status !== "active") fail("Only active cycles can unfreeze transactions", 409);
  if (cycle.transactions_frozen !== scope.frozen) {
    const timestamp = trx.raw("clock_timestamp()");
    const change = scope.frozen ? { transactions_frozen_at: timestamp, transactions_frozen_by: actor.id }
      : { transactions_unfrozen_at: timestamp, transactions_unfrozen_by: actor.id };
    [cycle] = await trx<CycleFreezeState>("cycles").where({ id: cycleId, group_id: scope.groupId })
      .update({ transactions_frozen: scope.frozen, ...change, updated_at: timestamp }).returning("*");
    await trx("cycle_freeze_logs").insert({ group_id: scope.groupId, cycle_id: cycleId,
      performed_by: actor.id, previous_state: !scope.frozen, new_state: scope.frozen, action: scope.frozen ? "FREEZE" : "UNFREEZE", performed_at: scope.frozen ? cycle.transactions_frozen_at : cycle.transactions_unfrozen_at, reason });
  }
  return statusData(trx, cycle, true);
}
