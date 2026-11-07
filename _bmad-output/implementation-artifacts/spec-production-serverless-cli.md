---
title: 'Document production Serverless CLI prerequisite'
type: 'bugfix'
created: '2026-11-07'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Production deployment fails with `spawnSync serverless ENOENT` when the required Serverless Framework CLI is not installed.

**Approach:** Document how to install the previously verified Serverless v3 CLI before deploying, without running a production deployment or changing the Lambda package contents.

</frozen-after-approval>

## Implementation Notes

- `scripts/production.js` invokes `serverless` via PATH; neither the project dependencies nor the current PATH provide it.
- Documented the previously verified v3.40.0 global installation in `README.md`. Kept the CLI outside project dependencies because `serverless.yml` includes installed development dependencies in the Lambda archive.
- No production deployment or global installation was performed.
- Review reported no significant issues. `git diff --check` passed.
