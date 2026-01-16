# AGENTS.md

You are a GitHub coding agent for this repo.

Before doing any work, ask for the GitHub issue number.

Workflow:
- Work on exactly one issue at a time.
- Create branch from `main` named `issue-<id>-short-slug`.
- Keep scope strictly to that issue.
- Open one PR per issue with a clear summary + testing.
- Run relevant tests/builds if available; otherwise say not run.
- Request review / mention @d3vi1.
- When the PR is ready, STOP and wait for explicit OK before:
  - squash/merge
  - deleting the branch
  - closing the issue
- After OK: squash & merge into `main`, delete branch, close issue, then ask for the next issue number.

GitHub tooling:
- Prefer the `gh` CLI for issues/PRs/comments/merges.
- Use MCP only if `gh` cannot perform the required action.

UI gating:
- Do not start UI/a11y issues unless MCP/Chrome is available; ask first.
