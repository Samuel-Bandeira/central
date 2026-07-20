import re
import uuid
from pathlib import Path

ATTACHMENTS_DIR = Path(__file__).resolve().parent / "data" / "attachments"

# O Claude Code lê imagem a partir de um caminho de arquivo (não recebe
# binário no prompt), então só aceitamos formatos que ele sabe interpretar
# como imagem.
ALLOWED_CONTENT_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


def _safe_filename(name: str) -> str:
    name = Path(name).name
    return re.sub(r"[^A-Za-z0-9._-]", "_", name) or "imagem"


def save_image(scope: str, filename: str, content: bytes) -> str:
    """Salva a imagem em ATTACHMENTS_DIR/<scope>/ com um nome único e
    devolve o caminho absoluto salvo — esse caminho é o que entra no prompt
    do Claude e no `src` que o frontend usa pra pedir a pré-visualização."""
    folder = ATTACHMENTS_DIR / scope
    folder.mkdir(parents=True, exist_ok=True)
    unique_name = f"{uuid.uuid4().hex[:8]}-{_safe_filename(filename)}"
    path = folder / unique_name
    path.write_bytes(content)
    return str(path)


def delete_image(path: str) -> None:
    """Apaga o arquivo se ele existir e realmente estiver dentro de
    ATTACHMENTS_DIR — melhor esforço, nunca levanta erro (um anexo já
    removido ou um caminho estranho não deve travar o fluxo)."""
    try:
        resolved = Path(path).resolve()
        resolved.relative_to(ATTACHMENTS_DIR.resolve())
    except (OSError, ValueError):
        return
    if resolved.exists():
        resolved.unlink()


def is_within_attachments_dir(path: str) -> bool:
    try:
        Path(path).resolve().relative_to(ATTACHMENTS_DIR.resolve())
        return True
    except (OSError, ValueError):
        return False
