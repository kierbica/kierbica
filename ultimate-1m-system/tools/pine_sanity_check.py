#!/usr/bin/env python3
"""Static sanity checker for the U1M Pine Script v6 sources.

This is a HEURISTIC linter, not a compiler. It catches common structural
problems (old namespaces, tab indentation, unbalanced brackets, suspicious
repainting primitives, misplaced barstate usage) before the code is pasted
into the TradingView Pine Editor, which is the authoritative compiler.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

FORBIDDEN = [
    (r"\bstudy\s*\(", "study() is v4-and-earlier; use indicator()"),
    (r"(?<![.\w])security\s*\(", "bare security() — must be request.security()"),
    (r"(?<![.\w])iff\s*\(", "iff() removed — use ternary or if"),
    (r"(?<![.\w])(rsi|atr|sar|sma|ema|wma|mom|stdev|highest|lowest|crossover|crossunder|valuewhen|barssince)\s*\(",
     "bare ta.* call — Pine v6 requires the ta. namespace"),
    (r"\bsecurity_lower_tf\(", "lower-TF requests are repaint-prone; audit if intentional"),
    (r"\bta\.pivot", "pivot-based logic leaks future data by design"),
    (r"(?<![.\w])pivothigh\s*\(", "bare pivothigh — future leak"),
    (r"\bnz\s*\(\s*(not\b|[A-Za-z_]\w*\s*(==|!=|>|<)\s*(true|false))", "nz() on bool is illegal in v6"),
    (r"\bna\s*\(\s*(not\b|barstate)", "na() on bool is illegal in v6"),
]

WARNINGS = [
    (r"barstate\.isrealtime|barstate\.ishistory", "barstate branching can cause realtime/historical divergence — audit"),
    (r"request\.security\((?![^\n]*lookahead)", "request.security() without explicit lookahead — must be the [1]+lookahead_on pattern"),
    (r"request\.security\((?![^\n]*\[1\])", "request.security() expression not offset by [1] — repaints unless repainting is intended"),
    (r"calc_on_every_tick\s*=\s*true", "calc_on_every_tick=true breaks confirmed-bar discipline"),
    (r"\bvar\s+bool\s+\w+\s*=\s*na", "bool cannot be na in Pine v6 — compile error"),
]

REQUIRED = [
    (r"//@version=6", "must declare //@version=6"),
]

def strip_comments_strings(line: str) -> str:
    line = re.sub(r"//.*", "", line)
    line = re.sub(r'"(?:[^"\\]|\\.)*"', '""', line)
    return line

def signal_core(path: Path) -> str | None:
    """Extract the SIGNAL CORE block, comments stripped, blank lines dropped.
    The two script versions must be code-identical here by construction."""
    txt = path.read_text(encoding="utf-8")
    m = re.search(r"SIGNAL CORE — BEGIN =+\n(.*?)=+ SIGNAL CORE — END", txt, re.S)
    if not m:
        return None
    out = []
    for raw in m.group(1).splitlines():
        code = strip_comments_strings(raw).strip()
        if code:
            out.append(code)
    return "\n".join(out)

def check_file(path: Path) -> int:
    src = path.read_text(encoding="utf-8")
    lines = src.splitlines()
    errors: list[str] = []
    warns: list[str] = []

    for pat, msg in REQUIRED:
        if not re.search(pat, src):
            errors.append(f"{path.name}: MISSING required: {msg}")

    if "\t" in src:
        errors.append(f"{path.name}: TAB character found — Pine requires spaces")

    # bracket balance across the whole file (strings/comments stripped)
    depth = {"(": 0, "[": 0, "{": 0}
    pairs = {")": "(", "]": "[", "}": "{"}
    for i, raw in enumerate(lines, 1):
        clean = strip_comments_strings(raw)
        for ch in clean:
            if ch in depth:
                depth[ch] += 1
            elif ch in pairs:
                depth[pairs[ch]] -= 1
                if depth[pairs[ch]] < 0:
                    errors.append(f"{path.name}:{i}: unbalanced closing '{ch}'")
                    depth[pairs[ch]] = 0
    for k, v in depth.items():
        if v != 0:
            errors.append(f"{path.name}: {v} unclosed '{k}'")

    for i, raw in enumerate(lines, 1):
        clean = strip_comments_strings(raw)
        for pat, msg in FORBIDDEN:
            if re.search(pat, clean):
                errors.append(f"{path.name}:{i}: {msg}: {raw.strip()[:80]}")
        for pat, msg in WARNINGS:
            if re.search(pat, clean):
                warns.append(f"{path.name}:{i}: {msg}: {raw.strip()[:80]}")
        # indentation must be multiples of 4 (continuation lines are the exception;
        # flag only clearly broken blocks)
        stripped = raw.rstrip()
        if stripped and not stripped.startswith("//"):
            indent = len(raw) - len(raw.lstrip(" "))
            if indent % 4 != 0 and indent != 5 and not (indent > 4 and indent % 4 in (1, 2, 3)):
                warns.append(f"{path.name}:{i}: unusual indent {indent} (continuation?) — verify: {stripped[:60]}")

    # alertcondition() events are indicator-only: inert in strategies
    if re.search(r"(?m)^\s*strategy\s*\(", src) and re.search(r"(?m)^\s*alertcondition\(", src):
        errors.append(f"{path.name}: alertcondition() used in a strategy — indicator-only feature, no alert can be created from it")

    # runtime.error guards crash the whole script; prefer graceful degradation
    for i, raw in enumerate(lines, 1):
        if re.search(r"\bruntime\.error\s*\(", strip_comments_strings(raw)):
            warns.append(f"{path.name}:{i}: runtime.error() aborts the entire script — prefer graceful degradation: {raw.strip()[:60]}")

    # alertcondition messages must be const strings
    for m in re.finditer(r"alertcondition\([^,]+,\s*[^,]+,\s*([^)]+)\)", src):
        if not m.group(1).strip().startswith('"'):
            errors.append(f"{path.name}: alertcondition message must be a const string: {m.group(1)[:50]}")

    # every request.security must pair [1] with lookahead_on
    for m in re.finditer(r"request\.security\((?:[^()]|\([^()]*\))*\)", src, re.S):
        call = m.group(0)
        if ("[1]" in call) != ("lookahead = barmerge.lookahead_on" in call):
            errors.append(f"{path.name}: request.security must use expr[1] AND lookahead_on together: {call[:80]}...")

    print(f"\n=== {path.name} ({len(lines)} lines) ===")
    for e in errors:
        print(f"  ERROR:   {e}")
    for w in warns:
        print(f"  warning: {w}")
    if not errors and not warns:
        print("  clean")
    return len(errors)

def main() -> int:
    root = Path(__file__).resolve().parents[1] / "src"
    total = 0
    files = sorted(root.glob("*.pine"))
    for f in files:
        total += check_file(f)

    # SIGNAL CORE sync invariant: indicator and strategy must be code-identical
    if len(files) >= 2:
        cores = {f.name: signal_core(f) for f in files}
        names = list(cores)
        if any(c is None for c in cores.values()):
            print("\nERROR: SIGNAL CORE block not found in every file")
            total += 1
        else:
            for other in names[1:]:
                if cores[names[0]] != cores[other]:
                    print(f"\nERROR: SIGNAL CORE of {other} != {names[0]} (code drifted)")
                    total += 1
                else:
                    print(f"\nSIGNAL CORE sync: {names[0]} == {other} ({len(cores[names[0]].splitlines())} code lines)")

    print(f"\nTotal blocking errors: {total}")
    print("NOTE: this linter is advisory only — paste each file into the Pine Editor to confirm compilation.")
    return 1 if total else 0

if __name__ == "__main__":
    sys.exit(main())
