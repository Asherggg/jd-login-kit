#!/usr/bin/env python3
"""Offline benchmark for pure ddddocr-tuned slide presets on saved JD HTTP samples."""
import argparse
import json
import statistics
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))

from jd_iv_protocol import ddddocr_tuned_gap, parse_distance_range


def load_samples(outputs: Path, limit: int):
    paths = sorted(outputs.glob('*_slide_debug/gap.json'), key=lambda p: p.stat().st_mtime, reverse=True)
    if limit:
        paths = paths[:limit]
    samples = []
    for gap_path in paths:
        d = gap_path.parent
        bg = d / 'bg.png'
        patch = d / 'patch.png'
        if not bg.exists() or not patch.exists():
            continue
        try:
            old_gap = json.loads(gap_path.read_text(encoding='utf-8'))
        except Exception:
            old_gap = {}
        samples.append({'dir': d, 'gap_path': gap_path, 'old_gap': old_gap})
    return samples


def summarize(rows, distance_range):
    valid = [r for r in rows if not r['gap'].get('skipped')]
    skipped = [r for r in rows if r['gap'].get('skipped')]
    distances = [r['gap'].get('down_distance') for r in valid if r['gap'].get('down_distance') is not None]
    confidences = [r['gap'].get('confidence') for r in valid if r['gap'].get('confidence') is not None]
    lo, hi = distance_range
    return {
        'samples': len(rows),
        'valid_candidates': len(valid),
        'skipped': len(skipped),
        'valid_rate': round(len(valid) / len(rows), 4) if rows else 0,
        'distance_range': [lo, hi],
        'distance_min': min(distances) if distances else None,
        'distance_max': max(distances) if distances else None,
        'distance_mean': round(statistics.mean(distances), 2) if distances else None,
        'confidence_mean': round(statistics.mean(confidences), 4) if confidences else None,
        'preset_counts': count_by(valid, lambda r: r['gap'].get('preset')),
        'coordinate_counts': count_by(valid, lambda r: r['gap'].get('coordinate')),
        'skip_reasons': count_by(skipped, lambda r: r['gap'].get('skip_reason')),
    }


def count_by(rows, fn):
    out = {}
    for row in rows:
        key = str(fn(row))
        out[key] = out.get(key, 0) + 1
    return out


def main():
    ap = argparse.ArgumentParser(description='Offline benchmark pure ddddocr-tuned JD slide presets.')
    ap.add_argument('--outputs', default=str(ROOT / 'outputs'))
    ap.add_argument('--limit', type=int, default=60)
    ap.add_argument('--presets', default='alpha-crop-simple,edge-crop-simple,roi-y-simple,contrast-simple,raw-simple,raw-edge')
    ap.add_argument('--coordinate', default='auto', choices=['center', 'left', 'scaled-left', 'auto'])
    ap.add_argument('--min-confidence', type=float, default=0.2)
    ap.add_argument('--distance-range', default='45,135')
    ap.add_argument('--json-out', default=str(ROOT / 'outputs' / 'ddddocr_tuned_offline_summary.json'))
    args = ap.parse_args()

    dr = parse_distance_range(args.distance_range)
    rows = []
    for sample in load_samples(Path(args.outputs), args.limit):
        bg = Image.open(sample['dir'] / 'bg.png').convert('RGBA')
        patch = Image.open(sample['dir'] / 'patch.png').convert('RGBA')
        y_hint = sample['old_gap'].get('edge', {}).get('y') or sample['old_gap'].get('y')
        gap = ddddocr_tuned_gap(
            bg, patch, y_hint, 281,
            presets=args.presets,
            coordinate=args.coordinate,
            min_confidence=args.min_confidence,
            distance_range=dr,
        )
        rows.append({
            'sample': sample['dir'].name,
            'gap': gap,
            'old_distance': sample['old_gap'].get('down_distance'),
        })

    report = {
        'config': {
            'presets': args.presets,
            'coordinate': args.coordinate,
            'min_confidence': args.min_confidence,
            'distance_range': list(dr),
            'limit': args.limit,
        },
        'summary': summarize(rows, dr),
        'rows': rows,
    }
    out = Path(args.json_out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding='utf-8')
    print(json.dumps({'json_out': str(out), 'summary': report['summary']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
