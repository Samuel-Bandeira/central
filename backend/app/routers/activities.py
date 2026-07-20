import json
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import attachments as attachments_store
from .. import claude_terminal, git_utils, gitlab_client
from ..schemas import Activity, ActivityAttachmentPath, ActivityCreate, ActivityStepTitle, ActivityUpdate
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

ACCEPTANCE_CRITERIA_INSTRUCTION = (
    "Estes são os critérios de aceite fixados para esta atividade — o \"pronto\" "
    "real dela, definido antes de você começar. São diferentes do seu checklist "
    "de passos (que é o seu plano de execução, livre pra ajustar): os critérios "
    "abaixo não mudam sem eu concordar, e só eu marco cada um como atendido, "
    "fora deste terminal — não escreva o status deles em nenhum arquivo. "
    "Trabalhe até deixar todos satisfeitos, e ao final aponte explicitamente "
    "como cada um foi endereçado:\n{criteria}"
)

def _progress_file_name(activity_id: str) -> str:
    # Nomeado por atividade, não só por projeto — duas atividades podem
    # rodar na mesma branch/pasta em momentos diferentes (ex: reaproveitar
    # uma branch antiga), e sem esse sufixo o checklist e o STATUS.md de
    # uma vazavam pra dentro da outra (bug real reportado pelo usuário,
    # 2026-07-20: uma atividade nova nasceu já mostrando os passos
    # concluídos de uma atividade anterior que tinha usado a mesma branch).
    return f".claude-activity-status-{activity_id}.json"


def _progress_instruction(activity_id: str) -> str:
    file_name = _progress_file_name(activity_id)
    return (
        f"Ao longo desta atividade, mantenha um arquivo {file_name} na raiz "
        'deste projeto (não do projeto relacionado) no formato {"steps": '
        '[{"title": "...", "status": "pending|in_progress|done"}]}, listando os '
        "passos do seu plano. Atualize esse arquivo sempre que definir/ajustar o "
        "plano e sempre que iniciar ou concluir um passo — é assim que um painel "
        "fora deste terminal acompanha seu progresso. Toda vez que atualizar esse "
        "arquivo, atualize também o STATUS.md no mesmo momento (não só ao pausar) "
        "com um resumo do que já foi feito/decidido até ali — assim ele nunca "
        "fica desatualizado em relação ao progresso real. Alguns steps desse "
        'arquivo podem vir com "source": "user" — foram adicionados manualmente '
        "por mim fora deste terminal (pedidos extras depois de eu revisar o "
        "resultado). Nunca remova esses steps nem apague o campo \"source\" "
        "deles — só atualize o status conforme for resolvendo. Os demais steps "
        "(sem esse campo) são seus, gerencie livremente. Esse nome de arquivo é "
        "específico desta atividade — não reaproveite um arquivo "
        ".claude-activity-status-*.json que encontrar sobrando de outra "
        "atividade, mesmo que pareça relacionado. Se ainda não estiver no "
        ".gitignore do projeto, adicione a linha .claude-activity-status-*.json "
        "lá (cobre qualquer atividade, não só esta)."
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


def _read_progress(folder: str, activity_id: str) -> list[dict]:
    """Lê o arquivo de progresso específico desta atividade (via
    `_progress_instruction`). Tolera o arquivo não existir ainda ou estar
    no meio de uma escrita do Claude — nesses casos volta lista vazia em
    vez de erro."""
    path = Path(folder) / _progress_file_name(activity_id)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return []
    steps = data.get("steps", [])
    return steps if isinstance(steps, list) else []


def _write_progress(folder: str, activity_id: str, steps: list[dict]) -> None:
    write_json_atomic(Path(folder) / _progress_file_name(activity_id), {"steps": steps})


def _checkout_safely(folder: str, branch: str) -> None:
    """Troca pra `branch`, recusando a troca (400) se a pasta estiver numa
    branch diferente com mudança não commitada — mesma trava de segurança
    usada ao retomar uma atividade."""
    current = git_utils.current_branch(folder)
    if current != branch and not git_utils.is_clean(folder):
        raise HTTPException(
            status_code=400,
            detail="A árvore do projeto tem mudanças não commitadas — commite ou descarte antes de trocar de atividade.",
        )
    git_utils.checkout(folder, branch)


@router.get("/projects/{project_id}/activities", response_model=list[Activity])
def list_activities(project_id: str) -> list[dict]:
    return [a for a in _load() if a["projectId"] == project_id]


@router.post("/projects/{project_id}/activities", response_model=Activity, status_code=201)
def create_activity(project_id: str, payload: ActivityCreate) -> dict:
    _project_folder(project_id)  # 404 se o projeto não existir
    if payload.startFromDevBranch and not payload.branchName.strip():
        raise HTTPException(
            status_code=400,
            detail="Nome da branch é obrigatório quando a atividade parte da branch de desenvolvimento.",
        )
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
    if activity.get("startFromDevBranch") and not activity.get("branchName", "").strip():
        raise HTTPException(
            status_code=400,
            detail="Nome da branch é obrigatório quando a atividade parte da branch de desenvolvimento.",
        )
    _save(activities)
    return activity


@router.delete("/activities/{activity_id}", status_code=204)
def delete_activity(activity_id: str) -> None:
    activities = _load()
    remaining = [a for a in activities if a["id"] != activity_id]
    if len(remaining) == len(activities):
        raise HTTPException(status_code=404, detail="Atividade não encontrada")
    _save(remaining)


async def _save_uploaded_images(scope: str, files: list[UploadFile]) -> list[str]:
    """Valida (só imagem) e salva cada upload, devolvendo os caminhos
    absolutos salvos — compartilhado entre o anexo do prompt e o anexo de
    subtask, que só diferem no `scope` (subpasta) usado."""
    saved: list[str] = []
    for file in files:
        if file.content_type not in attachments_store.ALLOWED_CONTENT_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"'{file.filename}' não é uma imagem suportada (png, jpeg, gif ou webp).",
            )
        content = await file.read()
        saved.append(attachments_store.save_image(scope, file.filename or "imagem", content))
    return saved


