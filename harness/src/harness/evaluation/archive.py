"""Read evidence members from a captured harness-artifacts tar.gz archive."""

import gzip
import tarfile
import zlib
from pathlib import Path, PurePosixPath

from .event_records import EvidenceFile

LEDGER_PATH = "data/harness-artifacts/events.jsonl"
_ROOT = "data/harness-artifacts/"
_TarHeaderError = tarfile.HeaderError
_TarReadError = tarfile.ReadError


class StrictTarInfo(tarfile.TarInfo):
    """Treat malformed non-EOF headers as archive errors in stream mode."""

    @classmethod
    def fromtarfile(cls, tarfile):
        try:
            return super().fromtarfile(tarfile)
        except _TarHeaderError as error:
            if type(error).__name__ == "EOFHeaderError":
                raise
            raise _TarReadError(str(error)) from None


def _is_evidence(name: str) -> bool:
    """Select the assignment ledger and immediate DeepAgents event files only."""
    relative = name.removeprefix(_ROOT)
    return name.startswith(_ROOT) and (
        relative == "events.jsonl"
        or (
            relative.startswith("deepagents-events/")
            and len(PurePosixPath(relative).parts) == 2
            and relative.endswith(".jsonl")
        )
    )


def read_evidence(archive_path: Path) -> list[EvidenceFile]:
    """Return only ledger and immediate SDK files after validating the archive."""
    files = []
    seen = set()
    try:
        with gzip.open(archive_path, "rb") as compressed:
            with tarfile.open(
                fileobj=compressed, mode="r|", tarinfo=StrictTarInfo
            ) as archive:
                for member in archive:
                    parts = PurePosixPath(member.name).parts
                    if member.name.startswith("/") or ".." in parts:
                        raise ValueError("Unsafe archive path")
                    name = str(PurePosixPath(member.name))
                    if not _is_evidence(name):
                        continue
                    if not member.isfile() or name in seen:
                        raise ValueError("Duplicate or non-regular evidence member")
                    seen.add(name)
                    source = archive.extractfile(member)
                    if source is None:
                        raise ValueError("Unreadable evidence member")
                    files.append(EvidenceFile(name, source.read()))
            # Drain the stream so a truncated or corrupt gzip tail is detected.
            compressed.read()
    except (gzip.BadGzipFile, tarfile.TarError, EOFError, zlib.error) as error:
        raise ValueError(f"Could not read capture archive: {error}") from error
    return files
