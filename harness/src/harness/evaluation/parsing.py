"""Strict parsing primitives shared by the evaluation modules."""

import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any

import yaml

_TIMESTAMP = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})"
    r"(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$",
    re.ASCII,
)
_SDK_TIMESTAMP = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})"
    r"(?:\.(\d+))?(Z|\+00:00)$",
    re.ASCII,
)
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_SHA256 = re.compile(r"^[0-9a-f]{64}$", re.ASCII)
# Canonical lowercase commit form; require_commit accepts any case and normalizes.
COMMIT = re.compile(r"^[0-9a-f]{40}$", re.ASCII)
MAX_SAFE_INTEGER = 2**53 - 1


class _YamlLoader(yaml.SafeLoader):
    """SafeLoader without YAML 1.1 coercions of plain scalars.

    Only ``true``/``false`` are booleans and only plain decimals are integers, so
    values such as ``on``, ``0x1F``, ``1e3``, ``1:20`` or dates stay strings.
    """


_YamlLoader.yaml_implicit_resolvers = {
    first: [
        resolver
        for resolver in resolvers
        if resolver[0]
        not in {
            "tag:yaml.org,2002:bool",
            "tag:yaml.org,2002:float",
            "tag:yaml.org,2002:int",
            "tag:yaml.org,2002:timestamp",
        }
    ]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
_YamlLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:true|false|True|False|TRUE|FALSE)$"),
    list("tTfF"),
)
_YamlLoader.add_implicit_resolver(
    "tag:yaml.org,2002:int",
    re.compile(r"^[-+]?\d+$", re.ASCII),
    list("-+0123456789"),
)
_YamlLoader.add_constructor(
    "tag:yaml.org,2002:int",
    lambda loader, node: int(loader.construct_scalar(node), 10),
)


def _mapping(loader: _YamlLoader, node: yaml.MappingNode, deep: bool = False):
    result = {}
    for key_node, value_node in node.value:
        key = (
            loader.construct_object(key_node, deep=deep)
            if isinstance(key_node, yaml.ScalarNode)
            else None
        )
        if isinstance(key, bool) or not isinstance(key, (str, int)):
            raise ValueError("unsupported YAML mapping key")  # noqa: TRY004
        key = str(key)
        if key in result:
            raise ValueError(f"duplicate YAML key: {key}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


_YamlLoader.add_constructor("tag:yaml.org,2002:map", _mapping)


def parse_json(content: bytes, label: str) -> dict[str, Any]:
    """Parse a strict UTF-8 JSON object."""
    try:
        value = json.loads(
            content.decode("utf-8-sig"),
            parse_constant=lambda constant: (_ for _ in ()).throw(
                ValueError(f"{constant} is not valid JSON")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError(f"{label} must be valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")  # noqa: TRY004
    return value


def parse_yaml(content: bytes | str, label: str) -> dict[str, Any]:
    """Parse a YAML mapping without YAML 1.1 scalar coercions or duplicate keys."""
    try:
        raw = content.decode("utf-8-sig") if isinstance(content, bytes) else content
        value = yaml.load(raw, Loader=_YamlLoader)
    except (UnicodeDecodeError, yaml.YAMLError, ValueError) as error:
        raise ValueError(f"{label} must be valid YAML: {error}") from error
    return require_object(value, label)


def timestamp_ms(value: str, *, sdk: bool = False) -> int:
    """Validate a supported RFC 3339 timestamp and return epoch milliseconds."""
    if not (_SDK_TIMESTAMP if sdk else _TIMESTAMP).fullmatch(value):
        raise ValueError("Invalid timestamp")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise ValueError("Invalid timestamp") from error
    return (parsed - _EPOCH) // timedelta(milliseconds=1)


def safe_integer(value: Any, label: str, *, minimum: int = 0) -> int:
    if type(value) is not int or not minimum <= value <= MAX_SAFE_INTEGER:
        raise ValueError(f"{label} must be a safe integer")
    return value


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")  # noqa: TRY004
    return value


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be nonempty")
    return value


def require_commit(value: Any) -> str:
    if not isinstance(value, str) or not COMMIT.fullmatch(value.lower()):
        raise ValueError(f"Expected a full 40-character commit SHA, received {value}")
    return value.lower()


def require_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _SHA256.fullmatch(value):
        raise ValueError(f"{label} must be a lowercase SHA-256")
    return value
