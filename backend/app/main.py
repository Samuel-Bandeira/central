from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import launchd, port_utils
from .routers import activities, filesystem, projects, sections, vscode

app = FastAPI(title="Launcher de Projetos")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router)
app.include_router(sections.router)
app.include_router(filesystem.router)
app.include_router(vscode.router)
app.include_router(activities.router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/running-projects")
def running_projects() -> dict:
    agents = launchd.list_agents()
    all_projects = {p["id"]: p for p in projects.load_projects()}
    running_ids = sorted(project_id for project_id, pid in agents.items() if pid is not None)
    ports: dict[str, list[int]] = {}
    for project_id, pid in agents.items():
        if pid is None:
            continue
        folders = all_projects.get(project_id, {}).get("folders") or []
        working_directory = folders[0]["path"] if folders else None
        ports[project_id] = port_utils.project_ports(pid, working_directory)
    return {"projectIds": running_ids, "ports": ports}
