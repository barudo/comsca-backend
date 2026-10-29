const { cents, decimal } = require('../services/cycle-distributions');

class MePayoutsHandler {
  async get(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(async trx => {
        await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        const group_id = request.group.id;
        const user = await trx('users').where({ group_id, auth_user_id: request.authUser.id })
          .first('id', 'first_name', 'family_name', 'username');
        if (!user) throw Object.assign(new Error('You do not have a user profile in this group'), { status: 403 });
        await trx.raw('SET LOCAL ROLE comsca_group_reader');
        await trx.raw("SELECT set_config('app.group_id', ?, true)", [String(group_id)]);
        const cycle = await trx('cycles').where({ group_id, status: 'distributing' }).first('id', 'status');
        if (!cycle) return { cycle: null, distribution: null };
        const declaration = await trx('cycle_distribution_declarations').where({ group_id, cycle_id: cycle.id }).first('cycle_id');
        if (!declaration) throw Object.assign(new Error('This cycle has no stored distribution declaration; manual reconciliation is required'), { status: 409 });
        const row = await trx('cycle_distributions').where({ group_id, cycle_id: cycle.id, user_id: user.id }).first('*');
        return { cycle, distribution: row ? { ...row, user, remaining_amount: decimal(cents(row.net_amount) - cents(row.paid_amount)) } : null };
      });
      return response.json({ success: true, ...result });
    } catch (error) {
      if ([403, 409].includes(error.status)) return response.status(error.status).json({ success: false, error: error.message });
      return next(error);
    }
  }
}
module.exports = MePayoutsHandler;
