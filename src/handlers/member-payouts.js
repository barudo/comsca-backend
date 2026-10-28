const { cents, decimal } = require('../services/cycle-distributions');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function id(value) {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isSafeInteger(value)) ||
      !/^[1-9][0-9]{0,18}$/.test(String(value)) || BigInt(value) > 9223372036854775807n) fail('A valid positive ID is required');
  return String(value);
}
function parse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['user_id', 'credit', 'amount', 'idempotency_key'].includes(key))) fail('Invalid payout fields');
  const user_id = id(body.user_id), credit = id(body.credit);
  if (typeof body.idempotency_key !== 'string' || !/^[\x20-\x7e]{1,128}$/.test(body.idempotency_key)) fail('Provide a 1–128 character printable ASCII idempotency_key');
  if (!['string', 'number'].includes(typeof body.amount) || !/^\d+(?:\.\d{1,2})?$/.test(String(body.amount)) ||
      (typeof body.amount === 'number' && (!Number.isFinite(body.amount) || body.amount > 1_000_000_000_000))) fail('Provide a positive decimal amount with at most two decimal places; send large amounts as strings');
  const amount = cents(body.amount);
  if (amount <= 0n || amount > 999999999999999999n) fail('Amount must be positive and fit numeric(18,2)');
  return { user_id, credit, amount: decimal(amount), idempotency_key: body.idempotency_key };
}
async function authorize(trx, request, read = false) {
  const query = trx('users').where({ group_id: request.group.id, auth_user_id: request.authUser.id });
  if (!read) query.forShare();
  const actor = await query.first('id', 'role');
  if (!actor || !['OWNER', 'ADMIN', 'TREASURER', ...(read ? ['AUDITOR'] : [])].includes(actor.role)) fail('A financial role in this group is required', 403);
}
function handleError(error, response, next) {
  if ([400, 403, 404, 409].includes(error.status)) return response.status(error.status).json({ success: false, error: error.message });
  if (['22003', '23001', '23503', '23505', '23514', '40001', '40P01'].includes(error.code)) return response.status(409).json({ success: false, error: 'Payout could not be committed; refresh and retry' });
  return next(error);
}
class MemberPayoutsHandler {
  async create(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(async trx => {
        await authorize(trx, request);
        const group_id = request.group.id, cycle_id = id(request.params.cycleId), input = parse(request.body);
        const cycle = await trx('cycles').where({ group_id, id: cycle_id }).forUpdate().first('*');
        if (!cycle) fail('Cycle not found in this group', 404);
        if (cycle.status !== 'distributing') fail('Payouts require a distributing cycle', 409);
        const prior = await trx('member_payouts').where({ group_id, cycle_id, idempotency_key: input.idempotency_key }).first('*');
        if (prior) {
          if (String(prior.user_id) !== input.user_id || String(prior.credit) !== input.credit || prior.amount !== input.amount) fail('Idempotency key already used with a different payout', 409);
          return { replay: true, payout: prior,
            distribution: await trx('cycle_distributions').where({ group_id, cycle_id, user_id: prior.user_id }).first('*'),
            transaction: await trx('transactions').where({ group_id, id: prior.transaction_id }).first('*') };
        }
        const distribution = await trx('cycle_distributions').where({ group_id, cycle_id, user_id: input.user_id }).forUpdate().first('*');
        if (!distribution) fail('Declared member not found in this cycle', 404);
        if (cents(input.amount) > cents(distribution.net_amount) - cents(distribution.paid_amount)) fail('Payout exceeds remaining entitlement', 409);
        const accounts = await trx('accounts').where({ group_id, cycle_id }).whereIn('id', [distribution.payable_account_id, input.credit]).orderBy('id').forUpdate().select('*');
        const debit = accounts.find(a => String(a.id) === String(distribution.payable_account_id));
        const credit = accounts.find(a => String(a.id) === input.credit);
        if (!debit || !credit) fail('Account not found in this group and cycle', 404);
        if (debit.type !== 'LIABILITY' || debit.distribution_role !== 'DISTRIBUTION_PAYABLE') fail('Declared payable must be a DISTRIBUTION_PAYABLE liability');
        if (credit.type !== 'ASSET' || ['1100', '1300', '1400'].includes(credit.code) ||
            !(credit.distribution_role === 'CASH' || (!credit.distribution_role && credit.code === '1000'))) fail('Funding account must be classified as cash');
        const { rows: [funding] } = await trx.raw('SELECT COALESCE(SUM(amount),0) >= ?::numeric AS sufficient FROM account_entries WHERE group_id=? AND account_id=?', [input.amount, group_id, input.credit]);
        if (!funding.sufficient) fail('Insufficient cash in funding account', 409);
        const [counter] = await trx('cycles').where({ group_id, id: cycle_id }).increment('disbursement_voucher_counter', 1).returning('disbursement_voucher_counter');
        const [transaction] = await trx('transactions').insert({ group_id, cycle_id, user_id: input.user_id, type: 'MEMBER_PAYOUT', amount: input.amount,
          document_type: 'DISBURSEMENT_VOUCHER', document_number: counter.disbursement_voucher_counter }).returning('*');
        const [entry] = await trx('transaction_entries').insert({ group_id, cycle_id, user_id: input.user_id, transaction_id: transaction.id,
          type: 'MEMBER_PAYOUT', debit: debit.id, credit: credit.id, amount: input.amount }).returning('id');
        await trx('account_entries').insert([
          { group_id, transaction_entry_id: entry.id, account_id: debit.id, amount: input.amount },
          { group_id, transaction_entry_id: entry.id, account_id: credit.id, amount: `-${input.amount}` },
        ]);
        const [payout] = await trx('member_payouts').insert({ group_id, cycle_id, ...input, debit: debit.id, transaction_id: transaction.id }).returning('*');
        const paid = cents(distribution.paid_amount) + cents(input.amount);
        const [updated] = await trx('cycle_distributions').where({ group_id, id: distribution.id }).update({ paid_amount: decimal(paid),
          status: paid === cents(distribution.net_amount) ? 'paid' : 'partial', updated_at: trx.fn.now() }).returning('*');
        return { replay: false, payout, distribution: updated, transaction };
      });
      const { replay, ...body } = result;
      return response.status(replay ? 200 : 201).json({ success: true, ...body });
    } catch (error) { return handleError(error, response, next); }
  }
  async list(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(async trx => {
        await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        await authorize(trx, request, true);
        const group_id = request.group.id, cycle_id = id(request.params.cycleId);
        await trx.raw('SET LOCAL ROLE comsca_group_reader');
        await trx.raw("SELECT set_config('app.group_id', ?, true)", [String(group_id)]);
        const cycle = await trx('cycles').where({ group_id, id: cycle_id }).first('id', 'status');
        if (!cycle) fail('Cycle not found in this group', 404);
        return { cycle, payouts: await trx('member_payouts').where({ group_id, cycle_id }).orderBy('id').select('*') };
      });
      return response.json({ success: true, ...result });
    } catch (error) { return handleError(error, response, next); }
  }
}
module.exports = MemberPayoutsHandler;
module.exports.parse = parse;
