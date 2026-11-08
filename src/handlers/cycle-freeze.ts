import type { Request, Response, NextFunction } from "express";
import type { Knex } from "knex";
import { getCycleFreezeStatus, transitionCycleFreeze } from "../services/cycle-freeze";
type ScopedRequest = Request & { group: { id: string }; authUser: { id: string } };
export class CycleFreezeHandler {
  async status(request: ScopedRequest, response: Response, next: NextFunction) {
    return this.run(request, response, next);
  }
  async freeze(request: ScopedRequest, response: Response, next: NextFunction) {
    return this.run(request, response, next, true);
  }
  async unfreeze(request: ScopedRequest, response: Response, next: NextFunction) {
    return this.run(request, response, next, false);
  }
  private async run(request: ScopedRequest, response: Response, next: NextFunction, frozen?: boolean) {
    try {
      const scope = { groupId: request.group.id, authUserId: request.authUser.id, cycleId: request.params.cycleId as string };
      const body = request.body ?? {};
      if (frozen !== undefined && (typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).some(key => key !== "reason"))) {
        return response.status(400).json({ success: false, error: "Provide only an optional reason" });
      }
      const data = await request.app.locals.database.transaction((trx: Knex.Transaction) => frozen === undefined
        ? getCycleFreezeStatus(trx, scope) : transitionCycleFreeze(trx, { ...scope, frozen, reason: body.reason }));
      return response.json({ success: true, data });
    } catch (error: any) {
      if ([400, 403, 404, 409].includes(error.status)) {
        return response.status(error.status).json({ success: false, error: error.message });
      }
      return next(error);
    }
  }
}
