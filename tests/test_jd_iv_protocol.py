
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))

import jd_iv_protocol as mod
from jd_iv_protocol import choose_solver_gap, parse_distance_offsets, planned_submit_attempts
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

    def test_planned_attempts_use_trajectory_variants_before_fail_offsets(self):
        attempts = planned_submit_attempts(90, [0, -1, 1], trajectory_variants=2)
        self.assertEqual(
            [(a['distance'], a['trajectory_variant'], a['reason']) for a in attempts],
            [(90, 0, 'initial'), (90, 1, 'refuse_variant'), (89, 0, 'fail_offset'), (91, 0, 'fail_offset')],
        )

if __name__ == '__main__':
    unittest.main()
