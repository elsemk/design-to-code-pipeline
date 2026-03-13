#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/root/.openclaw/workspace/design-to-code-pipeline"
TARGET_DIFF="0.04"
LOG_FILE="$REPO_DIR/analysis_outputs/guard-round14.log"

mkdir -p "$REPO_DIR/analysis_outputs"
cd "$REPO_DIR"

round=1

check_target() {
  python3 - <<'PY'
import json,sys
from pathlib import Path
p=Path('reports/regression-report.json')
if not p.exists():
    print('0')
    raise SystemExit(0)
obj=json.loads(p.read_text())
vals=[r.get('diffRatio',1) for r in obj.get('results',[]) if isinstance(r.get('diffRatio',None),(int,float))]
if len(vals)<4:
    print('0')
    raise SystemExit(0)
ok=all(v<=0.04 for v in vals)
print('1' if ok else '0')
PY
}

while true; do
  {
    echo "[$(date -u +'%Y-%m-%d %H:%M:%S UTC')] ===== GUARD ROUND $round START ====="

    codex exec --full-auto "
You are optimizing the file-based HTML/CSS reconstruction in this repo.

Target page: examples/personal-center-round14
Goal: raise restoration to >=96% similarity at all breakpoints, i.e. diffRatio<=0.04 for 1440/1024/768/375.

Constraints (hard):
- Do NOT use screenshot replacement, full-page image overlay, or pixel-lock cheats.
- Keep structure-based HTML/CSS implementation only.
- Prefer minimal, reversible edits.
- If a change regresses metrics, revert it.

Iteration instructions for THIS run:
1) Inspect current regression numbers and diff images.
2) Make one focused iteration on the highest-impact mismatches (layout, spacing, typography, sizing).
3) Sync examples/personal-center-round14 -> generated.
4) Run npm run check.
5) Report four diffRatio numbers and what changed.

Stop after completing this single iteration.
"

    met=$(check_target)
    if [[ "$met" == "1" ]]; then
      echo "[$(date -u +'%Y-%m-%d %H:%M:%S UTC')] TARGET REACHED (all diffRatio<=0.04)."
      if command -v openclaw >/dev/null 2>&1; then
        openclaw system event --text "design-to-code-pipeline guard: 已达到96%目标（all diffRatio<=0.04）。" --mode now || true
      fi
      break
    fi

    echo "[$(date -u +'%Y-%m-%d %H:%M:%S UTC')] round $round complete; target not reached yet."
    round=$((round+1))
  } | tee -a "$LOG_FILE"

done
