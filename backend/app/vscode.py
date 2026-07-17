import hashlib
import json
import subprocess
from pathlib import Path

WORKSPACES_DIR = Path.home() / "Library" / "Application Support" / "central-launcher" / "workspaces"


class CodeCommandNotFound(Exception):
    pass


def _workspace_path(paths: list[str]) -> Path:
    key = "|".join(sorted(paths))
    digest = hashlib.md5(key.encode()).hexdigest()[:12]
    return WORKSPACES_DIR / f"{digest}.code-workspace"


def _write_workspace(paths: list[str]) -> Path:
    WORKSPACES_DIR.mkdir(parents=True, exist_ok=True)
    path = _workspace_path(paths)
    data = {"folders": [{"path": p} for p in paths]}
    path.write_text(json.dumps(data, indent=2))
    return path


def open_in_vscode(paths: list[str]) -> str:
    """Abre uma pasta direto, ou gera/reaproveita um .code-workspace quando
    são várias pastas do mesmo projeto — mesmo mecanismo descrito no
    arquitetura.md (componente 4)."""
    target = paths[0] if len(paths) == 1 else str(_write_workspace(paths))
    try:
        result = subprocess.run(["code", target], capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise CodeCommandNotFound(
            "Comando 'code' não encontrado. No VS Code: Cmd+Shift+P → "
            "\"Shell Command: Install 'code' command in PATH\"."
        ) from exc
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Falha ao abrir o VS Code")
    return target
