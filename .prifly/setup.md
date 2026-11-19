---
setup:
  - bun install --frozen-lockfile
---

A Bun project (`bun.lock`). The install needs `bun` on PATH and network access to GitHub:
`@prifly/extension-api` comes from `github:jimmy927/prifly-extension-api#v0.18.1`.

Checks, as in README "Develop": `bun test`, `bun run typecheck`, `bun run check` (Biome).
Tests run against a fake InfoMentor behind an injected `fetch` and never touch the network.
