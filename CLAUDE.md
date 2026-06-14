<!-- GSD:project-start source:PROJECT.md -->
## Project

**recense**

A faithful brain-inspired memory engine for AI agents — a two-store (fast episodic + slow semantic graph + vector) system that doesn't just recall facts but *learns*: it abstracts general schemas from experience, reasons over them to handle novel situations, and updates stored beliefs the way the brain does (prediction-error-gated reconsolidation) instead of accumulating stale duplicates. Customer-zero is the founder's own Claude Code memory — it replaces the flat `MEMORY.md` index. It is product-shaped from day one for later integration (Tonos as an early client, then third parties).

**Core Value:** The memory **learns and stays correct over time** — it forms generalizations the user never explicitly stated, and when a fact changes it updates the right belief in place rather than surfacing a stale one. If everything else fails, this (abstraction + prediction-error-gated update) must work.

### Constraints

- **Tech stack**: TypeScript engine (better-sqlite3, API-based embed/LLM/judge) — the integration surface (Claude Code hooks) is TS, and v1 has no heavy compute. Python training sidecar bolts on at v3 behind the ModelProvider/ConsolidationSink seams. — Keeps the hot integration path in-process; isolates ML to a separable service.
- **Performance**: online paths (SessionStart inject, retrieval) must stay LLM-free and fast; all LLM/embedding cost lives in the offline sleep pass. — The hook blocks the user; latency there is felt every session.
- **Correctness**: never delete an evidence-backed fact via decay; never let inferred output strengthen a fact (self-confirmation); graph is source of truth, vector is a derived cache. — These are the load-bearing guards from the adversarial review.
- **Faithfulness (engine mechanisms only)**: design choices trace to the verified foundation; demoted ideas (myelination→cache) must not creep back as memory **mechanisms** (data model, algorithms, decay/consolidation). This governs the engine, NOT the presentation layer: the `recense viz` visualization intentionally renders a 3D "second brain" (anatomical mesh + lit nodes/pathways) as decorative chrome — it does not imply the engine models neuroanatomy, and node positions are not semantic. The old VIZ-06 anatomical-term ban was dropped as overkill (2026-06-10); brain imagery in the viz is allowed.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->
## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
