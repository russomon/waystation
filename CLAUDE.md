# Claude Guidance

**Everything universal lives in `AGENTS.md`.** Read that first; this file holds
only what is specific to Claude Code.

## The repository outranks your memory

Claude Code carries memory files across sessions. They are point-in-time notes
and they go stale — this project's own checkout was renamed while a memory still
pointed at the old path. When a memory and the repository disagree, **the
repository wins**. Verify a remembered file, flag or command still exists before
acting on it.

The same applies to anything you recall about deployment state: `CURRENT_WORK.md`
and `docs/DEPLOY.md` are authoritative, not recollection.

## Internal documents

This repository is **public**. Competitive analyses and the user's personal
reference files belong in the Claude project directory
(`~/Documents/Claude/Projects/OrbitXfer-Clade/`), never here. Before writing a
document, ask whether it is repository-facing or internal.

## Secrets

Never print, echo, or commit a secret value — not even to show that a fix
worked. `.env` is gitignored; lint it by length and prefix only. This includes
access codes and recipient capability IDs, which are bearer tokens: record the
first 8 characters, never the whole thing.
