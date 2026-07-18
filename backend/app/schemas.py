from pydantic import BaseModel


class Folder(BaseModel):
    name: str
    path: str


class ProjectBase(BaseModel):
    name: str
    folders: list[Folder] = []
    trelloBoardUrl: str | None = None
    runCommand: str | None = None
    devBranch: str | None = None


class ProjectCreate(ProjectBase):
    pass


class ProjectUpdate(BaseModel):
    name: str | None = None
    folders: list[Folder] | None = None
    trelloBoardUrl: str | None = None
    runCommand: str | None = None
    devBranch: str | None = None


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


class ActivityBase(BaseModel):
    title: str
    prompt: str
    relatedProjectIds: list[str] = []
    startFromDevBranch: bool = True
    # "" pras atividades antigas (criadas antes desse campo existir) — o
    # backend cai pro nome automático task/<id> nesse caso. Atividades
    # novas são obrigadas a informar (ver ActivityCreate).
    branchName: str = ""


class ActivityCreate(ActivityBase):
    branchName: str


class ActivityUpdate(BaseModel):
    title: str | None = None
    prompt: str | None = None
    relatedProjectIds: list[str] | None = None
    startFromDevBranch: bool | None = None
    branchName: str | None = None


class Activity(ActivityBase):
    id: str
    projectId: str
    started: bool = False
