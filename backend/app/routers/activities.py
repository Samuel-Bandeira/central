import json
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException

from .. import claude_terminal, git_utils
from ..schemas import Activity, ActivityCreate, ActivityUpdate
from ..storage import read_json, write_json_atomic
from .projects import _load as _load_projects

router = APIRouter(tags=["activities"])

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "activities.json"

CONFIRMATION_INSTRUCTION = (
    "Antes de mexer no código, explique com suas próprias palavras o que você "
    "entendeu que precisa ser feito nesta atividade. Se tiver qualquer dúvida "
    "sobre o escopo, os arquivos envolvidos ou a abordagem, pergunte antes de "
    "prosseguir — só comece a implementar depois que eu confirmar que o "
    "entendimento está certo."
)

PROGRESS_FILE_NAME = ".claude-activity-status.json"

PROGRESS_INSTRUCTION = (
    f"Ao longo desta atividade, mantenha um arquivo {PROGRESS_FILE_NAME} na raiz "
    'deste projeto (não do projeto relacionado) no formato {"steps": '
    '[{"title": "...", "status": "pending|in_progress|done"}]}, listando os '
    "passos do seu plano. Atualize esse arquivo sempre que definir/ajustar o "
    "plano e sempre que iniciar ou concluir um passo — é assim que um painel "
    "fora deste terminal acompanha seu progresso. Se o arquivo ainda não "
    "estiver no .gitignore do projeto, adicione uma linha pra ele lá."
)


def _load() -> list[dict]:
    return read_json(DATA_PATH, [])


def _save(activities: list[dict]) -> None:
    write_json_atomic(DATA_PATH, activities)


def _find(activities: list[dict], activity_id: str) -> dict:
    for activity in activities:
        if activity["id"] == activity_id:
            return activity
    raise HTTPException(status_code=404, detail="Atividade não encontrada")


def _branch_name(activity_id: str) -> str:
    return f"task/{activity_id}"


def _find_project(projects: list[dict], project_id: str) -> dict | None:
    return next((p for p in projects if p["id"] == project_id), None)


