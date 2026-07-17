import re

_BOARD_ID_RE = re.compile(r"/b/([^/]+)")


def extract_board_id(board_url: str | None) -> str | None:
    if not board_url:
        return None
    match = _BOARD_ID_RE.search(board_url)
    return match.group(1) if match else None
