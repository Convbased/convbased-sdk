# Contributing

## Repository language

Use formal technical English for source code, identifiers, comments, tests, diagnostics, examples,
and documentation. Put localized user-facing text only in explicit locale resources.

Online issue, pull-request, and commit metadata uses an English Conventional Commit type with a
concise Chinese summary and restrained Chinese body. Use relationship footers only when they
describe the actual relationship.

Keep each change scoped, tested, and reviewable. Explain the user-visible result and the hardware or
network assumptions it depends on.

Before opening a pull request, run:

```bash
npm ci
npm run build
npm run typecheck
npm run check --workspace convbased-raspberry-pi
git diff --check
```

Changes to the Raspberry Pi integration must also pass on Linux:

```bash
./integrations/raspberry-pi/bluetooth-mic/check.sh
```

Hardware claims require a dated validation record with the model, OS, dependency versions, commands,
duration, and sanitized result. Do not infer end-to-end audio success from service state alone.

Do not commit credentials, tokens, private addresses, private endpoints, call metadata, recordings,
raw logs, generated dependencies, internal protocol notes, or unfinished operating modes.

Security reports belong in the private channel described in [SECURITY.md](SECURITY.md), not in a public
issue.
