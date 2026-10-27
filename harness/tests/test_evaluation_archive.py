import gzip
import unittest

from harness.evaluation.archive import read_evidence
from tests.evaluation_support import (
    LEDGER,
    LEDGER_PATH,
    SDK_FIXTURE,
    SDK_PATH,
    CaptureTestCase,
    default_members,
    jsonl,
    replace_archive,
    update_archive_hash,
)


class ReadEvidenceTests(CaptureTestCase):
    def test_duplicate_linked_or_traversing_members_are_rejected(self):
        variants = {
            "duplicate": [
                {"name": SDK_PATH, "content": SDK_FIXTURE.read_bytes()},
                {"name": SDK_PATH, "content": SDK_FIXTURE.read_bytes()},
            ],
            "normalized duplicate": [
                {"name": SDK_PATH, "content": SDK_FIXTURE.read_bytes()},
                {"name": f"./{SDK_PATH}", "content": SDK_FIXTURE.read_bytes()},
            ],
            "symlink": [{"name": SDK_PATH, "type": "symlink", "linkname": LEDGER_PATH}],
            "hardlink": [
                {"name": SDK_PATH, "type": "hardlink", "linkname": LEDGER_PATH}
            ],
            "traversal": [
                {"name": "data/harness-artifacts/../escape", "content": b"bad"}
            ],
            "late traversal": default_members()
            + [{"name": "data/harness-artifacts/../escape", "content": b"bad"}],
        }
        for name, members in variants.items():
            with self.subTest(name=name):
                capture_dir = self.new_capture()
                replace_archive(capture_dir, members)
                self.assert_rejected("", capture_dir)

    def test_corrupt_tar_and_gzip_are_rejected_after_manifest_hash_matches(self):
        for kind in ("bad-gzip", "bad-tar", "late-header", "trailer"):
            with self.subTest(kind=kind):
                capture_dir = self.new_capture()
                archive = capture_dir / "harness-artifacts.tar.gz"
                if kind == "bad-gzip":
                    archive.write_bytes(b"\x1f\x8b\x08")
                elif kind == "bad-tar":
                    archive.write_bytes(gzip.compress(b"not a tar archive"))
                elif kind == "trailer":
                    archive.write_bytes(archive.read_bytes()[:-8])
                else:
                    uncompressed = bytearray(gzip.decompress(archive.read_bytes()))
                    ledger_size = len(jsonl(LEDGER))
                    second_header = 512 + ((ledger_size + 511) // 512) * 512
                    uncompressed[second_header] ^= 1
                    archive.write_bytes(gzip.compress(uncompressed))
                update_archive_hash(capture_dir)
                self.assert_rejected("archive|Archive", capture_dir)

    def test_only_ledger_and_immediate_sdk_members_are_read(self):
        replace_archive(
            self.capture_dir,
            default_members()
            + [
                {
                    "name": "data/harness-artifacts/probes/deepagents-events/no.jsonl",
                    "content": b"bad",
                },
                {
                    "name": "data/harness-artifacts/deepagents-events/nested/no.jsonl",
                    "content": b"bad",
                },
            ],
        )
        stale = self.capture_dir / "extracted/data/harness-artifacts"
        stale.mkdir(parents=True)
        (stale / "events.jsonl").write_text("bad")
        files = read_evidence(self.capture_dir / "harness-artifacts.tar.gz")
        self.assertEqual([item.path for item in files], [LEDGER_PATH, SDK_PATH])
        report = self.report()
        self.assertEqual(report["execution"]["status"], "completed")
        self.assertEqual(report["deepagents"]["summary"]["usage"]["total_tokens"], 44)


if __name__ == "__main__":
    unittest.main()
