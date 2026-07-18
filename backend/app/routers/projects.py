import subprocess
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException

from .. import git_utils
from ..schemas import Project, ProjectCreate, ProjectUpdate
from ..storage import read_json, write_json_atomic
from ..trello import extract_board_id

router = APIRouter(prefix="/projects", tags=["projects"])

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "projects.json"
SECTIONS_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "sections.json"


def _load() -> list[dict]:
    return read_json(DATA_PATH, [])


def _save(projects: list[dict]) -> None:
    write_json_atomic(DATA_PATH, projects)


def _find(projects: list[dict], project_id: str) -> dict:
    for project in projects:
        if project["id"] == project_id:
            return project
    raise HTTPException(status_code=404, detail="Projeto não encontrado")


@router.get("", response_model=list[Project])
def list_projects() -> list[dict]:
    return _load()


@router.post("", response_model=Project, status_code=201)
def create_project(payload: ProjectCreate) -> dict:
    projects = _load()
    project = payload.model_dump()
    project["id"] = f"proj-{uuid.uuid4().hex[:8]}"
    project["trelloBoardId"] = extract_board_id(payload.trelloBoardUrl)
    projects.append(project)
    _save(projects)
    return project


@router.put("/{project_id}", response_model=Project)
def update_project(project_id: str, payload: ProjectUpdate) -> dict:
    projects = _load()
    project = _find(projects, project_id)
    updates = payload.model_dump(exclude_unset=True)
    project.update(updates)
    if "trelloBoardUrl" in updates:
        project["trelloBoardId"] = extract_board_id(updates["trelloBoardUrl"])
    _save(projects)
    return project


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: str) -> None:
    projects = _load()
    remaining = [p for p in projects if p["id"] != project_id]
    if len(remaining) == len(projects):
        raise HTTPException(status_code=404, detail="Projeto não encontrado")
    _save(remaining)

    # Remove o projeto das seções que o referenciam — senão o id órfão fica
    # pendurado em sections.json indefinidamente.
    sections = read_json(SECTIONS_DATA_PATH, [])
    changed = False
    for section in sections:
        if project_id in section["projectIds"]:
            section["projectIds"] = [pid for pid in section["projectIds"] if pid != project_id]
            changed = True
    if changed:
        write_json_atomic(SECTIONS_DATA_PATH, sections)


@router.get("/{project_id}/git-status")
def get_git_status(project_id: str) -> dict:
    """Branch atual do projeto e se está em dia com a branch de
    desenvolvimento configurada. Não é erro a pasta não ser um repo git
    (projeto pode nem usar git) nem faltar devBranch — só volta campos
    nulos nesses casos, em vez de recusar."""
    projects = _load()
    project = _find(projects, project_id)
    if not project["folders"]:
        return {"currentBranch": None, "devBranch": project.get("devBranch"), "upToDate": None}
    folder = project["folders"][0]["path"]

    try:
        current = git_utils.current_branch(folder)
    except git_utils.GitError:
        return {"currentBranch": None, "devBranch": project.get("devBranch"), "upToDate": None}

    dev_branch = project.get("devBranch")
    up_to_date = None
    if dev_branch:
        subprocess.run(["git", "-C", folder, "fetch", "--prune"], capture_output=True, text=True)
        for ref in (f"origin/{dev_branch}", dev_branch):
            if not git_utils.ref_exists(folder, ref):
                continue
            try:
                up_to_date = git_utils.commits_behind(folder, ref) == 0
                break
            except git_utils.GitError:
                continue

    return {"currentBranch": current, "devBranch": dev_branch, "upToDate": up_to_date}


@router.get("/{project_id}/trello-summary")
def get_trello_summary(project_id: str) -> dict:
    projects = _load()
    _find(projects, project_id)
    return {"integrated": False, "lists": []}


@router.get("/{project_id}/cards")
def get_trello_cards(project_id: str) -> dict:
    projects = _load()
    _find(projects, project_id)
    return {"integrated": False, "cards": []}
