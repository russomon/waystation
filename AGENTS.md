# AGENTS.md — Shared Agent Contract V2.2

This repository uses a shared, Git-centric workflow across coding agents and editors. The repository is the durable source of project context. Conversation history and platform memory are supplemental and must not override verified repository state.

## 1. Universal Rules

- Operate within this repository unless the user explicitly expands the scope.
- Preserve existing work. Never discard, overwrite, reset, or silently absorb unrelated changes.
- Follow the authority and safety limits in the user's current request. A handoff does not authorize unrelated implementation, deployment, destructive operations, or external changes.
- Inspect before editing. Do not invent repository facts, test results, branch state, decisions, or completion claims.
- Use `TBD` or `UNKNOWN` when facts are not yet established. State what would resolve the uncertainty.
- Keep shared context concise and factual. Do not store chat transcripts, raw terminal output, secrets, credentials, or long debugging diaries in context files.
- Read only the context and code needed for the immediate task. Expand inspection when evidence requires it; do not sweep the repository by default.
- Treat repository-local instructions as authoritative only within their scope. When instructions conflict, follow the more specific applicable instruction unless it conflicts with the user's request or a higher-priority safety boundary.
- Use `SHARED_CODING_WORKFLOW.md` as the single authoritative procedure for startup, branch handling, synchronization, implementation, validation, checkpoints, and closing.
- Do not duplicate that procedure in platform-specific rules, prompts, or command wrappers.

## 2. Shared Document Roles

- `AGENTS.md`: universal rules, document roles, and schemas.
- `SHARED_CODING_WORKFLOW.md`: detailed operating procedure.
- `CURRENT_WORK.md`: one compact snapshot of the present work state and handoff.
- `DECISIONS.md`: durable decisions whose rationale and constraints should survive sessions.
- `NEXT_STEPS.md`: short, prioritized active queue.
- `docs/ARCHITECTURE.md`: stable explanation of system structure, boundaries, and data flow.
- `docs/REPO_MAP.md`: concise map of important locations and responsibilities.
- Platform-specific files: thin adapters only; no project state or duplicated policy.

## 3. Schema: `CURRENT_WORK.md`

Keep one current snapshot; do not append a session diary. Use this exact section and field structure:

```markdown
# CURRENT_WORK.md

## Meta
- **Branch**: `<branch>` | `UNKNOWN — <reason>`
- **HEAD**: `<full-or-short-commit>` | `UNKNOWN — <reason>`
- **Upstream**: `<remote>/<branch>` | `NONE` | `UNKNOWN — <reason>`
- **Tree State**: `CLEAN` | `DIRTY — <brief description>` | `UNKNOWN — <reason>`
- **Last Updated**: `<YYYY-MM-DD>` | `UNKNOWN — <reason>`

## Immediate Target
- **Task**: `<one-sentence task>` | `TBD — <what must be decided>`
- **Target Files**: `<path>`, `<path>` | `TBD — discovery required`
- **Current State**: `<concise verified state>` | `UNKNOWN — investigation required`
- **Blockers**: `NONE` | `<blocker and required resolution>` | `UNKNOWN — <reason>`

## Validation
- **Last Run**: `<command or check>` | `NOT RUN`
- **Result**: `PASS — <exact summary>` | `FAIL — <exact summary>` | `NOT RUN — <reason>`

## Handoff Instruction
1. `<first concrete action>`
2. `<next action, if needed>`
3. `Validate with: <exact command or check>`
```

Rules:

- Record observed facts, not intended future state.
- `HEAD` and tree state must match Git when the file is finalized.
- Mention uncommitted work precisely enough that another agent will not overwrite it.
- Keep the handoff executable and ordered. Use `TBD` or `UNKNOWN` instead of guessing.

## 4. Schema: `DECISIONS.md`

Record only durable architectural, product, security, data, workflow, or compatibility decisions. Use stable ADR identifiers; never renumber existing entries.

```markdown
# DECISIONS.md

## Active Decisions

### [ADR-001] <Short title>
- **Status**: `ACCEPTED` | `PROVISIONAL` | `SUPERSEDED by ADR-###`
- **Decision**: <what was decided>
- **Rationale**: <why this choice was made and the important constraints>
- **Invariant**: DO <required behavior>. DO NOT <forbidden behavior or condition requiring reconsideration>.
- **Date**: <YYYY-MM-DD> | `UNKNOWN`
```

Rules:

- Preserve rationale; an invariant alone is not a complete decision record.
- Use `PROVISIONAL` when confirmation is pending.
- Supersede rather than delete an obsolete decision when its history still explains the system.
- Do not record routine edits, implementation narration, task status, or speculative preferences.

## 5. Schema: `NEXT_STEPS.md`

Keep only a concise active queue, ordered by priority:

```markdown
# NEXT_STEPS.md

## Active Queue

1. **[P0] <Outcome-oriented task>**
   - **Target**: `<component or path>` | `TBD`
   - **Done When**: `<observable completion condition>`
   - **Blocked By**: `NOT BLOCKED` | `<dependency, decision, or owner>`

2. **[P1] <Next task>**
   - **Target**: `<component or path>` | `TBD`
   - **Done When**: `<observable completion condition>`
   - **Blocked By**: `NOT BLOCKED` | `<dependency, decision, or owner>`
