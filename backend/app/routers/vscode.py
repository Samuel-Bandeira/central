from fastapi import APIRouter, HTTPException

from .. import vscode
from ..schemas import OpenVSCodeRequest

router = APIRouter(tags=["vscode"])


@router.post("/open-vscode")
def open_vscode(payload: OpenVSCodeRequest) -> dict:
    if not payload.paths:
        raise HTTPException(status_code=400, detail="Nenhuma pasta informada")
    try:
        target = vscode.open_in_vscode(payload.paths)
    except vscode.CodeCommandNotFound as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"opened": target}
