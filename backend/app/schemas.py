from pydantic import BaseModel


class Folder(BaseModel):
    name: str
    path: str


class ProjectBase(BaseModel):
    name: str
    folders: list[Folder] = []
    trelloBoardUrl: str | None = None
    runCommand: str | None = None


class ProjectCreate(ProjectBase):
    pass


class ProjectUpdate(BaseModel):
    name: str | None = None
    folders: list[Folder] | None = None
    trelloBoardUrl: str | None = None
    runCommand: str | None = None


class Project(ProjectBase):
    id: str
    trelloBoardId: str | None = None


class SectionPosition(BaseModel):
    x: float
    y: float
    width: float
    height: float


class SectionBase(BaseModel):
    name: str
    position: SectionPosition
    projectIds: list[str] = []


class SectionCreate(SectionBase):
    pass


class SectionUpdate(BaseModel):
    name: str | None = None
    position: SectionPosition | None = None
    projectIds: list[str] | None = None


class Section(SectionBase):
    id: str


class OpenVSCodeRequest(BaseModel):
    paths: list[str]
