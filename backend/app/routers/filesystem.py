import subprocess

from fastapi import APIRouter

router = APIRouter(tags=["filesystem"])


@router.post("/pick-folder")
def pick_folder() -> dict:
    script = 'POSIX path of (choose folder with prompt "Selecione a pasta do projeto")'
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        return {"path": None}
    return {"path": result.stdout.strip()}
