import unittest
from datetime import date

import yaml

from harness.evaluation.parsing import parse_json, parse_yaml, timestamp_ms


class ParseJsonTests(unittest.TestCase):
    def test_parse_json_requires_strict_utf8_object(self):
        self.assertEqual(parse_json(b'\xef\xbb\xbf{"ok":1}', "input"), {"ok": 1})
        for content in (b"[]", b'{"x":NaN}', b"\xff"):
            with self.subTest(content=content), self.assertRaises(ValueError):
                parse_json(content, "input")


class TimestampTests(unittest.TestCase):
    def test_timestamp_ms_truncates_to_milliseconds_and_validates_calendar(self):
        self.assertEqual(
            timestamp_ms("2026-09-21T02:00:00.123999+02:00"), 1789948800123
        )
        self.assertEqual(timestamp_ms("2026-09-21T00:00:00.1239999Z"), 1789948800123)
        self.assertEqual(
            timestamp_ms("2026-09-21T00:00:00.999999Z", sdk=True),
            1789948800999,
        )
        for value, sdk in (
            ("2026-02-31T00:00:00Z", False),
            ("0000-01-01T00:00:00Z", False),
            ("2026-09-21 00:00:00Z", False),
            ("2026-09-21T00:00:00-01:00", True),
            ("２０２６-09-21T00:00:00Z", False),
            ("２０２６-09-21T00:00:00Z", True),
        ):
            with self.subTest(value=value, sdk=sdk), self.assertRaises(ValueError):
                timestamp_ms(value, sdk=sdk)


class ParseYamlTests(unittest.TestCase):
    def test_evaluation_yaml_loader_does_not_change_safe_load(self):
        values = yaml.safe_load("enabled: true\ndate: 2026-09-21\n")

        self.assertIs(values["enabled"], True)
        self.assertEqual(values["date"], date(2026, 9, 21))

    def test_yaml_mapping_keys_are_strings_or_integers(self):
        for key in ("123", '"123"'):
            with self.subTest(key=key):
                self.assertEqual(parse_yaml(f"{key}: value\n", "doc"), {"123": "value"})
        for key in ("true", "~"):
            with (
                self.subTest(key=key),
                self.assertRaisesRegex(ValueError, "unsupported YAML mapping key"),
            ):
                parse_yaml(f"{key}: value\n", "doc")
        with self.assertRaisesRegex(ValueError, "duplicate YAML key: 123"):
            parse_yaml('"123": first\n123: second\n', "doc")

    def test_yaml_keeps_non_decimal_plain_scalars_as_strings(self):
        for value in ("1:20", "1:20.5", "1e3", "0xFF", ".nan", "on", "2026-09-21"):
            with self.subTest(value=value):
                self.assertEqual(parse_yaml(f"value: {value}\n", "doc")["value"], value)
        self.assertEqual(parse_yaml("value: 012\n", "doc")["value"], 12)
        self.assertIs(parse_yaml("value: TRUE\n", "doc")["value"], True)


if __name__ == "__main__":
    unittest.main()
