from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import launchd
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
    return {"projectIds": sorted(launchd.list_running_project_ids())}
