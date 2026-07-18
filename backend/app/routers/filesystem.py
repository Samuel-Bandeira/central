import subprocess

from fastapi import APIRouter, HTTPException

from .. import git_utils

router = APIRouter(tags=["filesystem"])


@router.post("/pick-folder")
def pick_folder() -> dict:
    script = 'POSIX path of (choose folder with prompt "Selecione a pasta do projeto")'
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        return {"path": None}
    return {"path": result.stdout.strip()}


@router.get("/git-branches")
def git_branches(path: str) -> dict:
    """Baseado no caminho da pasta, não no projeto cadastrado — funciona
    tanto na edição de um projeto existente quanto na criação (antes dele
    ter sido salvo)."""
    try:
        return {"branches": git_utils.list_branches(path)}
    except git_utils.GitError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
