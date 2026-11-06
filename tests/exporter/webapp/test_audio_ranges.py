"""Audio ranges describe exactly the bytes returned, without opening databases."""

import ast
import re
from collections.abc import Callable
from pathlib import Path
from typing import cast

import pytest
from starlette.requests import Request
from starlette.responses import Response

AUDIO = b"0123456789"


def audio_response(
    range_header: str | None, recording: bytes | None = AUDIO
) -> Response:
    """Execute the actual route with only its database recording lookup replaced.

    Importing main starts the database preloads. Extracting this function avoids
    those unrelated startup dependencies while retaining real response behavior.
    """
    source = Path("exporter/webapp/main.py")
    parsed = ast.parse(source.read_text(encoding="utf-8"))
    route = next(
        node
        for node in parsed.body
        if isinstance(node, ast.FunctionDef) and node.name == "get_audio"
    )
    route.decorator_list = []
    module = ast.fix_missing_locations(ast.Module(body=[route], type_ignores=[]))

    def get_record(headword: str, gender: str) -> bytes | None:
        return recording

    namespace = {
        "Request": Request,
        "Response": Response,
        "re": re,
        "get_audio_record": get_record,
    }
    exec(compile(module, str(source), "exec"), namespace)
    get_audio = cast(Callable[[Request, str, str], Response], namespace["get_audio"])
    headers = [] if range_header is None else [(b"range", range_header.encode("ascii"))]
    request = Request({"type": "http", "headers": headers})
    return get_audio(request, "dhamma", "male1")


@pytest.mark.parametrize(
    ("range_header", "expected_range", "expected_body"),
    [
        ("bytes=2-3", "bytes 2-3/10", b"23"),
        ("bytes=0-99", "bytes 0-9/10", AUDIO),
        ("bytes=3-99", "bytes 3-9/10", b"3456789"),
        ("bytes=3-", "bytes 3-9/10", b"3456789"),
        ("bytes=9-9", "bytes 9-9/10", b"9"),
        ("bytes=9-", "bytes 9-9/10", b"9"),
    ],
)
def test_partial_audio_matches_its_content_range(
    range_header: str, expected_range: str, expected_body: bytes
) -> None:
    response = audio_response(range_header)
    assert response.status_code == 206
    assert response.body == expected_body
    assert response.headers["content-range"] == expected_range
    assert response.headers["content-length"] == str(len(expected_body))
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-type"] == "audio/mpeg"


@pytest.mark.parametrize(
    "range_header",
    [
        None,
        "bytes=3-2",
        "bytes=10-",
        "bytes=-3",
        "items=0-3",
        "bytes=0-3trailing",
        "bytes=0-3,6-9",
        "bytes=0-9999999999999999",
        pytest.param("bytes=" + "9" * 5000 + "-", id="huge-start"),
    ],
)
def test_ignored_audio_ranges_keep_the_full_response(range_header: str | None) -> None:
    response = audio_response(range_header)
    assert response.status_code == 200
    assert response.body == AUDIO
    assert response.headers["content-length"] == "10"
    assert "content-range" not in response.headers


def test_missing_recording_still_returns_not_found() -> None:
    response = audio_response("bytes=0-99", recording=None)
    assert response.status_code == 404
    assert response.body == b""
    assert "content-range" not in response.headers
