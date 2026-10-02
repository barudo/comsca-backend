// Keep the chart local to this migration so later template changes do not
// change the behavior of an already published migration or its rollback.
const accounts = [
  ['1000', 'Cash', 'ASSET'],
  ['1100', 'Loans Receivable', 'ASSET'],
  ['1300', 'Penalties Receivable', 'ASSET'],
  ['1400', 'Contributions Receivable', 'ASSET'],
  ['2000', 'Accounts Payable', 'LIABILITY'],
  ['3000', 'Equity', 'EQUITY'],
  ['4000', 'Interest Income', 'INCOME'],
  ['4100', 'Penalty Income', 'INCOME'],
  ['4200', 'Other Income', 'INCOME'],
  ['4300', 'Donation Income', 'INCOME'],
  ['4400', 'Contribution Income', 'INCOME'],
  ['5000', 'Operating Expenses', 'EXPENSE'],
  ['5100', 'Member Assistance Expense', 'EXPENSE'],
];

async function replaceTemplate(knex, chart) {
  // Values are migration-owned constants, never request or database input.
  const tuples = chart.map(row => `('${row.join("','")}')`).join(',');
  await knex.raw(`LOCK TABLE public.cycles, public.accounts IN ACCESS EXCLUSIVE MODE;
    CREATE OR REPLACE FUNCTION public.seed_cycle_accounts(target_group bigint, target_cycle bigint) RETURNS void
    LANGUAGE plpgsql SET search_path='' AS $$
    BEGIN
      PERFORM 1 FROM public.cycles WHERE id=target_cycle AND group_id=target_group FOR UPDATE;
      INSERT INTO public.accounts(group_id,cycle_id,code,name,type)
      SELECT target_group,target_cycle,code,name,type FROM (VALUES ${tuples}) AS chart(code,name,type)
      ON CONFLICT(group_id,cycle_id,code) WHERE cycle_id IS NOT NULL DO UPDATE SET code=EXCLUDED.code
      WHERE accounts.name=EXCLUDED.name AND accounts.type=EXCLUDED.type;
      IF (SELECT count(*) FROM public.accounts WHERE group_id=target_group AND cycle_id=target_cycle AND
        (code,name,type) IN (${tuples}))<>${chart.length} THEN
        RAISE EXCEPTION 'Incompatible reserved cycle account definition' USING ERRCODE='23514'; END IF;
    END $$;`);
}

exports.up = async function up(knex) {
  // Update future seeding only; existing accounts and postings remain unchanged.
  await replaceTemplate(knex, accounts);
};

exports.down = async function down(knex) {
  // Preserve seeded accounts and their postings; restore only the prior template.
  await replaceTemplate(knex, accounts.filter(([code]) => code !== '5100'));
};
