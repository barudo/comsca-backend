exports.up = async function up(knex) {
  await knex.raw(`LOCK TABLE public.cycles, public.accounts IN ACCESS EXCLUSIVE MODE;
    CREATE FUNCTION public.seed_cycle_accounts(target_group bigint, target_cycle bigint) RETURNS void
    LANGUAGE plpgsql SET search_path='' AS $$
    BEGIN
      PERFORM 1 FROM public.cycles WHERE id=target_cycle AND group_id=target_group FOR UPDATE;
      INSERT INTO public.accounts(group_id,cycle_id,code,name,type)
      SELECT target_group,target_cycle,code,name,type FROM (VALUES
        ('1000','Cash','ASSET'), ('1100','Loans Receivable','ASSET'),
        ('1200','Interest Receivable','ASSET'), ('1300','Penalties Receivable','ASSET'),
        ('2000','Accounts Payable','LIABILITY'), ('3000','Equity','EQUITY'),
        ('4000','Interest Income','INCOME'), ('4100','Penalty Income','INCOME'),
        ('4200','Other Income','INCOME'), ('4300','Donation Income','INCOME'),
        ('5000','Operating Expenses','EXPENSE')) AS chart(code,name,type)
      ON CONFLICT(group_id,cycle_id,code) WHERE cycle_id IS NOT NULL DO UPDATE SET code=EXCLUDED.code
      WHERE accounts.name=EXCLUDED.name AND accounts.type=EXCLUDED.type;
      IF (SELECT count(*) FROM public.accounts WHERE group_id=target_group AND cycle_id=target_cycle AND
        code IN ('1000','1100','1200','1300','2000','3000','4000','4100','4200','4300','5000') AND
        (code,name,type) IN (('1000','Cash','ASSET'),('1100','Loans Receivable','ASSET'),('1200','Interest Receivable','ASSET'),
        ('1300','Penalties Receivable','ASSET'),('2000','Accounts Payable','LIABILITY'),('3000','Equity','EQUITY'),
        ('4000','Interest Income','INCOME'),('4100','Penalty Income','INCOME'),('4200','Other Income','INCOME'),
        ('4300','Donation Income','INCOME'),('5000','Operating Expenses','EXPENSE')))<>11 THEN
        RAISE EXCEPTION 'Incompatible reserved cycle account definition' USING ERRCODE='23514'; END IF;
    END $$;
    CREATE FUNCTION public.seed_activated_cycle_accounts() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
    BEGIN
      IF NEW.status IN ('active','distributing') THEN
        PERFORM public.seed_cycle_accounts(NEW.group_id,NEW.id);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER cycles_seed_accounts AFTER INSERT OR UPDATE OF status ON public.cycles
      FOR EACH ROW EXECUTE FUNCTION public.seed_activated_cycle_accounts();
    SELECT public.seed_cycle_accounts(group_id,id) FROM public.cycles WHERE status IN ('active','distributing');`);
};
exports.down = async function down(knex) {
  await knex.raw(`DROP TRIGGER cycles_seed_accounts ON public.cycles;
    DROP FUNCTION public.seed_activated_cycle_accounts();
    DROP FUNCTION public.seed_cycle_accounts(bigint,bigint);`);
};
