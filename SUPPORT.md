# Support

Corridor is pre-release and has no public support channel yet. This page says where to look
and where to ask.

## Before you ask

| Question                              | Look in                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| How do I run it locally?              | `README.md` → Quick start                                                                             |
| How do I contribute, branch, commit?  | `CONTRIBUTING.md`                                                                                     |
| What changed recently?                | `CHANGELOG.md`                                                                                        |
| Is this a known security finding?     | `docs/security-review.md`                                                                             |
| How does the driver app work?         | `apps/mobile/README.md`                                                                               |
| How do I load-test it?                | `load/README.md`                                                                                      |
| Why was something built this way?     | `docs/plans/`                                                                                         |
| Type errors, test failures, DB not up | `CONTRIBUTING.md` → Getting Help (`pnpm typecheck`, `vitest run <path>`, `pnpm exec supabase status`) |

## Asking

- **Bugs and feature requests**: open a GitHub issue using the templates in `.github/ISSUE_TEMPLATE/`.
- **Security vulnerabilities**: never a public issue. Follow `SECURITY.md`.
- **Code of conduct concerns**: see `CODE_OF_CONDUCT.md` → Reporting.

Please include the commit you are on, whether you are running against local Supabase or a
deployed environment, and which AI provider mode was active (gateway, OpenAI, or mock).
