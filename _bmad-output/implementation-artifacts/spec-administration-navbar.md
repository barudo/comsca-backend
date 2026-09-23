---
title: 'Administration navigation dropdown'
type: 'feature'
created: '2026-09-23'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Group Members and Cycles in one Administration navbar dropdown, visible only to Owners and Admins.

</frozen-after-approval>

## Implementation Notes

- Small reversible navbar change in sibling comsca-app, whose working tree is clean at 828281cc2a0693d808fc9e24c150e9f201658eca. No intent gaps or irreversible actions.
- Reuse canManageCycles for Owner/Admin visibility and existing account dropdown styles/interactions. Preserve page/API authorization because this request scopes navigation visibility.
- Change src/components/protected-navigation.tsx and src/app/globals.css. Verify with lint, TypeScript and existing tests.
- Implemented native details dropdown with active links, outside click, blur, Escape and navigation dismissal. Same-page activation returns focus to summary.
- ESLint, TypeScript and diff checks pass. All 27 existing tests pass using Node 24; app directory defaults to Node 20, which cannot execute the test script's strip-types option. No browser interaction test was run.

## Review Triage Log

- Low, patched: selecting current destination could hide focused link; now restores summary focus on same-path activation.
- Low, rejected: component/browser regression tests would require new infrastructure for a small reversible UI change; existing role helper tests pass and JSX visibility/handlers were inspected. Browser interaction coverage remains a limitation.
