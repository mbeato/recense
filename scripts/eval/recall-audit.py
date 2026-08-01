#!/usr/bin/env python3
"""Audit recense ambient recall against real Claude Code session transcripts.

Reads ~/.claude/projects/<slug>/*.jsonl transcripts and, for every real user
turn, records: the prompt, the ambient block the UserPromptSubmit hook injected
for it (if any), and what the assistant did in the window until the next user
turn (Grep/Glob/Read counts, bash greps, manual `recense recall` calls).

Output: a JSONL of per-turn records (argv[1], default turn-records.jsonl)
plus aggregate stats on stdout.

PRIVACY: the output contains verbatim user prompts from ALL projects (personal
content included). Keep outputs under scripts/eval/results/ (gitignored) —
never commit them. First run: 2026-08-01, 1,940 turns / 302 sessions; findings
in .planning/seeds/SEED-005-retrieval-upgrade-recall-audit.md.
"""
import json, os, re, sys, glob

PROJECTS = {
    "-Users-vtx-resume": "resume",
    "-Users-vtx-jobfill": "jobfill",
    "-Users-vtx-brain-memory": "brain-memory",
    "-Users-vtx-VTX": "vtx",
    "-Users-vtx-aurevion": "aurevion",
}
ROOT = os.path.expanduser("~/.claude/projects")
OUT = sys.argv[1] if len(sys.argv) > 1 else "turn-records.jsonl"

AMBIENT_HDR = "Recalled from recense (ambient):"
SCORE_RE = re.compile(r"\(([a-z_]+), score (\d\.\d\d)\)")

def user_text(msg):
    c = msg.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts = [b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(parts)
    return ""

def is_real_user(d):
    if d.get("type") != "user" or d.get("isSidechain"):
        return False
    if d.get("isMeta"):
        return False
    m = d.get("message", {})
    if m.get("role") != "user":
        return False
    t = user_text(m)
    if not t.strip():
        return False
    noise = ("<task-notification>", "[SYSTEM NOTIFICATION", "<local-command-stdout>",
             "<command-name>", "Caveat: The messages below", "tool_result")
    if any(n in t[:400] for n in noise):
        return False
    return True

def main():
    records = []
    for slug, label in PROJECTS.items():
        for f in sorted(glob.glob(os.path.join(ROOT, slug, "*.jsonl"))):
            try:
                lines = open(f, errors="replace").read().splitlines()
            except OSError:
                continue
            pending_ambient = None  # ambient block seen before its user turn
            cur = None  # current turn record being filled
            for line in lines:
                if AMBIENT_HDR in line or '"hook_additional_context"' in line:
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    att = d.get("attachment") or {}
                    if att.get("type") == "hook_additional_context" and att.get("hookEvent") == "UserPromptSubmit":
                        content = att.get("content") or att.get("stdout") or ""
                        if isinstance(content, dict):
                            content = content.get("additionalContext", "")
                        if AMBIENT_HDR in str(content):
                            block = str(content)
                            idx = block.find(AMBIENT_HDR)
                            pending_ambient = block[idx: idx + 2000]
                        else:
                            pending_ambient = ""  # hook fired, no ambient lines
                    continue
                if '"type":"user"' in line:
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if is_real_user(d):
                        if cur:
                            records.append(cur)
                        t = user_text(d.get("message", {}))
                        amb = pending_ambient
                        pending_ambient = None
                        scores = SCORE_RE.findall(amb) if amb else []
                        cur = {
                            "project": label,
                            "session": os.path.basename(f)[:8],
                            "ts": d.get("timestamp", ""),
                            "prompt": t[:500],
                            "prompt_len": len(t),
                            "ambient_fired": bool(amb),
                            "ambient_n": len(scores),
                            "ambient_scores": [float(s) for _, s in scores],
                            "ambient_block": (amb or "")[:1200],
                            "greps": 0, "globs": 0, "reads": 0,
                            "manual_recall": 0, "memory_tool": 0,
                        }
                    continue
                if cur is None:
                    continue
                if '"type":"assistant"' in line and '"tool_use"' in line:
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if d.get("isSidechain"):
                        continue
                    for b in (d.get("message", {}).get("content") or []):
                        if not isinstance(b, dict) or b.get("type") != "tool_use":
                            continue
                        name = b.get("name", "")
                        inp = b.get("input", {}) or {}
                        if name == "Grep":
                            cur["greps"] += 1
                        elif name == "Glob":
                            cur["globs"] += 1
                        elif name == "Read":
                            cur["reads"] += 1
                        elif name == "Bash":
                            cmd = str(inp.get("command", ""))
                            if re.search(r"\b(grep|rg|ag)\b", cmd):
                                cur["greps"] += 1
                            if "recense recall" in cmd or "recense-recall" in cmd:
                                cur["manual_recall"] += 1
                        if "memory" in name.lower():
                            cur["memory_tool"] += 1
            if cur:
                records.append(cur)

    with open(OUT, "w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")

    import statistics as st
    def agg(rows, name):
        n = len(rows)
        if not n:
            print(f"{name}: 0 turns"); return
        fired = [r for r in rows if r["ambient_fired"] and r["ambient_n"] > 0]
        empty = [r for r in rows if r["ambient_fired"] and r["ambient_n"] == 0]
        nofire = [r for r in rows if not r["ambient_fired"]]
        grepped = [r for r in rows if r["greps"] + r["globs"] >= 2]
        fired_and_grepped = [r for r in fired if r["greps"] + r["globs"] >= 2]
        empty_and_grepped = [r for r in empty + nofire if r["greps"] + r["globs"] >= 2]
        manual = sum(r["manual_recall"] for r in rows)
        allscores = [s for r in fired for s in r["ambient_scores"]]
        print(f"\n=== {name} ===")
        print(f"turns={n}  ambient_with_hits={len(fired)} ({100*len(fired)//n}%)  ambient_empty={len(empty)+len(nofire)}")
        if allscores:
            print(f"scores: mean={st.mean(allscores):.3f} median={st.median(allscores):.3f} p90={sorted(allscores)[int(len(allscores)*0.9)]:.3f} max={max(allscores):.2f}")
        print(f"heavy-search turns (>=2 grep/glob): {len(grepped)} ({100*len(grepped)//n}%)")
        print(f"  of which ambient HAD fired: {len(fired_and_grepped)}")
        print(f"  of which ambient was empty: {len(empty_and_grepped)}")
        print(f"manual `recense recall` calls: {manual}")

    agg(records, "ALL")
    for label in set(PROJECTS.values()):
        agg([r for r in records if r["project"] == label], label)

if __name__ == "__main__":
    main()