@router.get("/attachments/file")
def serve_attachment(path: str) -> FileResponse:
    """Serve a imagem salva pra pré-visualização no frontend — o Claude lê
    o arquivo direto do disco, isso aqui é só pra UI mostrar a miniatura.
    Recusa qualquer caminho fora de ATTACHMENTS_DIR (evita virar leitor de
    arquivo arbitrário do disco)."""
    if not attachments_store.is_within_attachments_dir(path):
        raise HTTPException(status_code=404, detail="Anexo não encontrado")
    file_path = Path(path)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Anexo não encontrado")
    return FileResponse(file_path)


@router.post("/activities/{activity_id}/attachments")
async def upload_activity_attachments(activity_id: str, files: list[UploadFile] = File(...)) -> dict:
    activities = _load()
    activity = _find(activities, activity_id)
    saved = await _save_uploaded_images(activity_id, files)
    activity.setdefault("attachments", [])
    activity["attachments"].extend(saved)
    _save(activities)
    return {"attachments": activity["attachments"]}


@router.delete("/activities/{activity_id}/attachments")
def delete_activity_attachment(activity_id: str, payload: ActivityAttachmentPath) -> dict:
    activities = _load()
    activity = _find(activities, activity_id)
    current = activity.get("attachments", [])
    remaining = [p for p in current if p != payload.path]
    if len(remaining) == len(current):
        raise HTTPException(status_code=404, detail="Anexo não encontrado nessa atividade")
    attachments_store.delete_image(payload.path)
    activity["attachments"] = remaining
    _save(activities)
    return {"attachments": remaining}


