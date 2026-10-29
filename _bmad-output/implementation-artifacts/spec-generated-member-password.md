---
title: 'Generate passwords for member login provisioning'
type: 'feature'
created: '2026-10-29'
status: 'done'
route: 'oneshot'
---

<frozen-after-approval>

## Intent

Allow an omitted password field or an empty/whitespace-only password string in the object body of POST /api/v1/groups/users/:id/account. Generate a cryptographically random password for these cases and return it as generated_password only after successful account creation and confirmed linking. Preserve exact nonblank supplied passwords and existing length/type validation, access control and provisioning behavior. Reject null/non-string passwords and invalid/non-object bodies. Use existing no-store response handling and never store plaintext in application tables or log it. No migration.

</frozen-after-approval>

## Implementation Notes

Use node:crypto randomBytes(24) encoded base64url plus a fixed mixed-character suffix for common Auth complexity requirements (192 bits of randomness; under 72 UTF-8 bytes). Generate only after actor, target and migration validation. Keep generation internal and leave provider validation/errors unchanged. Test generated credentials actually passed to Auth and returned only on success, retry conflict, supplied password preservation and invalid input. README documents credential handling and empty body-field semantics.


## Review Triage Log

- low, patched: removed contradictory blanket password-exclusion text and documented top-level generated_password.
- medium, patched: documented OTP login followed by authenticated password change as recovery for a lost generated credential response, with Auth operator fallback if OTP is unavailable. Existing endpoint never resets provisioned accounts.
- medium, patched: route test invokes the real provider service with mocked fetch and verifies the returned generated credential equals the outbound Auth password.

Verification: all seven member-account tests passed, no skips; git diff --check passed. No deferred findings, no migration, no external Auth calls.
