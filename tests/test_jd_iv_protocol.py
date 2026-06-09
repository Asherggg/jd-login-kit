
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))

import jd_iv_protocol as mod
from jd_iv_protocol import (
    choose_solver_gap, parse_distance_offsets, planned_submit_attempts,
    crop_patch_alpha, normalize_ddddocr_x, parse_distance_range,
    choose_ddddocr_candidate,
)
from PIL import Image


class StrategyTests(unittest.TestCase):
    def test_parse_distance_offsets_accepts_comma_list(self):
        self.assertEqual(parse_distance_offsets('0,-1,1,2'), [0, -1, 1, 2])
        self.assertEqual(parse_distance_offsets(''), [0])

    def test_low_confidence_captcha_falls_back_to_builtin(self):
        captcha = {'solver': 'captcha-recognizer', 'down_distance': 34, 'raw': {'confidence': 0.59}}
        builtin = {'solver': 'builtin', 'down_distance': 128}
        chosen = choose_solver_gap('captcha-recognizer', captcha, builtin, min_confidence=0.8)
        self.assertEqual(chosen['solver'], 'builtin')
        self.assertEqual(chosen['fallback_reason'], 'captcha_confidence_below_threshold')
        self.assertEqual(chosen['candidate_solver'], 'captcha-recognizer')

    def test_high_confidence_captcha_is_kept(self):
        captcha = {'solver': 'captcha-recognizer', 'down_distance': 90, 'raw': {'confidence': 0.95}}
        builtin = {'solver': 'builtin', 'down_distance': 91}
        chosen = choose_solver_gap('captcha-recognizer', captcha, builtin, min_confidence=0.8)
        self.assertEqual(chosen['solver'], 'captcha-recognizer')


    def test_ddddocr_uses_simple_target_for_slider_captcha(self):
        class FakeDdddOcr:
            def __init__(self):
                self.simple_target_values = []

            def slide_match(self, target_img, background_img, simple_target=False):
                self.simple_target_values.append(simple_target)
                return {'target_x': 80, 'target_y': 10, 'confidence': 0.9}

        fake = FakeDdddOcr()
        old = mod._DDDDOCR_SLIDE
        mod._DDDDOCR_SLIDE = fake
        try:
            bg = Image.new('RGBA', (400, 200), 'white')
            patch = Image.new('RGBA', (50, 50), 'black')
            gap = mod.solver_distance(bg, patch, None, 200, 'ddddocr')
        finally:
            mod._DDDDOCR_SLIDE = old

        self.assertEqual(fake.simple_target_values, [True])
        self.assertEqual(gap['down_distance'], 40)

    def test_ddddocr_normal_keeps_legacy_non_simple_target_mode(self):
        class FakeDdddOcr:
            def __init__(self):
                self.simple_target_values = []

            def slide_match(self, target_img, background_img, simple_target=False):
                self.simple_target_values.append(simple_target)
                return {'target_x': 80, 'target_y': 10, 'confidence': 0.9}

        fake = FakeDdddOcr()
        old = mod._DDDDOCR_SLIDE
        mod._DDDDOCR_SLIDE = fake
        try:
            bg = Image.new('RGBA', (400, 200), 'white')
            patch = Image.new('RGBA', (50, 50), 'black')
            mod.solver_distance(bg, patch, None, 200, 'ddddocr-normal')
        finally:
            mod._DDDDOCR_SLIDE = old

        self.assertEqual(fake.simple_target_values, [False])


    def test_alpha_crop_returns_offset_and_trimmed_patch(self):
        img = Image.new('RGBA', (10, 8), (0, 0, 0, 0))
        for x in range(3, 8):
            for y in range(2, 6):
                img.putpixel((x, y), (255, 0, 0, 255))

        cropped, meta = crop_patch_alpha(img)

        self.assertEqual(cropped.size, (5, 4))
        self.assertEqual(meta['offset_x'], 3)
        self.assertEqual(meta['offset_y'], 2)

    def test_normalize_ddddocr_x_supports_center_left_and_scaled_left(self):
        base = {'raw_target_x': 100, 'target_width': 40, 'target_offset_x': 7, 'bg_offset_x': 5}

        self.assertEqual(normalize_ddddocr_x(base, 'center'), 105)
        self.assertEqual(normalize_ddddocr_x(base, 'left'), 85)
        self.assertEqual(normalize_ddddocr_x(base, 'scaled-left'), 78)

    def test_choose_ddddocr_candidate_filters_confidence_and_distance(self):
        candidates = [
            {'preset': 'bad-conf', 'confidence': 0.1, 'ui_distance': 80},
            {'preset': 'bad-distance', 'confidence': 0.9, 'ui_distance': 180},
            {'preset': 'good', 'confidence': 0.5, 'ui_distance': 90},
        ]

        chosen = choose_ddddocr_candidate(candidates, min_confidence=0.2, distance_range=(45, 135))

        self.assertEqual(chosen['preset'], 'good')
        self.assertEqual(chosen['reject_count'], 2)

    def test_ddddocr_tuned_is_pure_ddddocr_and_does_not_call_builtin(self):
        class FakeDdddOcr:
            def __init__(self):
                self.calls = []

            def slide_match(self, target_img, background_img, simple_target=False):
                self.calls.append(simple_target)
                return {'target_x': 100, 'target_y': 20, 'confidence': 0.8}

        fake = FakeDdddOcr()
        old_ocr = mod._DDDDOCR_SLIDE
        old_estimate = mod.estimate_gap
        mod._DDDDOCR_SLIDE = fake
        mod.estimate_gap = lambda *a, **kw: (_ for _ in ()).throw(AssertionError('builtin should not be called'))
        try:
            bg = Image.new('RGBA', (400, 200), 'white')
            patch = Image.new('RGBA', (50, 50), 'black')
            gap = mod.solver_distance(
                bg, patch, None, 200, 'ddddocr-tuned',
                ddddocr_presets='raw-simple,raw-edge',
                ddddocr_coordinate='auto',
                ddddocr_min_confidence=0.2,
                ddddocr_distance_range='40,140',
            )
        finally:
            mod._DDDDOCR_SLIDE = old_ocr
            mod.estimate_gap = old_estimate

        self.assertEqual(gap['solver'], 'ddddocr-tuned')
        self.assertEqual(gap['down_distance'], 50)
        self.assertIn(True, fake.calls)
        self.assertIn(False, fake.calls)
        self.assertFalse(gap.get('skipped'))

    def test_ddddocr_tuned_skips_when_all_candidates_are_bad(self):
        class FakeDdddOcr:
            def slide_match(self, target_img, background_img, simple_target=False):
                return {'target_x': 10, 'target_y': 20, 'confidence': 0.01}

        old = mod._DDDDOCR_SLIDE
        mod._DDDDOCR_SLIDE = FakeDdddOcr()
        try:
            bg = Image.new('RGBA', (400, 200), 'white')
            patch = Image.new('RGBA', (50, 50), 'black')
            gap = mod.solver_distance(
                bg, patch, None, 200, 'ddddocr-tuned',
                ddddocr_presets='raw-simple',
                ddddocr_coordinate='center',
                ddddocr_min_confidence=0.2,
                ddddocr_distance_range='45,135',
            )
        finally:
            mod._DDDDOCR_SLIDE = old

        self.assertTrue(gap['skipped'])
        self.assertEqual(gap['skip_reason'], 'skipped_bad_ddddocr_candidate')
        self.assertEqual(gap['s_response']['message'], 'skipped_bad_ddddocr_candidate')

    def test_parse_distance_range_accepts_min_max_text(self):
        self.assertEqual(parse_distance_range('45,135'), (45, 135))

    def test_planned_attempts_use_trajectory_variants_before_fail_offsets(self):
        attempts = planned_submit_attempts(90, [0, -1, 1], trajectory_variants=2)
        self.assertEqual(
            [(a['distance'], a['trajectory_variant'], a['reason']) for a in attempts],
            [(90, 0, 'initial'), (90, 1, 'refuse_variant'), (89, 0, 'fail_offset'), (91, 0, 'fail_offset')],
        )

if __name__ == '__main__':
    unittest.main()