@router.get("/running-activities")
def running_activities() -> dict:
    activities = _load()
    _check_pausing_activities(activities)
    ids = claude_terminal.list_open_activity_ids([a["id"] for a in activities])
    # Só checa as que já sabemos que têm janela aberta — sem isso seria
    # mais uma leitura de AppleScript por atividade fechada, à toa.
    needs_attention_ids = [aid for aid in ids if claude_terminal.is_waiting_for_input(aid)]
    return {"activityIds": ids, "needsAttentionIds": needs_attention_ids}


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
    is_first_start = not activity["started"]
    # Decidido na criação da atividade (não perguntado de novo aqui) —
    # `startFromDevBranch` default true: começa do zero a partir da branch
    # de desenvolvimento configurada, em vez de exigir escolher toda vez.
    from_dev_branch = activity.get("startFromDevBranch", True)

    try:
        if is_first_start:
            if from_dev_branch:
                # Começar do zero a partir da branch de desenvolvimento
                # configurada, já atualizada, numa branch com o nome
                # escolhido na criação — só faz sentido na primeira vez (a
                # branch da atividade, uma vez criada, já tem sua própria
                # base; puxar de novo depois bagunçaria o histórico dela).
                if not git_utils.is_clean(folder):
                    raise HTTPException(
                        status_code=400,
                        detail=f"A árvore do projeto tem mudanças não commitadas — commite ou descarte antes de trocar pra {dev_branch}.",
                    )
                git_utils.checkout(folder, dev_branch)
                git_utils.pull(folder)
                branch = activity["branchName"]
                if branch in git_utils.list_branches(folder):
                    raise HTTPException(
                        status_code=400,
                        detail=f"Já existe uma branch chamada '{branch}' — escolha outro nome pra essa atividade (aba Editar).",
                    )
                git_utils.checkout(folder, branch)
            else:
                # Continua na branch que já estava ativa — não cria/troca
                # nada. Guarda qual era, pra "Continuar" no futuro voltar
                # pro lugar certo mesmo se outra atividade tiver trocado de
                # branch nesse meio tempo.
                branch = git_utils.current_branch(folder)
                activity["branchName"] = branch
        else:
            # Retomando: sempre volta pra branch decidida (criada ou
            # detectada) na primeira vez.
            branch = activity.get("branchName") or _branch_name(activity_id)
            _checkout_safely(folder, branch)
    except git_utils.GitError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    all_projects = _load_projects()
    related_folders: list[str] = []
    related_notes: list[str] = []
    # Decidido na criação (mesmo default true de `startFromDevBranch`) —
    # true: cada projeto relacionado parte limpo da própria dev branch,
    # atualizada, numa branch nova com o mesmo nome da atividade. false:
    # o Claude trabalha em cima do que já estiver checked out lá, sem
    # mexer em nada. Só é decidido de verdade na primeira vez; retomadas
    # sempre voltam pra branch já escolhida então (`relatedBranchNames`),
    # mesmo que o projeto tenha trocado de branch nesse meio tempo por
    # outro motivo — sem isso, "Concluir atividade" não teria como saber
    # onde procurar o trabalho desse projeto.
    related_start_from_dev = activity.get("relatedStartFromDevBranch", True)
    related_branch_names: dict[str, str] = dict(activity.get("relatedBranchNames", {}))
    for related_id in activity.get("relatedProjectIds", []):
        related_project = _find_project(all_projects, related_id)
        if related_project is None or not related_project["folders"]:
            continue
        related_path = related_project["folders"][0]["path"]
        related_folders.append(related_path)
        related_notes.append(f"- {related_project['name']}: {related_path}")

        if is_first_start:
            try:
                if related_start_from_dev:
                    related_dev_branch = related_project.get("devBranch")
                    # Só puxa a dev branch se a árvore estiver limpa —
                    # melhor esforço, não vale travar o início da
                    # atividade principal por causa de um projeto
                    # relacionado sujo.
                    if related_dev_branch and git_utils.is_clean(related_path):
                        git_utils.checkout(related_path, related_dev_branch)
                        git_utils.pull(related_path)
                    git_utils.checkout(related_path, branch)
                    related_branch_names[related_id] = branch
                else:
                    related_branch_names[related_id] = git_utils.current_branch(related_path)
            except git_utils.GitError:
                pass
        else:
            target = related_branch_names.get(related_id)
            if target:
                try:
                    git_utils.checkout(related_path, target)
                except git_utils.GitError:
                    pass
    activity["relatedBranchNames"] = related_branch_names

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
    # Imagens anexadas ao prompt (upload via POST /activities/{id}/attachments)
    # — o Claude não recebe binário no prompt, só o caminho de cada arquivo,
    # que ele lê sozinho com a própria ferramenta de leitura.
    attachment_paths = activity.get("attachments", [])
    if attachment_paths:
        attachment_list = "\n".join(f"- {p}" for p in attachment_paths)
        prompt = (
            "Imagens anexadas a esta atividade — leia cada uma (com sua ferramenta de "
            f"leitura de arquivo) antes de começar:\n{attachment_list}\n\n{prompt}"
        )
    # Só os ainda não confirmados — um critério marcado `met` foi decisão
    # minha (fora deste terminal), não precisa voltar a ocupar espaço no
    # prompt toda vez que a atividade é retomada.
    pending_criteria = [c for c in activity.get("acceptanceCriteria", []) if not c.get("met")]
    if pending_criteria:
        criteria_list = "\n".join(f"- {c['text']}" for c in pending_criteria)
        prompt = f"{ACCEPTANCE_CRITERIA_INSTRUCTION.format(criteria=criteria_list)}\n\n{prompt}"
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

    # "Continuar" não pode depender do Claude adivinhar que apareceu um
    # pedido novo — se o usuário adicionou steps manuais (ou sobrou algo
    # não concluído da última vez), avisamos explicitamente aqui em vez de
    # só confiar no checklist ficar lá silenciosamente esperando ser lido.
    if not is_first_start:
        pending_steps = [s for s in _read_progress(folder, activity_id) if s.get("status") != "done"]
        if pending_steps:
            def _step_note(s: dict) -> str:
                note = f"- {s.get('title', '(sem título)')} (status atual: {s.get('status', 'pending')})"
                step_attachments = s.get("attachments", [])
                if step_attachments:
                    images = ", ".join(step_attachments)
                    note += f"\n  Imagens anexadas a este passo (leia antes de resolvê-lo): {images}"
                return note

            pending_notes = "\n".join(_step_note(s) for s in pending_steps)
            prompt = (
                "Antes de mais nada, resolva os passos ainda pendentes do checklist desta "
                "atividade (alguns podem ter sido adicionados manualmente por mim depois da "
                f"última vez que você rodou):\n{pending_notes}\n\n{prompt}"
            )

    prompt = f"{_progress_instruction(activity_id)}\n\n{prompt}"

    claude_terminal.open_claude_window(activity_id, folder, prompt, related_folders)

    if not resuming:
        activity["started"] = True
        _save(activities)

    return {"branch": branch, "resuming": resuming}


