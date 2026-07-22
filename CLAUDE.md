# Claude Guidance

This repository is shared between Claude Code, Codex, and multiple local
computers through GitHub. GitHub is the source of truth. Do not use iCloud,
Dropbox, or Google Drive for live source-code sync.

Read these files first when resuming work:

- `README.md`
- `AGENTS.md`
- `CURRENT_WORK.md`
- `NEXT_STEPS.md`
- `DECISIONS.md`
- `SHARED_CODING_WORKFLOW.md`
- `SETUP.md` when the task touches Backblaze B2 or GMI credentials

Follow the rules in `AGENTS.md`. In particular:

- Every capability claim needs a passing proof script; keep the existing ones
  green rather than adding unverified features.
- Never print, echo, or commit secret values. `.env` is gitignored — lint it
  by length/prefix only. The full git history has been scanned clean.
- Deterministic and AI QC are separate lanes; AI annotates, never overwrites.
- This repo is public: competitive analyses and personal reference files
  belong in the user's Claude project directory, not here.

Before switching to another computer or agent, update the handoff files with
what changed, what was validated, and the exact next step, then commit and
push.
