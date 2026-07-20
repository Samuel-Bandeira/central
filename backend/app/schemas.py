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


class AcceptanceCriterion(BaseModel):
    text: str
    # Só o humano marca (via PUT /activities/{id}) — o Claude é instruído a
    # nunca mexer nesse campo, é isso que separa "critério de aceite" (a
    # definição de pronto, fixada antes de começar) de "step" (o plano de
    # execução, que o próprio Claude gerencia livremente).
    met: bool = False


class ActivityBase(BaseModel):
    title: str
    prompt: str
    acceptanceCriteria: list[AcceptanceCriterion] = []
    relatedProjectIds: list[str] = []
    startFromDevBranch: bool = True
    # Obrigatório só quando startFromDevBranch=true (validado na rota, não
    # aqui — Pydantic não faz "obrigatório condicional" direito). Quando
    # startFromDevBranch=false, a atividade continua na branch que já
    # estiver ativa — sem nome nenhum escolhido, o próprio backend guarda
    # aqui qual era ao dar o primeiro "Iniciar", pra retomar depois.
    branchName: str = ""
    # Mesma decisão que `startFromDevBranch`, só que aplicada aos projetos
    # de `relatedProjectIds`: true parte cada um limpo da própria dev
    # branch (com pull) numa branch nova de mesmo nome; false deixa cada
    # um exatamente na branch em que já estiver, sem mexer em nada.
    relatedStartFromDevBranch: bool = True


class ActivityCreate(ActivityBase):
    pass


class ActivityUpdate(BaseModel):
    title: str | None = None
    prompt: str | None = None
    acceptanceCriteria: list[AcceptanceCriterion] | None = None
    relatedProjectIds: list[str] | None = None
    startFromDevBranch: bool | None = None
    branchName: str | None = None
    relatedStartFromDevBranch: bool | None = None


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
    # projectId (de relatedProjectIds) -> nome da branch que esse projeto
    # usou nesta atividade, decidido uma vez em `start_activity` (ver
    # `relatedStartFromDevBranch`) — é o que "Concluir atividade" usa pra
    # saber onde procurar o trabalho de cada projeto relacionado.
    relatedBranchNames: dict[str, str] = {}
