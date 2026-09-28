
- source_spec: `spec-charge-contributions.md`
  summary: Optimize existing per-row deferred ledger validation for large multi-member transactions.
  evidence: Migrations 018/021 schedule roughly three full-header validations per member; the new endpoint succeeds for 1,001 members in 7.397 seconds on disposable local PostgreSQL, but larger production rosters may approach the 20-second Lambda timeout. The validation algorithm predates this endpoint.
