#!/usr/bin/env python3
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
ASSETS_DIR = ROOT / "input" / "assets_raw"
SCREENSHOTS = {
    "desktop": ROOT / "input" / "screenshots" / "target-desktop.png",
    "mobile": ROOT / "input" / "screenshots" / "target-mobile.png",
}
OUT_DIR = ROOT / "reports" / "asset-selection"
OUT_DIR.mkdir(parents=True, exist_ok=True)

SCALE_CANDIDATES = [1.0, 0.75, 2 / 3, 0.5, 1.25, 1.5]
SELECTED_THRESHOLD = 0.90
AMBIGUOUS_THRESHOLD = 0.82
MIN_DIM = 8


@dataclass
class MatchResult:
    screenshot: str
    score: float
    scale: float
    x: int
    y: int
    width: int
    height: int


@dataclass
class AssetResult:
    asset: str
    base_name: str
    width: int
    height: int
    best_match: Optional[MatchResult]
    second_match: Optional[MatchResult]
    confidence_gap: float
    status: str


def load_image_rgba(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise RuntimeError(f"failed to read image: {path}")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    return img


def trim_transparent(img: np.ndarray) -> np.ndarray:
    alpha = img[:, :, 3]
    ys, xs = np.where(alpha > 8)
    if len(xs) == 0 or len(ys) == 0:
        return img
    x1, x2 = xs.min(), xs.max()
    y1, y2 = ys.min(), ys.max()
    return img[y1 : y2 + 1, x1 : x2 + 1]


def to_gray(img_rgba: np.ndarray) -> np.ndarray:
    bgr = cv2.cvtColor(img_rgba, cv2.COLOR_BGRA2BGR)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return gray


def base_name_from_file(name: str) -> str:
    stem = Path(name).stem
    stem = re.sub(r"@\dx$", "", stem)
    return stem


def pick_one_scale_variant(files: List[Path]) -> List[Path]:
    grouped: Dict[str, List[Path]] = {}
    for f in files:
        grouped.setdefault(base_name_from_file(f.name), []).append(f)

    picked: List[Path] = []
    for _, group in grouped.items():
        def area(path: Path) -> int:
            img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
            if img is None:
                return -1
            return int(img.shape[0] * img.shape[1])

        best = sorted(group, key=area, reverse=True)[0]
        picked.append(best)
    return sorted(picked)


def best_template_match(screen_gray: np.ndarray, templ_gray: np.ndarray) -> Tuple[float, float, Tuple[int, int], Tuple[int, int]]:
    best_score = -1.0
    best_scale = 1.0
    best_loc = (0, 0)
    best_size = (templ_gray.shape[1], templ_gray.shape[0])

    for scale in SCALE_CANDIDATES:
        w = max(int(round(templ_gray.shape[1] * scale)), 1)
        h = max(int(round(templ_gray.shape[0] * scale)), 1)
        if w < MIN_DIM or h < MIN_DIM:
            continue
        if w >= screen_gray.shape[1] or h >= screen_gray.shape[0]:
            continue

        resized = cv2.resize(templ_gray, (w, h), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
        if resized.std() < 3.0:
            continue

        res = cv2.matchTemplate(screen_gray, resized, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(res)

        if max_val > best_score:
            best_score = float(max_val)
            best_scale = float(scale)
            best_loc = (int(max_loc[0]), int(max_loc[1]))
            best_size = (int(w), int(h))

    return best_score, best_scale, best_loc, best_size


def main() -> None:
    if not ASSETS_DIR.exists():
        raise SystemExit(f"assets directory not found: {ASSETS_DIR}")

    for key, p in SCREENSHOTS.items():
        if not p.exists():
            raise SystemExit(f"missing screenshot ({key}): {p}")

    screen_gray = {
        key: to_gray(load_image_rgba(path))
        for key, path in SCREENSHOTS.items()
    }

    files = [
        p
        for p in ASSETS_DIR.rglob("*")
        if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}
    ]
    files = pick_one_scale_variant(files)

    results: List[AssetResult] = []

    for asset_path in files:
        try:
            img = trim_transparent(load_image_rgba(asset_path))
        except Exception:
            continue

        h, w = img.shape[:2]
        if w < MIN_DIM or h < MIN_DIM:
            continue

        gray = to_gray(img)
        if gray.std() < 3.0:
            continue

        matches: List[MatchResult] = []
        for sname, sgray in screen_gray.items():
            score, scale, loc, size = best_template_match(sgray, gray)
            if score < 0:
                continue
            matches.append(
                MatchResult(
                    screenshot=sname,
                    score=score,
                    scale=scale,
                    x=loc[0],
                    y=loc[1],
                    width=size[0],
                    height=size[1],
                )
            )

        matches = sorted(matches, key=lambda x: x.score, reverse=True)
        best = matches[0] if matches else None
        second = matches[1] if len(matches) > 1 else None

        gap = (best.score - second.score) if (best and second) else (best.score if best else 0.0)

        if best is None:
            status = "unused"
        elif best.score >= SELECTED_THRESHOLD and gap >= 0.01:
            status = "selected"
        elif best.score >= AMBIGUOUS_THRESHOLD:
            status = "ambiguous"
        else:
            status = "unused"

        results.append(
            AssetResult(
                asset=str(asset_path.relative_to(ASSETS_DIR)),
                base_name=base_name_from_file(asset_path.name),
                width=w,
                height=h,
                best_match=best,
                second_match=second,
                confidence_gap=round(float(gap), 4),
                status=status,
            )
        )

    selected = [r for r in results if r.status == "selected"]
    ambiguous = [r for r in results if r.status == "ambiguous"]
    unused = [r for r in results if r.status == "unused"]

    # sort by confidence
    selected.sort(key=lambda r: r.best_match.score if r.best_match else 0, reverse=True)
    ambiguous.sort(key=lambda r: r.best_match.score if r.best_match else 0, reverse=True)
    unused.sort(key=lambda r: r.best_match.score if r.best_match else 0, reverse=True)

    payload = {
        "summary": {
            "assets_considered": len(results),
            "selected": len(selected),
            "ambiguous": len(ambiguous),
            "unused": len(unused),
            "selected_threshold": SELECTED_THRESHOLD,
            "ambiguous_threshold": AMBIGUOUS_THRESHOLD,
        },
        "selected": [asdict(r) for r in selected],
        "ambiguous": [asdict(r) for r in ambiguous],
        "unused": [asdict(r) for r in unused],
    }

    (OUT_DIR / "asset-match-report.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "selected-assets.json").write_text(json.dumps([asdict(r) for r in selected], ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "ambiguous-assets.json").write_text(json.dumps([asdict(r) for r in ambiguous], ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "unused-assets.json").write_text(json.dumps([asdict(r) for r in unused], ensure_ascii=False, indent=2), encoding="utf-8")

    # Build a quick manifest draft for selected assets
    manifest = {
        "version": "1.0.0",
        "assets": [
            {
                "nodeId": f"auto:{r.base_name}",
                "name": r.base_name,
                "type": "image",
                "usage": "decorative",
                "path": f"./assets/{Path(r.asset).name}",
                "width": r.width,
                "height": r.height,
                "scale": "auto",
                "hash": ""
            }
            for r in selected
        ]
    }
    (OUT_DIR / "asset-manifest.draft.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps(payload["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
