import subprocess
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException

from .. import launchd, terminal
from ..schemas import Section, SectionCreate, SectionUpdate
from ..storage import read_json, write_json_atomic
from .projects import _load as _load_projects

router = APIRouter(prefix="/sections", tags=["sections"])

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "sections.json"


def _load() -> list[dict]:
    return read_json(DATA_PATH, [])


def _save(sections: list[dict]) -> None:
    write_json_atomic(DATA_PATH, sections)


def _find(sections: list[dict], section_id: str) -> dict:
    for section in sections:
        if section["id"] == section_id:
            return section
    raise HTTPException(status_code=404, detail="Seção não encontrada")


@router.get("", response_model=list[Section])
def list_sections() -> list[dict]:
    return _load()


@router.post("", response_model=Section, status_code=201)
def create_section(payload: SectionCreate) -> dict:
    sections = _load()
    section = payload.model_dump()
    section["id"] = f"sec-{uuid.uuid4().hex[:8]}"
    sections.append(section)
    _save(sections)
    return section


@router.put("/{section_id}", response_model=Section)
def update_section(section_id: str, payload: SectionUpdate) -> dict:
    sections = _load()
    section = _find(sections, section_id)
    updates = payload.model_dump(exclude_unset=True)
    section.update(updates)
    _save(sections)
    return section


@router.delete("/{section_id}", status_code=204)
def delete_section(section_id: str) -> None:
    sections = _load()
    remaining = [s for s in sections if s["id"] != section_id]
    if len(remaining) == len(sections):
        raise HTTPException(status_code=404, detail="Seção não encontrada")
    _save(remaining)


@router.post("/{section_id}/start")
def start_section(section_id: str) -> dict:
    sections = _load()
    section = _find(sections, section_id)
    projects = _load_projects()
    section_projects = [p for p in projects if p["id"] in section["projectIds"]]

    missing = [p["id"] for p in section_projects if not p.get("runCommand")]
    if missing:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Nem todos os projetos do grupo/seção estão configurados",
                "missingRunCommand": missing,
            },
        )

    agents = launchd.list_agents()
    started: list[str] = []
    already_running: list[str] = []
    failed: list[dict] = []
    tail_targets: list[tuple[str, Path]] = []

    for project in section_projects:
        log_file = launchd.log_path(section_id, project["id"])
        tail_targets.append((project["name"], log_file))
        is_loaded = project["id"] in agents
        if is_loaded and agents[project["id"]] is not None:
            already_running.append(project["id"])
            continue
        working_dir = project["folders"][0]["path"] if project["folders"] else None
        try:
            if is_loaded:
                # carregado mas sem PID (ex: comando anterior falhou e saiu) —
                # precisa descarregar antes de poder carregar de novo
                launchd.bootout(project["id"])
            launchd.write_plist(project["id"], project["runCommand"], working_dir, log_file)
            launchd.bootstrap(project["id"])
            started.append(project["id"])
        except subprocess.CalledProcessError as exc:
            failed.append({"projectId": project["id"], "error": exc.stderr.strip()})

    terminal.open_tail_window(section_id, tail_targets)

    return {"started": started, "alreadyRunning": already_running, "failed": failed}


@router.post("/{section_id}/stop")
def stop_section(section_id: str) -> dict:
    sections = _load()
    section = _find(sections, section_id)
    agents = launchd.list_agents()

    stopped: list[str] = []
    not_running: list[str] = []
    failed: list[dict] = []
    log_paths = [launchd.log_path(section_id, project_id) for project_id in section["projectIds"]]

    for project_id in section["projectIds"]:
        if project_id not in agents:
            not_running.append(project_id)
            continue
        try:
            launchd.bootout(project_id)
            stopped.append(project_id)
        except subprocess.CalledProcessError as exc:
            failed.append({"projectId": project_id, "error": exc.stderr.strip()})

    terminal.close_tail_window(section_id, log_paths)

    return {"stopped": stopped, "notRunning": not_running, "failed": failed}
