
#!/usr/bin/env python3
import argparse, json, statistics, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))
from PIL import Image
from jd_iv_protocol import solver_distance

SOLVERS = ["builtin", "ddddocr", "captcha-recognizer"]

def load_samples(outputs: Path, limit: int):
    samples = sorted(outputs.glob("*_slide_debug/gap.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if limit:
        samples = samples[:limit]
    out = []
    for gap_path in samples:
        d = gap_path.parent
        if (d / "bg.png").exists() and (d / "patch.png").exists():
            gap = json.loads(gap_path.read_text(encoding="utf-8"))
            out.append({"dir": d, "baseline": int(gap.get("down_distance") or 0), "gap": gap})
    return out

def main():
    ap = argparse.ArgumentParser(description="Compare pure-HTTP JD slide image solvers on saved bg/patch samples.")
    ap.add_argument("--outputs", default=str(ROOT / "outputs"))
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--ui-width", type=int, default=281)
    ap.add_argument("--json-out", default=str(ROOT / "outputs" / "slide_solver_compare.json"))
    args = ap.parse_args()

    rows = []
    samples = load_samples(Path(args.outputs), args.limit)
    for sample in samples:
        bg = Image.open(sample["dir"] / "bg.png").convert("RGBA")
        patch = Image.open(sample["dir"] / "patch.png").convert("RGBA")
        row = {"sample": sample["dir"].name, "baseline_distance": sample["baseline"], "solvers": {}}
        for solver in SOLVERS:
            t0 = time.time()
            print(f"sample={sample['dir'].name} solver={solver}", flush=True)
            try:
                r = solver_distance(bg, patch, sample["gap"].get("edge", {}).get("y"), args.ui_width, solver)
                dist = int(r["down_distance"])
                row["solvers"][solver] = {
                    "ok": True,
                    "distance": dist,
                    "delta_vs_builtin_saved": dist - sample["baseline"],
                    "confidence": (r.get("raw") or {}).get("confidence"),
                    "chosen_x_bg": r.get("chosen_x_bg"),
                    "elapsed_sec": round(time.time() - t0, 3),
                }
            except Exception as e:
                row["solvers"][solver] = {"ok": False, "error": repr(e), "elapsed_sec": round(time.time() - t0, 3)}
        rows.append(row)

    summary = {}
    for solver in SOLVERS:
        ok = [r["solvers"][solver] for r in rows if r["solvers"][solver].get("ok")]
        deltas = [abs(x["delta_vs_builtin_saved"]) for x in ok]
        summary[solver] = {
            "available": len(ok),
            "samples": len(rows),
            "mean_abs_delta_vs_builtin_saved": round(statistics.mean(deltas), 2) if deltas else None,
            "median_abs_delta_vs_builtin_saved": round(statistics.median(deltas), 2) if deltas else None,
            "within_3px_vs_builtin_saved": sum(1 for d in deltas if d <= 3),
            "within_8px_vs_builtin_saved": sum(1 for d in deltas if d <= 8),
        }
    report = {"sample_count": len(rows), "summary": summary, "rows": rows}
    Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.json_out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"json_out": args.json_out, "sample_count": len(rows), "summary": summary}, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
