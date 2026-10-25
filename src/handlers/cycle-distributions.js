const { retrieve } = require('../services/cycle-distributions');
class CycleDistributionsHandler {
  async list(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(async trx => {
        await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        const group_id = request.group.id;
        const actor = await trx('users').where({ group_id, auth_user_id: request.authUser.id }).first('id', 'role');
        if (!actor || !['OWNER', 'ADMIN', 'TREASURER', 'AUDITOR'].includes(actor.role)) {
          throw Object.assign(new Error('A financial role in this group is required to read distributions'), { status: 403 });
        }
        const cycle_id = request.params.cycleId;
        if (!/^[1-9][0-9]{0,18}$/.test(cycle_id) || BigInt(cycle_id) > 9223372036854775807n) {
          throw Object.assign(new Error('A valid cycle ID is required'), { status: 400 });
        }
        await trx.raw('SET LOCAL ROLE comsca_group_reader');
        await trx.raw("SELECT set_config('app.group_id', ?, true)", [String(group_id)]);
        const cycle = await trx('cycles').where({ group_id, id: cycle_id }).first('id', 'status');
        if (!cycle) throw Object.assign(new Error('Cycle not found in this group'), { status: 404 });
        return { cycle, ...await retrieve(trx, group_id, cycle_id, ['distributing', 'closed'].includes(cycle.status)) };
      });
      return response.json({ success: true, ...result });
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.status)) return response.status(error.status).json({ success: false, error: error.message });
      return next(error);
    }
  }
}
module.exports = CycleDistributionsHandler;