def _project_folder(project_id: str) -> str:
    project = _find_project(_load_projects(), project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Projeto não encontrado")
    if not project["folders"]:
        raise HTTPException(status_code=400, detail="Projeto sem pasta cadastrada")
    return project["folders"][0]["path"]


@router.get("/projects/{project_id}/activities", response_model=list[Activity])
def list_activities(project_id: str) -> list[dict]:
    return [a for a in _load() if a["projectId"] == project_id]


@router.post("/projects/{project_id}/activities", response_model=Activity, status_code=201)
def create_activity(project_id: str, payload: ActivityCreate) -> dict:
    _project_folder(project_id)  # 404 se o projeto não existir
    activities = _load()
    activity = payload.model_dump()
    activity["id"] = f"act-{uuid.uuid4().hex[:8]}"
    activity["projectId"] = project_id
    activity["started"] = False
    activities.append(activity)
    _save(activities)
    return activity


@router.put("/activities/{activity_id}", response_model=Activity)
def update_activity(activity_id: str, payload: ActivityUpdate) -> dict:
    activities = _load()
    activity = _find(activities, activity_id)
    activity.update(payload.model_dump(exclude_unset=True))
    _save(activities)
    return activity


@router.delete("/activities/{activity_id}", status_code=204)
def delete_activity(activity_id: str) -> None:
    activities = _load()
    remaining = [a for a in activities if a["id"] != activity_id]
    if len(remaining) == len(activities):
        raise HTTPException(status_code=404, detail="Atividade não encontrada")
    _save(remaining)


@router.get("/running-activities")
def running_activities() -> dict:
    activities = _load()
    _check_pausing_activities(activities)
    ids = claude_terminal.list_open_activity_ids([a["id"] for a in activities])
    return {"activityIds": ids}


def _check_pausing_activities(activities: list[dict]) -> None:
    """Roda a cada poll de /running-activities (a cada poucos segundos, já
    que o frontend já consulta esse endpoint com frequência). Pra cada
    atividade marcada como "esperando o wrap-up" (`pausingSinceCommit`),
    confere se já apareceu um commit novo na branch — só então fecha a
    janela de verdade. Fechar só depois de ver o commit é o que evita
    cortar o Claude no meio do trabalho (fechar às cegas logo depois de
    mandar o pedido foi o bug anterior)."""
    changed = False
    for activity in activities:
        pausing_commit = activity.get("pausingSinceCommit")
        if not pausing_commit:
            continue
        try:
            folder = _project_folder(activity["projectId"])
            new_commit = git_utils.current_commit(folder)
        except (HTTPException, git_utils.GitError):
            continue
        window_still_open = claude_terminal.list_open_activity_ids([activity["id"]])
        if not window_still_open:
            # já fechou (manual ou outro motivo) — nada mais pra esperar
            activity["pausingSinceCommit"] = None
            changed = True
        elif new_commit != pausing_commit:
            # só limpa o flag se o fechamento realmente aconteceu agora —
            # senão continua tentando nos próximos polls
            if claude_terminal.close_window(activity["id"]):
                activity["pausingSinceCommit"] = None
            changed = True
    if changed:
        _save(activities)


@router.post("/activities/{activity_id}/start")
def start_activity(activity_id: str) -> dict:
    activities = _load()
    activity = _find(activities, activity_id)
    project = _find_project(_load_projects(), activity["projectId"])
    if project is None:
        raise HTTPException(status_code=404, detail="Projeto não encontrado")
    if not project["folders"]:
        raise HTTPException(status_code=400, detail="Projeto sem pasta cadastrada")
    dev_branch = project.get("devBranch")
    if not dev_branch:
        raise HTTPException(
            status_code=400,
            detail="Configure a branch de desenvolvimento do projeto (em Detalhar → Editar) antes de iniciar atividades.",
        )
    folder = project["folders"][0]["path"]
    # Nome escolhido na criação da atividade — cai pro automático task/<id>
    # só pras atividades antigas (criadas antes desse campo existir).
    branch = activity.get("branchName") or _branch_name(activity_id)
    is_first_start = not activity["started"]
    # Decidido na criação da atividade (não perguntado de novo aqui) —
    # `startFromDevBranch` default true: começa do zero a partir da branch
    # de desenvolvimento configurada, em vez de exigir escolher toda vez.
    from_dev_branch = activity.get("startFromDevBranch", True)

    try:
        if is_first_start and from_dev_branch:
            # Começar do zero a partir da branch de desenvolvimento
            # configurada, já atualizada — só faz sentido na primeira vez
            # (a branch da atividade, uma vez criada, já tem sua própria
            # base; puxar de novo depois bagunçaria o histórico dela).
            if not git_utils.is_clean(folder):
                raise HTTPException(
                    status_code=400,
                    detail=f"A árvore do projeto tem mudanças não commitadas — commite ou descarte antes de trocar pra {dev_branch}.",
                )
            git_utils.checkout(folder, dev_branch)
            git_utils.pull(folder)
            if branch in git_utils.list_branches(folder):
                raise HTTPException(
                    status_code=400,
                    detail=f"Já existe uma branch chamada '{branch}' — escolha outro nome pra essa atividade (aba Editar).",
                )

        current = git_utils.current_branch(folder)
        if current != branch and not git_utils.is_clean(folder):
            raise HTTPException(
                status_code=400,
                detail="A árvore do projeto tem mudanças não commitadas — commite ou descarte antes de trocar de atividade.",
            )
        git_utils.checkout(folder, branch)
    except git_utils.GitError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    all_projects = _load_projects()
    related_folders: list[str] = []
    related_notes: list[str] = []
    for related_id in activity.get("relatedProjectIds", []):
        related_project = _find_project(all_projects, related_id)
        if related_project is None or not related_project["folders"]:
            continue
        related_path = related_project["folders"][0]["path"]
        related_folders.append(related_path)
        related_notes.append(f"- {related_project['name']}: {related_path}")

    # "resuming" só quer dizer "essa atividade já foi iniciada antes" — não
    # garante que exista memória de verdade pra retomar. Cada abertura do
    # Claude é uma conversa nova (não usamos --continue/--resume); o único
    # fio de continuidade é o STATUS.md que a própria atividade deveria ter
    # deixado ao pausar. Se ele nunca existiu (ex: pausa anterior falhou
    # antes do Claude conseguir salvar), não tem o que "retomar" de
    # verdade — melhor pedir o entendimento nesse caso, e nem tratar como
    # resuming (`activity["started"]` fica true independente disso, mas
    # os campos abaixo refletem a situação real do STATUS.md).
    resuming = activity["started"] and (Path(folder) / "STATUS.md").exists()
    prompt = activity["prompt"]
    if related_notes:
        prompt = (
            "Esta atividade também envolve mudanças em outros projetos:\n"
            + "\n".join(related_notes)
            + f"\n\n{prompt}"
        )
    if resuming:
        prompt = f"Retomando atividade. Leia o STATUS.md antes de continuar.\n\n{prompt}"
    else:
        prompt = f"{CONFIRMATION_INSTRUCTION}\n\n{prompt}"
    prompt = f"{PROGRESS_INSTRUCTION}\n\n{prompt}"

    claude_terminal.open_claude_window(activity_id, folder, prompt, related_folders)

    if not resuming:
        activity["started"] = True
        _save(activities)

    return {"branch": branch, "resuming": resuming}


@router.get("/activities/{activity_id}/progress")
def get_activity_progress(activity_id: str) -> dict:
    """Lê o arquivo de progresso que a própria atividade mantém (via
    PROGRESS_INSTRUCTION). Não é um endpoint do Claude Code — é só o app
    lendo um arquivo simples que pedimos pro Claude escrever, já que o CLI
    não expõe API/hook nenhum pra acompanhar o plano/passos de fora."""
    activities = _load()
    activity = _find(activities, activity_id)
    folder = _project_folder(activity["projectId"])
    path = Path(folder) / PROGRESS_FILE_NAME
    if not path.exists():
        return {"steps": []}
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        # Pode estar no meio de uma escrita do próprio Claude — ignora e
        # tenta de novo no próximo poll, não é um erro real.
        return {"steps": []}
    steps = data.get("steps", [])
    if not isinstance(steps, list):
        return {"steps": []}
    return {"steps": steps}


@router.post("/activities/{activity_id}/pause")
def pause_activity(activity_id: str) -> dict:
    activities = _load()
    activity = _find(activities, activity_id)
    sent = claude_terminal.send_pause_instruction(activity_id)
    if sent:
        # Marca o commit atual como "linha de base" — quando um commit
        # novo aparecer nessa branch, `_check_pausing_activities` (chamado
        # a cada poll de /running-activities) fecha a janela de verdade.
        try:
            folder = _project_folder(activity["projectId"])
            activity["pausingSinceCommit"] = git_utils.current_commit(folder)
            _save(activities)
        except git_utils.GitError:
            pass  # sem baseline, a janela só fica aberta esperando fechamento manual
    return {"sent": sent}
