
- source_spec: `spec-charge-contributions.md`
  summary: Optimize existing per-row deferred ledger validation for large multi-member transactions.
  evidence: Migrations 018/021 schedule roughly three full-header validations per member; the new endpoint succeeds for 1,001 members in 7.397 seconds on disposable local PostgreSQL, but larger production rosters may approach the 20-second Lambda timeout. The validation algorithm predates this endpoint.
- source_spec: `spec-dashboard-endpoint.md`
  summary: Run the dashboard PostgreSQL integration test against a disposable database.
  evidence: The dashboard SQL integration test covers exact totals, isolation, and empty-cycle values, but the local environment has no PostgreSQL server binary or configured TEST_DATABASE_URL; the SQL results remain unverified against a live database.
- source_spec: `_bmad-output/implementation-artifacts/spec-accounting-income-statement-endpoint.md`
  summary: Configure a required PostgreSQL integration-test gate for accounting statement SQL.
  evidence: The income-statement aggregation has disposable-PostgreSQL coverage, but it skips without TEST_DATABASE_URL; the repository has no CI workflow to provision the database, so making that verification mandatory requires separate test-infrastructure work.
