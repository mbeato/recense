#!/usr/bin/env python3
"""Extract the memory-shaped eval set from recall-audit turn records.

Filters turn-records.jsonl (argv[1]) to prompts that ask about past
decisions/state in natural language, labels each with what ambient recall did
(hit / empty), and writes an eval-set JSONL (argv[2]). This is the live-
distribution eval seed for retrieval changes: every row is a real prompt from
a real session against the real graph.

Labels are outcome observations, not ground truth — `ambient_hit` means lines
cleared the floor, NOT that they were relevant. Relevance grading is the
eval harness's job (LLM judge or manual pass).

PRIVACY: output contains verbatim prompts — keep under scripts/eval/results/.
"""
import json, re, sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "scripts/eval/results/recall-audit/turn-records.jsonl"
OUT = sys.argv[2] if len(sys.argv) > 2 else "scripts/eval/results/recall-audit/memory-shaped-evalset.jsonl"

MEM = re.compile(
    r"\b(did we|do we (already|still) have|what (were|was) the|we (had|used|discussed|decided|tried)"
    r"|why did we|last time|remember|didn'?t we|we already|which .* did we)\b", re.I)

rows = [json.loads(l) for l in open(SRC)]
out = []
for r in rows:
    if not MEM.search(r["prompt"]):
        continue
    out.append({
        "project": r["project"],
        "session": r["session"],
        "ts": r["ts"],
        "prompt": r["prompt"],
        "ambient_hit": r["ambient_n"] > 0,
        "ambient_n": r["ambient_n"],
        "ambient_scores": r["ambient_scores"],
        "ambient_block": r["ambient_block"],
        "followed_by_search": r["greps"] + r["globs"] >= 2,
        "manual_recall_used": r["manual_recall"] > 0,
    })

with open(OUT, "w") as fh:
    for r in out:
        fh.write(json.dumps(r) + "\n")

hits = sum(1 for r in out if r["ambient_hit"])
searched = sum(1 for r in out if r["followed_by_search"])
print(f"memory-shaped prompts: {len(out)}  ambient_hit: {hits}  followed_by_search: {searched}")
print(f"wrote {OUT}")