@router.get("/activities/{activity_id}/progress")
def get_activity_progress(activity_id: str) -> dict:
    """Lê o arquivo de progresso que a própria atividade mantém (via
    `_progress_instruction`). Não é um endpoint do Claude Code — é só o app
    lendo um arquivo simples que pedimos pro Claude escrever, já que o CLI
    não expõe API/hook nenhum pra acompanhar o plano/passos de fora."""
    activities = _load()
    activity = _find(activities, activity_id)
    folder = _project_folder(activity["projectId"])
    return {"steps": _read_progress(folder, activity_id)}


@router.post("/activities/{activity_id}/steps")
async def add_activity_step(
    activity_id: str, title: str = Form(...), files: list[UploadFile] = File(default=[])
) -> dict:
    """Adiciona um passo manual ao checklist de progresso da atividade —
    marcado com `source: "user"` pra distinguir dos passos que o próprio
    Claude gerencia (ver `_progress_instruction`: ele é instruído a nunca
    remover steps com essa marca). Aceita imagens junto (multipart, não
    JSON) — salvas numa subpasta própria do step dentro do escopo da
    atividade, reinjetadas no prompt em `start_activity` quando o passo
    ainda estiver pendente."""
    activities = _load()
    activity = _find(activities, activity_id)
    folder = _project_folder(activity["projectId"])
    title = title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Título do passo não pode ser vazio.")
    steps = _read_progress(folder, activity_id)
    step: dict = {"title": title, "status": "pending", "source": "user"}
    if files:
        step["attachments"] = await _save_uploaded_images(f"{activity_id}/steps", files)
    steps.append(step)
    _write_progress(folder, activity_id, steps)
    return {"steps": steps}


