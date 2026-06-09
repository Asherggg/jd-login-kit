
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))

from jd_iv_protocol import choose_solver_gap, parse_distance_offsets, planned_submit_attempts


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

    def test_planned_attempts_use_trajectory_variants_before_fail_offsets(self):
        attempts = planned_submit_attempts(90, [0, -1, 1], trajectory_variants=2)
        self.assertEqual(
            [(a['distance'], a['trajectory_variant'], a['reason']) for a in attempts],
            [(90, 0, 'initial'), (90, 1, 'refuse_variant'), (89, 0, 'fail_offset'), (91, 0, 'fail_offset')],
        )

if __name__ == '__main__':
    unittest.main()
