# Capvine

Capvine is an experimental TypeScript library for delegated, resource-bound authorization for applications and services.

- Keep capability semantics in `src/profile.ts`; do not invent cryptography.
- Enforce authorization in the server even when client-side helpers perform the same checks.
- Keep every external effect behind verified dispatch and a server-owned resource binding.
- Treat the authority, store, owner policy, and operation handlers as privileged application code.
- Preserve exact operation/resource/task/service restrictions and parent revocation behavior.
- Add tests at the server boundary using raw signed requests for authorization changes.
- Never introduce permissive fallback when verification or lifecycle storage fails.
- Keep claims in README and SECURITY.md aligned with implemented and tested behavior.
- Keep releases explicitly authorized and document experimental scope, incomplete acceptance checks, and the actual publishing method. Never treat publication as independent security or production approval.
- Do not put real credentials, personal account data, or signing keys into fixtures or commits.
- Use neutral fixture identities and standalone technical language in documentation, examples, issues, and commit messages. Do not include personal deployment details or conversation history.
- Use descriptive branch names with purpose-based prefixes such as `feat/`, `fix/`, `docs/`, or `test/`. Keep branch names and PR labels free of tool or vendor branding.
- Run `npm run check` and `npm run example` before handing off changes.

Use Node.js 24 or later.
