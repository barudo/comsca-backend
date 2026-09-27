---
title: 'Fix missing Lambda runtime dependencies'
type: 'bugfix'
created: '2026-09-28'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Production fails during Lambda initialization because its archive lacks serverless-http and other dependencies. Prepare a corrected deployment archive by disabling Serverless v3's dependency exclusion, which uses an npm flag rejected by npm 12. Verify the archive contains and loads runtime dependencies before production recovery.

</frozen-after-approval>

## Implementation Notes

- Small local packaging configuration correction; no API or database changes. Production recovery is verified separately with AWS status and public API probes.
- CloudWatch reports Runtime.ImportModuleError for serverless-http. Local archive contains only 53 files and no runtime dependencies.
- Serverless 3.40.0 invokes npm ls --prod=true; installed npm 12.1.0 rejects that flag. Serverless suppresses the error and excludes every dependency.
- Disable automatic dependency exclusion. This includes installed development dependencies as a size tradeoff; secrets and existing excluded directories remain excluded.
- Verified with Node 24.16.0, npm 12.1.0, Serverless 3.40.0. `npm ls --omit=dev --depth=0` resolves all declared production dependencies. For future reproducible builds, install from the lockfile with `npm ci` before packaging.
- Rebuilt with `serverless package --stage prod` using production environment values without printing them. Archive: 2,658 files, 3,209,620 bytes; no environment files. Extracted into a new system temporary directory outside the repository and successfully required `./src/handler` there, then destroyed the Knex pool. This ensures dependencies resolve from the archive.
- `npm test`: 81 passed, 2 integration tests skipped, zero failures.
- Downloaded deployed archive to `/private/tmp/comsca-incident-20260928/original.zip` for rollback. It contains 53 files, no serverless-http, and exactly the same application source as the corrected archive.
- Local fix is complete. Production deployment remains pending: automatic approval review rejected `aws lambda update-function-code` because explicit deployment authorization is required. No production mutations occurred.

## Review Triage Log

- Low: reviewer requested installation prerequisite/tool versions; documented versions and `npm ci` prerequisite above. Existing installed dependencies resolve and isolated artifact loading passes.
- Low: reviewer requested isolated archive verification; performed and recorded above, including archive size. No unresolved review findings.