@router.delete("/activities/{activity_id}/steps")
def delete_activity_step(activity_id: str, payload: ActivityStepTitle) -> dict:
    """Remove um passo do checklist — só permite excluir os que foram
    adicionados manualmente (`source: "user"`); os que o Claude criou como
    parte do próprio plano não podem ser apagados por aqui."""
    activities = _load()
    activity = _find(activities, activity_id)
    folder = _project_folder(activity["projectId"])
    steps = _read_progress(folder, activity_id)
    for i, step in enumerate(steps):
        if step.get("title") == payload.title and step.get("source") == "user":
            for attachment_path in step.get("attachments", []):
                attachments_store.delete_image(attachment_path)
            del steps[i]
            _write_progress(folder, activity_id, steps)
            return {"steps": steps}
    raise HTTPException(
        status_code=404,
        detail="Esse passo não existe ou não foi criado manualmente — só dá pra excluir os que você mesmo adicionou.",
    )


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


@router.post("/activities/{activity_id}/conclude")
def conclude_activity(activity_id: str) -> dict:
    """Abre (ou reaproveita) um MR no GitLab da branch da atividade pra
    branch de desenvolvimento do projeto, e faz o mesmo em cada projeto
    relacionado (`relatedProjectIds`) que tiver recebido commits nessa
    mesma branch — assim uma atividade que mexeu em back e front, por
    exemplo, sai com um MR em cada repo alterado, não só no principal.
    Também fecha o terminal do Claude e marca a atividade como concluída.
    Não trava a atividade — dá pra continuar trabalhando na mesma branch
    depois e concluir de novo (idempotente: acha o MR já aberto em vez de
    duplicar)."""
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
            detail="Configure a branch de desenvolvimento do projeto (em Detalhar → Editar) antes de concluir atividades.",
        )
    folder = project["folders"][0]["path"]

    steps = _read_progress(folder, activity_id)
    if not steps or any(step.get("status") != "done" for step in steps):
        raise HTTPException(status_code=400, detail="Ainda há passos pendentes no checklist da atividade.")

    criteria = activity.get("acceptanceCriteria", [])
    if criteria and any(not c.get("met") for c in criteria):
        raise HTTPException(status_code=400, detail="Ainda há critérios de aceite não confirmados por você.")

    branch = activity.get("branchName")
    if not branch:
        raise HTTPException(
            status_code=400, detail="Essa atividade ainda não tem uma branch associada — inicie-a antes."
        )
    if branch == dev_branch:
        raise HTTPException(
            status_code=400,
            detail="Essa atividade está na própria branch de desenvolvimento — não há o que abrir de MR.",
        )

    try:
        _checkout_safely(folder, branch)
        if not git_utils.is_clean(folder):
            raise HTTPException(
                status_code=400,
                detail="Há mudanças não commitadas — peça pro Claude commitar (Pausar) antes de concluir.",
            )
        git_utils.push(folder, branch)
    except git_utils.GitError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        project_path = gitlab_client.project_path_from_remote(folder)
    except gitlab_client.GitlabError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        mr = gitlab_client.find_open_mr(project_path, branch)
        created = False
        if mr is None:
            mr = gitlab_client.create_mr(project_path, branch, dev_branch, activity["title"], activity["prompt"])
            created = True
    except gitlab_client.GitlabError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    related_mrs, warnings = _conclude_related_projects(activity, branch)

    terminal_closed = claude_terminal.close_window(activity_id)

    activity["concluded"] = True
    activity["mrUrl"] = mr["web_url"]
    activity["relatedMrUrls"] = {m["projectId"]: m["mrUrl"] for m in related_mrs}
    _save(activities)

    return {
        "mrUrl": mr["web_url"],
        "created": created,
        "terminalClosed": terminal_closed,
        "relatedMrs": related_mrs,
        "warnings": warnings,
    }


