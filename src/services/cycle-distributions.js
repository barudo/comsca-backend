const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };
const maximumCents = 999999999999999999n;
function cents(value) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) fail('Invalid fixed-point ledger amount; reconcile before declaration');
  return (match[1] ? -1n : 1n) * (BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0')));
}
function decimal(value) {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
const compareId = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
function allocate(earnings, capital) {
  const total = [...capital.values()].reduce((sum, value) => sum + value, 0n);
  if (total <= 0n || [...capital.values()].some(value => value < 0n)) fail('Positive total refundable capital is required');
  if (earnings < -total) fail('Losses exceed refundable capital; reconcile before declaration');
  const magnitude = earnings < 0n ? -earnings : earnings;
  const rows = [...capital].map(([user_id, amount]) => ({ user_id, amount: magnitude * amount / total, remainder: magnitude * amount % total }));
  rows.sort((a, b) => a.remainder === b.remainder ? compareId(a.user_id, b.user_id) : a.remainder > b.remainder ? -1 : 1);
  let remaining = magnitude - rows.reduce((sum, row) => sum + row.amount, 0n);
  for (const row of rows) { if (remaining > 0n) { row.amount += 1n; remaining -= 1n; } }
  return new Map(rows.map(row => [row.user_id, earnings < 0n ? -row.amount : row.amount]));
}

// Only an explicit role or a BUY_SHARE posting identifies refundable equity.
// Account names, Contribution Income, and dashboard purchase totals do not.
function analyzeLedger(members, postings) {
  const capital = new Map(members.map(member => [String(member.user_id), 0n]));
  const capitalAccounts = new Map();
  const receivables = new Map();
  const loans = new Map();
  const balances = new Map();
  const unsupported = new Map();
  let cash = 0n;
  let ledgerTotal = 0n;
  for (const posting of postings) {
    const amount = cents(posting.amount);
    const member = posting.user_id === null ? null : String(posting.user_id);
    const accountId = String(posting.account_id);
    ledgerTotal += amount;
    const account = balances.get(accountId) || { ...posting, balance: 0n };
    account.balance += amount;
    balances.set(accountId, account);
    if (posting.account_cycle_id !== null && String(posting.account_cycle_id) !== String(posting.cycle_id)) fail('Ledger account cycle is inconsistent');
    const role = posting.distribution_role;
    const roleTypes = { MEMBER_CAPITAL: 'EQUITY', EARNINGS: 'EQUITY', DISTRIBUTION_PAYABLE: 'LIABILITY', CASH: 'ASSET', RECEIVABLE: 'ASSET' };
    if (role && roleTypes[role] !== posting.type) fail('Account distribution role conflicts with its type');
    if (posting.type === 'ASSET' && ['1100', '1300', '1400'].includes(posting.code) && role && role !== 'RECEIVABLE') fail('Collectible account has an incompatible distribution role');
    if (posting.type === 'EQUITY') {
      if (!(role === 'MEMBER_CAPITAL' || (!role && posting.component_type === 'BUY_SHARE'))) {
        const key = `${member}:${accountId}`;
        unsupported.set(key, (unsupported.get(key) || 0n) + amount);
        continue;
      }
      if (!capital.has(member)) fail('Capital has missing or ineligible member attribution');
      const key = `${member}:${accountId}`;
      const part = capitalAccounts.get(key) || { user_id: member, account_id: accountId, amount: 0n };
      part.amount -= amount;
      capitalAccounts.set(key, part);
      capital.set(member, capital.get(member) - amount);
    } else if (posting.type === 'ASSET') {
      if (posting.distribution_role === 'CASH' || (!posting.distribution_role && posting.code === '1000')) cash += amount;
      else {
        if (role !== 'RECEIVABLE' && !['1100', '1300', '1400'].includes(posting.code)) {
          const key = `${member}:${accountId}`;
          unsupported.set(key, (unsupported.get(key) || 0n) + amount);
          continue;
        }
        if (!capital.has(member)) fail('Receivable has missing or ineligible member attribution');
        const key = `${member}:${accountId}`;
        const target = posting.code === '1100' ? loans : receivables;
        const part = target.get(key) || { user_id: member, account_id: accountId, amount: 0n };
        part.amount += amount;
        target.set(key, part);
      }
    } else if (!['INCOME', 'EXPENSE', 'LIABILITY'].includes(posting.type)) fail('Unsupported ledger account type');
  }
  if (ledgerTotal !== 0n) fail('Cycle ledger is unbalanced');
  if ([...unsupported.values()].some(amount => amount !== 0n)) fail('Unsupported asset or equity balance; reconcile account classification before declaration');
  if ([...receivables.values()].some(part => part.amount !== 0n)) fail('Outstanding contributions, penalties or unsupported collectibles must be reconciled before declaration');
  if ([...loans.values()].some(part => part.amount < 0n)) fail('Negative loan balances require reconciliation');
  if ([...capitalAccounts.values()].some(part => part.amount < 0n)) fail('Negative member capital balance requires reconciliation');
  if (cash < 0n) fail('Negative cash balance requires reconciliation');
  const closing = [...balances.values()].filter(account => ['INCOME', 'EXPENSE'].includes(account.type) && account.balance !== 0n)
    .sort((a, b) => compareId(a.account_id, b.account_id));
  const earnings = -closing.reduce((sum, account) => sum + account.balance, 0n);
  const allocation = allocate(earnings, capital);
  return { capital, capitalAccounts: [...capitalAccounts.values()], loans: [...loans.values()], closing, earnings, allocation, cash };
}

async function distributionAccount(trx, group_id, cycle_id, role, code, name, type) {
  const candidates = await trx('accounts').where({ group_id, cycle_id })
    .where(function () { this.where('distribution_role', role).orWhere('code', code).orWhereRaw('lower(trim(name)) = ANY(?::text[])', [role === 'EARNINGS' ? ['retained earnings', 'distributable earnings'] : ['member distribution payable', 'member distributions payable']]); })
    .forUpdate().select('*');
  if (candidates.length > 1 || (candidates.length === 1 && (candidates[0].type !== type ||
      (candidates[0].distribution_role && candidates[0].distribution_role !== role) ||
      (candidates[0].distribution_role !== role && !(role === 'EARNINGS' ? ['retained earnings', 'distributable earnings'] : ['member distribution payable', 'member distributions payable']).includes(candidates[0].name.trim().toLowerCase()))))) {
    fail(`Ambiguous or incompatible ${name} account; reconcile before declaration`);
  }
  if (candidates.length) {
    const account = candidates[0];
    await trx('accounts').where({ group_id, id: account.id }).update({ distribution_role: role });
    return account.id;
  }
  const [account] = await trx('accounts').insert({ group_id, cycle_id, code, name, type, distribution_role: role }).returning('id');
  return account.id;
}

async function journal(trx, group_id, cycle_id, user_id, type, pairs) {
  pairs = pairs.filter(pair => pair.amount > 0n);
  if (!pairs.length) return null;
  const total = pairs.reduce((sum, pair) => sum + pair.amount, 0n);
  if (total > maximumCents || pairs.some(pair => pair.amount > maximumCents)) fail('Distribution journal exceeds supported amount precision');
  const [counter] = await trx('cycles').where({ group_id, id: cycle_id }).increment('journal_voucher_counter', 1).returning('journal_voucher_counter');
  const [header] = await trx('transactions').insert({ group_id, cycle_id, user_id, type,
    amount: decimal(total), document_type: 'JOURNAL_VOUCHER', document_number: counter.journal_voucher_counter }).returning('id');
  for (const pair of pairs) {
    const [entry] = await trx('transaction_entries').insert({ group_id, cycle_id, user_id, transaction_id: header.id,
      type: pair.type || type, amount: decimal(pair.amount), debit: pair.debit, credit: pair.credit }).returning('id');
    await trx('account_entries').insert([
      { group_id, transaction_entry_id: entry.id, account_id: pair.debit, amount: decimal(pair.amount) },
      { group_id, transaction_entry_id: entry.id, account_id: pair.credit, amount: decimal(-pair.amount) },
    ]);
  }
  return header.id;
}

async function retrieve(trx, group_id, cycle_id, required = false) {
  const declaration = await trx('cycle_distribution_declarations').where({ group_id, cycle_id }).first('*');
  if (!declaration) {
    if (required) fail('This cycle has no stored distribution declaration; manual reconciliation is required');
    return { summary: null, distributions: [] };
  }
  const distributions = await trx('cycle_distributions').where({ group_id, cycle_id }).orderBy('user_id').select('*');
  return { summary: { ...declaration.summary, total_paid: decimal(distributions.reduce((sum, row) => sum + cents(row.paid_amount), 0n)), members: distributions.map(row => ({ user_id: row.user_id, capital: row.capital_amount, earnings: row.earnings_amount, gross_distribution: row.gross_amount, loan_deduction: row.loan_deduction, contribution_deduction: row.contribution_deduction, penalty_deduction: row.penalty_deduction, net_distribution: row.net_amount, paid_amount: row.paid_amount, status: row.status })) }, distributions, closing_transaction_ids: declaration.closing_transaction_ids,
    declared_at: declaration.created_at, declared_by: declaration.declared_by };
}

// Caller holds the cycle row lock for the entire enclosing write transaction.
async function declare(trx, cycle, actor) {
  const group_id = cycle.group_id;
  const cycle_id = cycle.id;
  const existing = await trx('cycle_distribution_declarations').where({ group_id, cycle_id }).first('cycle_id');
  if (existing) return retrieve(trx, group_id, cycle_id, true);
  const members = await trx('cycle_members as cm').join('users as u', 'u.id', 'cm.user_id')
    .where({ 'cm.cycle_id': cycle_id, 'u.group_id': group_id }).select('cm.user_id');
  const postings = await trx('account_entries as p').join('transaction_entries as e', 'e.id', 'p.transaction_entry_id')
    .join('transactions as t', 't.id', 'e.transaction_id').join('accounts as a', 'a.id', 'p.account_id')
    .where({ 'p.group_id': group_id, 'e.group_id': group_id, 't.group_id': group_id, 'a.group_id': group_id,
      't.cycle_id': cycle_id, 't.status': 'active' }).whereNull('p.reversal_of_id')
    .select('p.account_id', 'p.amount', 'a.type', 'a.code', 'a.distribution_role', 't.cycle_id',
      'a.cycle_id as account_cycle_id', 'e.type as component_type', trx.raw('COALESCE(e.user_id,t.user_id) AS user_id'));
  const analysis = analyzeLedger(members, postings);
  const capitalTotal = [...analysis.capital.values()].reduce((sum, amount) => sum + amount, 0n);
  const grossTotal = capitalTotal + analysis.earnings;
  const deductions = new Map();
  for (const [user, capital] of analysis.capital) {
    let available = capital + analysis.allocation.get(user);
    const offsets = [];
    for (const loan of analysis.loans.filter(row => row.user_id === user).sort((a,b) => compareId(a.account_id,b.account_id))) {
      const amount = loan.amount < available ? loan.amount : available;
      if (amount > 0n) offsets.push({ ...loan, amount });
      available -= amount;
    }
    deductions.set(user, offsets);
  }
  const deductionTotal = [...deductions.values()].flat().reduce((sum, row) => sum + row.amount, 0n);
  const netTotal = grossTotal - deductionTotal;
  if ([capitalTotal, netTotal, analysis.earnings < 0n ? -analysis.earnings : analysis.earnings].some(value => value > maximumCents)) fail('Distribution totals exceed supported amount precision');
  const payable = await distributionAccount(trx, group_id, cycle_id, 'DISTRIBUTION_PAYABLE', '2100', 'Member Distribution Payable', 'LIABILITY');
  const retained = await distributionAccount(trx, group_id, cycle_id, 'EARNINGS', '3100', 'Retained Earnings', 'EQUITY');
  const closing_transaction_ids = [];
  for (const account of analysis.closing) {
    const amount = account.balance < 0n ? -account.balance : account.balance;
    closing_transaction_ids.push(await journal(trx, group_id, cycle_id, null, 'DISTRIBUTION_CLOSE', [{ amount,
      debit: account.balance < 0n ? account.account_id : retained,
      credit: account.balance < 0n ? retained : account.account_id }]));
  }
  const summary = { cycle_id, status: 'distributing', total_capital: decimal(capitalTotal), net_earnings: decimal(analysis.earnings),
    gross_distribution: decimal(grossTotal), total_deductions: decimal(deductionTotal), net_distribution: decimal(netTotal), total_paid: '0.00',
    cash_available: decimal(analysis.cash), cash_shortfall: decimal(netTotal > analysis.cash ? netTotal - analysis.cash : 0n),
    member_count: members.length, warnings: analysis.cash < netTotal ? ['INSUFFICIENT_CASH'] : [] };
  await trx('cycle_distribution_declarations').insert({ group_id, cycle_id, declared_by: actor.id, summary, closing_transaction_ids });
  for (const [user_id, capital] of [...analysis.capital].sort(([a], [b]) => compareId(a, b))) {
    const earnings = analysis.allocation.get(user_id);
    const pairs = analysis.capitalAccounts.filter(part => part.user_id === user_id).map(part => ({
      type: 'DISTRIBUTION_CAPITAL', debit: part.account_id, credit: payable, amount: part.amount }));
    if (earnings !== 0n) pairs.push({ type: 'DISTRIBUTION_EARNINGS', debit: earnings > 0n ? retained : payable,
      credit: earnings > 0n ? payable : retained, amount: earnings > 0n ? earnings : -earnings });
    const offsets = deductions.get(user_id);
    const loanDeduction = offsets.reduce((sum, row) => sum + row.amount, 0n);
    pairs.push(...offsets.map(loan => ({ type: 'DISTRIBUTION_LOAN_OFFSET', debit: payable, credit: loan.account_id, amount: loan.amount })));
    const transaction_id = await journal(trx, group_id, cycle_id, user_id, 'DISTRIBUTION', pairs);
    await trx('cycle_distributions').insert({ group_id, cycle_id, user_id, capital_amount: decimal(capital),
      earnings_amount: decimal(earnings), gross_amount: decimal(capital + earnings), net_amount: decimal(capital + earnings - loanDeduction),
      loan_deduction: decimal(loanDeduction), total_deductions: decimal(loanDeduction), distribution_transaction_id: transaction_id, payable_account_id: payable });
  }
  return retrieve(trx, group_id, cycle_id, true);
}
module.exports = { declare, retrieve, analyzeLedger, allocate, cents, decimal };
