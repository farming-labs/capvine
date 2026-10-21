# Contributing

Use Node.js 24 or later. Install with `npm ci`, then run `npm run check` and `npm run example`.

Please open an issue describing the use case before a substantial API or permission-model change. Keep each change focused, explain which security boundary it affects, and include tests that prove both allowed and denied behavior at the server boundary.

Use descriptive branch names such as `feat/file-reader`, `fix/grant-expiry`, or `docs/server-setup`, and conventional commit and PR titles such as `fix: reject expired grants`. Branch names and PR labels should describe the work without tool or vendor branding. Remove branches after their PRs are merged.

Run `npm run format` before submitting. Follow [AGENTS.md](AGENTS.md) and the [security model](SECURITY.md). Report deployment vulnerabilities privately rather than including sensitive material in an issue or pull request.