def _conclude_related_projects(activity: dict, branch: str) -> tuple[list[dict], list[str]]:
    """Pra cada projeto relacionado (`relatedProjectIds`) que ficou numa
    branch própria (ver `start_activity`) com commits novos em relação à
    branch de dev dele, empurra e abre (ou reaproveita) um MR — igual ao
    fluxo do projeto principal, só que melhor esforço: problema num repo
    relacionado vira aviso, não impede concluir a atividade no projeto
    principal."""
    related_mrs: list[dict] = []
    warnings: list[str] = []
    all_projects = _load_projects()
    related_branch_names: dict[str, str] = activity.get("relatedBranchNames", {})

    for related_id in activity.get("relatedProjectIds", []):
        related_project = _find_project(all_projects, related_id)
        if related_project is None or not related_project["folders"]:
            continue
        name = related_project["name"]
        related_folder = related_project["folders"][0]["path"]
        related_dev_branch = related_project.get("devBranch")
        if not related_dev_branch:
            warnings.append(
                f"{name}: sem branch de desenvolvimento configurada — não dá pra saber o alvo do MR, "
                "nada foi aberto aqui. Configure em Detalhar → Editar."
            )
            continue

        # Branch em que esse projeto trabalhou nesta atividade, decidida em
        # `start_activity` (guardada em `relatedBranchNames`). Atividades
        # criadas antes desse campo existir caem no fallback: assume que
        # foi a mesma branch da atividade principal (comportamento antigo).
        expected_branch = related_branch_names.get(related_id, branch)

        try:
            related_current = git_utils.current_branch(related_folder)
        except git_utils.GitError:
            warnings.append(f"{name}: não é um repositório git válido — nada foi aberto aqui.")
            continue
        if related_current == related_dev_branch:
            continue  # o Claude não chegou a trabalhar nessa pasta nesta atividade
        if related_current != expected_branch:
            warnings.append(
                f"{name}: está na branch '{related_current}', mas o esperado pra essa atividade era "
                f"'{expected_branch}' — nada foi aberto aqui. Confira manualmente se há trabalho pra abrir MR."
            )
            continue

        if not git_utils.is_clean(related_folder):
            warnings.append(f"{name}: há mudanças não commitadas — MR não foi aberto aqui.")
            continue

        git_utils.fetch(related_folder)
        ahead = 0
        for ref in (related_dev_branch, f"origin/{related_dev_branch}"):
            if not git_utils.ref_exists(related_folder, ref):
                continue
            try:
                ahead = git_utils.commits_ahead(related_folder, ref)
                break
            except git_utils.GitError:
                continue
        if ahead == 0:
            continue  # branch existe mas não tem commit novo — nada a abrir

        try:
            git_utils.push(related_folder, expected_branch)
            related_project_path = gitlab_client.project_path_from_remote(related_folder)
            related_mr = gitlab_client.find_open_mr(related_project_path, expected_branch)
            related_created = False
            if related_mr is None:
                related_mr = gitlab_client.create_mr(
                    related_project_path, expected_branch, related_dev_branch, activity["title"], activity["prompt"]
                )
                related_created = True
        except (git_utils.GitError, gitlab_client.GitlabError) as exc:
            warnings.append(f"{name}: {exc}")
            continue

        related_mrs.append(
            {
                "projectId": related_id,
                "projectName": name,
                "mrUrl": related_mr["web_url"],
                "created": related_created,
            }
        )

    return related_mrs, warnings