```

Rules:

- Use `P0` for urgent/blocking work, `P1` for next planned work, and `P2` for later active work.
- Keep the queue small—normally no more than ten items.
- Remove completed items after their durable result is reflected in code, history, or documentation.
- Move durable ideas outside the active horizon to the project's issue tracker or roadmap; do not let this file become a backlog archive.
- Do not duplicate the immediate handoff steps from `CURRENT_WORK.md`.

## 6. Schema Maintenance

Change these schemas only deliberately. When a schema or universal rule changes, update this file first, migrate affected context files, and keep `SHARED_CODING_WORKFLOW.md` and thin wrappers consistent without copying policy between them.

## 7. Repository-Specific Rules — Waystation / OrbiStation

Constraints specific to this repository. They add to, and never relax, sections 1–6.

### Identity and naming

- **OrbiStation** is the public-facing product name. The repository, `WAYSTATION_*` environment variables, Docker service names, database, QC profile ids and `waystation-*` meta tags keep the **Waystation** name deliberately (commit `5d47d6d`, ADR-033). Do not rename them or rename the repository without an explicit request.
- Waystation is a **separate product** from OrbitXfer (the P2P desktop app). Do not merge the two repositories or move code between them unless asked.
- Source of truth: `git@github.com:russomon/waystation.git`. Work in `/Users/Shared/Orbit/Code/waystation`; never use consumer file sync (iCloud, Dropbox, Google Drive) for live source.

### Public repository and secrets

- This repository is **public**. Internal or competitive documents and the user's personal reference files stay out of it; they belong in the user's Claude project directory. Before writing a document, decide whether it is repository-facing or internal. Do not copy internal reference material here wholesale.
- **Never commit, print, echo or log a secret value**, not even to show a fix worked. `.env` and `.env.local` are gitignored and hold real Backblaze B2 and GMI credentials; inspect them by length and prefix only. Access codes, recipient capability IDs and download tickets are bearer tokens: record at most the first 8 characters.
- Keep out of Git: `vendor/` (Photon jars), `node_modules/`, `pipeline/.venv/`, `.devdata/`, `target/`, `crates/*/pkg*/`, `client/public/` test fixtures, `*.db*` control-database files (they contain live capabilities).

### Production and deployment

- Production runs the **transfer-only** stack (`docker-compose.transfer.yml`: gateway plus cloudflared, no worker, `MAX_QC_BYTES: "1"`). QC development is parked. The full QC engine is complete in source and proven locally, but is **not deployed**. Do not assume a running worker, a scratch disk, or GMI spend.
- A source commit is not a running deployment. Deployment state is established by image build time and container contents, never by `git rev-parse` on the host (ADR-016). Distinguish *source-complete*, *deployment recorded in `docs/DEPLOY.md`* and *independently verified live* when reporting.
- Client and gateway ship in lockstep; never default a value the server owns (ADR-017).
- Do not access the VPS, B2, payment providers or credentials, change `MAX_QC_BYTES`, `WAYSTATION_QC_MODE` or `WAYSTATION_PURGE_MODE`, or run deployment commands, unless the current request explicitly authorizes it. Read `docs/DEPLOY.md` before touching production.
- Do not rebuild the worker image to add a dependency: its Dockerfile pins `mediaconch=25.04-2` and compiles QCTools from source, so a rebuild can fail for unrelated reasons. Layer on the archived image. Never use `docker commit` for this: it captures the container environment and would bake `.env` secrets into an image uploaded to B2. Read `docs/DEFERRED_TOOLING.md` first.

### Engineering rules

- **Every capability claim must have a proof script** (`scripts/*-proof.sh`). New features add or extend one; existing proofs stay green. A failing proof is the finding, not an obstacle to route around. Claims in `README.md` and `docs/devpost-about.md` must be reproducible or marked honestly gated.
- Deterministic checks (ffmpeg/ffprobe, Photon, hashes) and AI checks (GMI) are **separate gates**. AI never overwrites or clears an instrument reading. The AI Interpretive gate may HOLD or REJECT only through its versioned authority policy; raw model text has no direct authority, and deterministic rejection always wins.
- Waystation is a **read-only QC reporter**. Do not add media repair or transformation to the QC path. Every applicable registered risk needs an explicit disposition, including unresolved gaps.
- The pipeline worker is **stateless**; everything durable lands in B2. Python **3.13+** is required.
- Read the existing implementation before inventing a pattern. Extend settled conventions (`qc/util.py` bounded ffmpeg windows, `qc/report.py` check/tier model, `gateway/src/limits.ts` service-policy reducer, the optional-instrument shape in `qc/avsync.py` and `qc/archive_tools.py`) rather than adding a parallel mechanism.
- Never set `WAYSTATION_COMMIT` to an older proficiency manifest's commit; the production Passport is honestly `UNCALIBRATED` (ADR-012).

### Additional repository documents

Read when the task touches them: `docs/DEPLOY.md` (what is live, restore paths), `docs/DEFERRED_TOOLING.md`, `docs/COMMERCIAL_DELIVERY_PLAN.md` (identity, metering, credits, billing), `docs/E2E_ENCRYPTION_PLAN.md` (shelved), `docs/NATIVE_SENDER_PLAN.md`, `docs/SYNTHETIC_ORIGIN_PLAN.md`, `README.md`, `SETUP.md` (B2/GMI account setup). History, not state: `docs/PROJECT_HISTORY.md`, `docs/DECISIONS_HISTORY.md`, `docs/archive/`.

Platform adapters: `CLAUDE.md` (Claude Code only) and `.cursor/commands/` (`/resume`, `/handoff`) are thin pointers and hold no project state.
