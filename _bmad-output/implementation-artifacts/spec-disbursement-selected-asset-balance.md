---
title: 'Use the selected credit asset for loan funding'
type: 'feature'
created: '2026-10-14'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

The credit input selects any valid ASSET funding account for a loan disbursement, not just Cash. Require sufficient balance in that selected account and preserve existing account/group/cycle validation, locking, precision, and atomic rollback behavior.

</frozen-after-approval>

## Implementation Notes

- Remove the Cash code restriction; retain ASSET validation. Existing balance query already scopes to input.credit.
- Use funding-account wording in errors, comments, and README.
- Add regressions distinguishing Cash and another asset balance, including optional PostgreSQL funding and depletion coverage.

- Verification: full npm test 169 passed, 4 skipped; focused disbursement tests 14 passed. Optional PostgreSQL coverage added but not executed without a disposable test database.

## Review Triage Log

- low, patched: non-Cash integration success lacked stored posting assertions; added exact accounts and signed amounts.
- low, patched: Cash preservation was not asserted; added before/after balance checks.
- low, patched: competing requests only used Cash; added concurrent non-Cash allocation with one rejection and remaining balance assertions.
- low, patched: ASSET acceptance only covered known chart codes; parameterized request coverage over an arbitrary ASSET code.
