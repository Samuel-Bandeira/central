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
    prodBranch: str | None = None


class ProjectCreate(ProjectBase):
    pass


class ProjectUpdate(BaseModel):
    name: str | None = None
    folders: list[Folder] | None = None
    trelloBoardUrl: str | None = None
    runCommand: str | None = None
    devBranch: str | None = None
    prodBranch: str | None = None


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
    # Obrigatório só quando startFromDevBranch=true (validado na rota, não
    # aqui — Pydantic não faz "obrigatório condicional" direito). Quando
    # startFromDevBranch=false, a atividade continua na branch que já
    # estiver ativa — sem nome nenhum escolhido, o próprio backend guarda
    # aqui qual era ao dar o primeiro "Iniciar", pra retomar depois.
    branchName: str = ""


class ActivityCreate(ActivityBase):
    pass


class ActivityUpdate(BaseModel):
    title: str | None = None
    prompt: str | None = None
    relatedProjectIds: list[str] | None = None
    startFromDevBranch: bool | None = None
    branchName: str | None = None


class ActivityStepTitle(BaseModel):
    title: str


class Activity(ActivityBase):
    id: str
    projectId: str
    started: bool = False
    concluded: bool = False
    mrUrl: str | None = None
    # projectId (de relatedProjectIds) -> URL do MR aberto nesse repo
    # relacionado, quando a atividade também teve commits lá.
    relatedMrUrls: dict[str, str] = {}
