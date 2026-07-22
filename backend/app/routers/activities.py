import json
import threading
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

# Protege o ciclo lê-modifica-escreve do arquivo de progresso de cada
# atividade (Aprovar/Liberar/+Subtask/excluir subtask) — essas rotas são
# `def` síncronas, e o FastAPI roda cada uma numa thread própria, então
# dois cliques quase simultâneos (ex: "Liberar" em dois blocos diferentes)
# corriam de verdade em paralelo: a segunda escrita, baseada numa leitura
# feita antes da primeira terminar de escrever, podia sobrescrever e
# apagar silenciosamente a mudança da primeira (lost update clássico).
# Lock único (não por atividade) porque é um app local de usuário só — o
# throughput não justifica a complexidade de um lock por arquivo.
_PROGRESS_LOCK = threading.Lock()

CONFIRMATION_INSTRUCTION = (
    "Antes de mexer no código, explique com suas próprias palavras o que você "
    "entendeu que precisa ser feito nesta atividade. Se tiver qualquer dúvida "
    "sobre o escopo, os arquivos envolvidos ou a abordagem, pergunte antes de "
    "prosseguir — só comece a implementar depois que eu confirmar que o "
    "entendimento está certo."
)

REVIEW_STEP_INSTRUCTION = (
    "Antes de marcar qualquer passo (ou bloco, no modo blocos) como \"done\", "
    "faça uma autorrevisão do que você acabou de implementar (releia o diff, "
    "confira se bate com o que foi pedido, procure por erros óbvios ou "
    "pontas soltas) e registre isso como um passo próprio no checklist (algo "
    "como \"Revisão do que foi implementado\"), só marcando esse passo de "
    "revisão como \"done\" depois de tê-la feito de verdade. Isso vale de "
    "novo sempre que eu adicionar subtasks depois que o checklist (ou o "
    "bloco) já estava todo concluído: ao terminar essas subtasks extras, "
    "adicione um novo passo de revisão cobrindo esse trabalho adicional e "
    "complete-o antes de considerar aquele checklist/bloco pronto outra vez."
)

SUMMARY_FIELD_INSTRUCTION = (
    "Mantenha também, nesse mesmo arquivo, um campo de nível superior "
    '"summary" (string, ao lado de "steps") com um resumo em prosa simples '
    "do que esta atividade é/faz e do que eu devo esperar ver funcionando "
    "na UI quando ela estiver pronta — escreva como se fosse pra alguém "
    "sem nenhum contexto, que não vai (e não deveria precisar) juntar os "
    "pedaços lendo cada passo do checklist um por um pra entender do que "
    "se trata. Escreva esse campo assim que tiver entendimento suficiente "
    "(logo depois de eu confirmar, ou logo depois de decompor uma spec "
    "grande em blocos) e atualize-o sempre que o entendimento mudar de "
    "forma relevante ao longo da conversa — não deixe desatualizado. A "
    "lista exata de arquivos criados/modificados eu já vejo por fora (via "
    "git diff), não precisa listar cada um — mas cite pelo nome as "
    "páginas/arquivos mais importantes que você criou e o motivo de cada "
    "um existir, é isso que costuma ficar obscuro depois que o trabalho "
    "vira uma dezena de passos/blocos miúdos."
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

def _status_file_name(activity_id: str) -> str:
    # Mesmo motivo do sufixo em _progress_file_name: sem ele, o STATUS.md de
    # uma atividade vaza pra dentro de outra que reaproveite a mesma pasta/
    # branch num momento diferente. Aplicado a todas as atividades (não só
    # as com spec), com fallback de leitura pro nome antigo em
    # _status_file_path — atividades já em andamento não perdem o histórico
    # já salvo.
    return f"STATUS-{activity_id}.md"


def _status_file_path(folder: str, activity_id: str) -> Path:
    new_path = Path(folder) / _status_file_name(activity_id)
    if new_path.exists():
        return new_path
    legacy_path = Path(folder) / "STATUS.md"
    return legacy_path if legacy_path.exists() else new_path


def _pause_instruction(activity_id: str) -> str:
    file_name = _status_file_name(activity_id)
    return (
        f"Pausando por aqui antes de fechar a janela. Antes de encerrar: atualize (ou "
        f"crie) o {file_name} com um resumo de tudo que já foi discutido e decidido "
        "nesta conversa até agora — incluindo perguntas que você fez e minhas "
        f"respostas — o que já foi feito e o que falta. O {file_name} é histórico de "
        "trabalho local, não deve ir pro repositório — se ele ainda não estiver no "
        f".gitignore do projeto, adicione uma linha pra ele lá (padrão STATUS-*.md, "
        "cobre qualquer atividade) antes de commitar. Depois, dê commit e push. Me "
        "avise por aqui quando terminar; eu fecho esta janela manualmente."
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
    status_name = _status_file_name(activity_id)
    return (
        f"Ao longo desta atividade, mantenha um arquivo {file_name} na raiz "
        'deste projeto (não do projeto relacionado) no formato {"steps": '
        '[{"title": "...", "status": "pending|in_progress|done"}]}, listando os '
        "passos do seu plano. Atualize esse arquivo sempre que definir/ajustar o "
        "plano e sempre que iniciar ou concluir um passo — é assim que um painel "
        f"fora deste terminal acompanha seu progresso. Toda vez que atualizar esse "
        f"arquivo, atualize também o {status_name} no mesmo momento (não só ao "
        "pausar) com um resumo do que já foi feito/decidido até ali — assim ele "
        "nunca fica desatualizado em relação ao progresso real. Alguns steps desse "
        'arquivo podem vir com "source": "user" — foram adicionados manualmente '
        "por mim fora deste terminal (pedidos extras depois de eu revisar o "
        "resultado). Nunca remova esses steps nem apague o campo \"source\" "
        "deles — só atualize o status conforme for resolvendo. Os demais steps "
        "(sem esse campo) são seus, gerencie livremente. Esse nome de arquivo é "
        "específico desta atividade — não reaproveite um arquivo "
        ".claude-activity-status-*.json que encontrar sobrando de outra "
        "atividade, mesmo que pareça relacionado. Se ainda não estiver no "
        ".gitignore do projeto, adicione as linhas .claude-activity-status-*.json "
        "e STATUS-*.md lá (cobrem qualquer atividade, não só esta). "
        f"{REVIEW_STEP_INSTRUCTION} {SUMMARY_FIELD_INSTRUCTION}"
    )


def _block_mode_instruction(activity_id: str, spec_file: str, is_first_start: bool, project_name: str) -> str:
    """Só injetada quando a atividade tem um .md de spec anexado (`specFile`)
    — pede pro Claude decompor esse arquivo em blocos maiores que um passo
    comum (ex: uma tela inteira), interligados por dependência, e travar o
    avanço em cada um até eu validar por fora. `validated` é um campo
    humano — mesmo espírito de AcceptanceCriterion.met (schemas.py): o
    Claude nunca escreve nele, só lê.

    A regra de trava (não avançar sem "validated": true) e a nota de escopo
    são repetidas em TODA chamada, não só na primeira — cada abertura do
    `claude` é uma conversa nova (sem --continue/--resume), então uma sessão
    retomada não teria como saber disso se só fosse dito uma vez lá atrás. Já
    o pedido de decompor a spec e escrever o plano inicial só faz sentido na
    primeira vez — numa retomada os blocos já existem no arquivo de
    progresso.

    Nota de escopo: diferente do fluxo normal (que usa @menção +
    relatedProjectIds pra liberar outros projetos de propósito), a "Task
    grande" não passa nenhum --add-dir — o Claude só tem acesso de arquivo a
    este projeto. Uma spec grande frequentemente descreve trabalho de mais
    de uma camada (ex: uma tela de front que depende de um endpoint de
    back); sem avisar isso explicitamente, o Claude pode tentar criar um
    bloco pra implementar a parte que ele fisicamente não consegue tocar."""
    file_name = _progress_file_name(activity_id)
    scope_note = (
        f'Você só tem acesso de arquivo a este projeto ("{project_name}") — nenhum outro '
        "repositório está disponível aqui, mesmo que a spec descreva trabalho que "
        "pertence a outro (ex: endpoint de backend, mudança em outro serviço). Nesses "
        "casos, NÃO crie um bloco pra implementar essa outra parte — trate como um "
        "contrato/dependência externa (assuma que existe ou vai existir conforme "
        f"descrito na spec) e só crie blocos pro que precisa ser feito de fato aqui em {project_name}."
    )
    gating_rule = (
        "Um bloco só pode começar quando TODOS os blocos listados em seu "
        '"dependsOn" estiverem com status "done" E "released": true — '
        '"released" e "validated" são dois campos que só eu escrevo, por '
        "fora deste terminal; nunca os escreva você mesmo, nem assuma que "
        "estão satisfeitos sem eles estarem lá de verdade. São etapas "
        'diferentes minhas, nessa ordem: "validated" marca que eu aprovei '
        'o que você fez naquele bloco; "released" marca que eu de fato '
        "destravei o próximo passo — podem NÃO acontecer juntas de "
        "propósito (as vezes eu aprovo mas ainda quero pedir um ajuste "
        'extra, via subtask, antes de liberar de verdade). É "released" '
        'que efetivamente conta pra essa condição — "validated" sozinho '
        "(sem released) NÃO libera um bloco que dependa dele. Um bloco com "
        '"dependsOn" vazio (ou ausente) não depende de nada, então essa '
        "condição já está satisfeita pra ele — pode começar (ou retomar) "
        "esse bloco direto, sem esperar nenhuma aprovação minha antes de "
        "iniciar; a espera por confirmação só existe DEPOIS de terminar um "
        "bloco, nunca antes de começar um que já está liberado. Sempre que "
        'terminar um bloco (status vira "done"), aí sim pare o trabalho e '
        "aguarde nesta mesma janela — não pule pro próximo bloco sozinho "
        "mesmo que ele pareça liberado, espere eu confirmar por aqui que "
        "pode seguir."
    )
    subtask_note = (
        "Opcionalmente, enquanto estiver trabalhando num bloco, você pode "
        "adicionar ao mesmo array de steps itens comuns (sem id próprio, "
        'só {"title": "...", "status": "...", "parentId": "<id-do-bloco>"}) '
        "pra detalhar o que está sendo feito dentro dele — aparecem como "
        "subtasks daquele bloco no painel, fora do checklist principal de "
        "blocos. É só transparência do seu progresso interno, não interfere "
        "em dependsOn/validated nem precisa ser exaustivo."
    )
    block_spec_note = (
        "Alguns blocos (normalmente os que eu adiciono manualmente depois, "
        'não os da decomposição original) podem vir com um campo "specFile" '
        "próprio — um .md com o escopo específico DAQUELE bloco (ex: um "
        "documento novo dos endpoints reais do backend). Se o bloco que "
        "você for começar tiver esse campo, leia esse arquivo inteiro "
        "antes de trabalhar nele — é o equivalente, só que escopado a um "
        f"bloco, do que a spec grande ({spec_file}) é pra atividade inteira. "
        f"Nesse caso, releia também a spec original ({spec_file}) — não só "
        "a do bloco: um documento novo desses costuma ser complementar (ex: "
        "os endpoints reais de um backend que a spec original só descrevia "
        "em alto nível ou nem existiam ainda quando ela foi escrita), e é "
        "cruzando os dois que dá pra fazer a ligação certa entre "
        "endpoint e a tela/fluxo correspondente já construído, em vez de "
        "tratar o conteúdo novo isolado do resto da atividade. Se essa spec "
        "própria do bloco for grande o bastante pra também precisar virar "
        "mais de um bloco (mesmo critério de sempre: pense em \"uma entrega "
        "coesa\" por bloco, não um passo miúdo), pode escrever esses blocos "
        "novos direto nesse mesmo array de steps, do mesmo jeito que a "
        "decomposição da spec original funciona — só que cada um desses "
        "blocos novos precisa incluir, no próprio \"dependsOn\", o id DESTE "
        "bloco (o que tem o specFile) — isso mantém um indicativo visual no "
        "diagrama de que aquele trabalho todo se originou dali, mesmo "
        "depois de virar vários blocos. O bloco original (com o specFile) "
        "continua existindo — não o substitua nem o apague — e pode virar "
        "\"done\" assim que a decomposição estiver escrita (o trabalho dele "
        "era ler a spec e planejar); os blocos novos seguem o ciclo normal "
        "de sempre (aprovação e liberação minhas antes de cada um começar)."
    )
    if not is_first_start:
        return (
            f"Esta atividade segue o modo blocos (spec em {spec_file}). {scope_note} "
            f"{gating_rule} {subtask_note} {block_spec_note} {REVIEW_STEP_INSTRUCTION}"
        )
    return (
        f"Esta atividade parte de uma spec grande anexada em {spec_file} — leia "
        f"esse arquivo inteiro antes de mais nada. {scope_note} Quebre o trabalho "
        "nele descrito em blocos maiores que um passo comum (pense em \"uma tela\" "
        "ou \"uma entrega coesa\" por bloco, não um passo miúdo), e escreva esse "
        f"plano no mesmo {file_name} do checklist de progresso, um item por bloco, "
        'cada um com {"id": "...", "title": "...", "status": "pending|in_progress|done", '
        '"dependsOn": ["id-de-outro-bloco", ...]} — dependsOn lista os blocos que '
        "precisam estar prontos antes deste começar (vazio se não depende de "
        "nenhum). Junto com esse plano inicial, escreva também o campo "
        '"summary" (ver instrução dele acima) com a visão geral da spec '
        "inteira — importante especialmente aqui: uma vez quebrada em "
        "blocos, a spec original fica fragmentada nos títulos individuais, "
        "e sem esse resumo eu perco a visão do todo. Depois de escrever "
        "plano e resumo, PARE e espere — não comece nenhum bloco ainda, eu "
        "preciso revisar e validar o plano primeiro. "
        f"A partir daí, {gating_rule} {subtask_note} {block_spec_note} {REVIEW_STEP_INSTRUCTION}"
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


def _read_progress_data(folder: str, activity_id: str) -> dict:
    """Lê o arquivo de progresso inteiro (steps + summary + qualquer outro
    campo de nível superior que o Claude escreva) — base de `_read_progress`
    e `_read_summary`. Tolera o arquivo não existir ainda ou estar no meio
    de uma escrita do Claude, voltando dict vazio em vez de erro."""
    path = Path(folder) / _progress_file_name(activity_id)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def _read_progress(folder: str, activity_id: str) -> list[dict]:
    steps = _read_progress_data(folder, activity_id).get("steps", [])
    return steps if isinstance(steps, list) else []


def _read_summary(folder: str, activity_id: str) -> str:
    """Visão geral da atividade que o Claude mantém (ver
    SUMMARY_FIELD_INSTRUCTION) — sobrevive à fragmentação do checklist em
    passos/blocos miúdos, é o único lugar que dá o contexto do todo."""
    summary = _read_progress_data(folder, activity_id).get("summary", "")
    return summary if isinstance(summary, str) else ""


def _write_progress(folder: str, activity_id: str, steps: list[dict]) -> None:
    """Só os endpoints daqui (validar bloco, liberar, adicionar/excluir
    passo manual) chamam isso, e só mexem no array de steps — preserva
    "summary" e qualquer outro campo de nível superior que já esteja no
    arquivo, senão sobrescrever ele inteiro como {"steps": steps} apagaria
    o resumo que o Claude escreveu por fora dessas chamadas."""
    data = _read_progress_data(folder, activity_id)
    data["steps"] = steps
    write_json_atomic(Path(folder) / _progress_file_name(activity_id), data)


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


@router.post("/activities/{activity_id}/spec")
async def upload_activity_spec(activity_id: str, file: UploadFile = File(...)) -> dict:
    """Anexa o .md de spec que ativa o "modo blocos" (ver
    _block_mode_instruction) — só faz sentido antes da atividade iniciar,
    mesmo espírito de outros campos que somem do form depois de
    `started=true`. Um arquivo só por atividade: um novo upload substitui
    o anterior (apaga o antigo do disco)."""
    if not (file.filename or "").lower().endswith(".md"):
        raise HTTPException(status_code=400, detail="Só arquivos .md são aceitos como spec.")
    activities = _load()
    activity = _find(activities, activity_id)
    if activity["started"]:
        raise HTTPException(status_code=400, detail="Essa atividade já foi iniciada — não dá pra trocar a spec agora.")
    content = await file.read()
    previous = activity.get("specFile")
    saved = attachments_store.save_file(f"{activity_id}/spec", file.filename or "spec.md", content)
    if previous:
        attachments_store.delete_image(previous)
    activity["specFile"] = saved
    _save(activities)
    return {"specFile": saved}


@router.delete("/activities/{activity_id}/spec")
def delete_activity_spec(activity_id: str) -> dict:
    activities = _load()
    activity = _find(activities, activity_id)
    if activity["started"]:
        raise HTTPException(status_code=400, detail="Essa atividade já foi iniciada — não dá pra remover a spec agora.")
    spec_file = activity.get("specFile")
    if not spec_file:
        raise HTTPException(status_code=404, detail="Essa atividade não tem spec anexada.")
    attachments_store.delete_image(spec_file)
    activity["specFile"] = None
    _save(activities)
    return {"specFile": None}


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
    # Prompt é opcional na criação/edição (pra não travar o fluxo de "anexar
    # spec e pronto" — a spec só pode ser enviada depois que a atividade já
    # tem id, mesma limitação de anexo de imagem), mas iniciar sem nenhum
    # dos dois não daria pro Claude nenhuma instrução real de trabalho.
    if not activity["prompt"].strip() and not activity.get("specFile"):
        raise HTTPException(
            status_code=400,
            detail="Escreva um prompt ou anexe uma spec (.md) antes de iniciar esta atividade.",
        )
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
    status_path = _status_file_path(folder, activity_id)
    resuming = activity["started"] and status_path.exists()
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
        prompt = (
            f"Retomando atividade. Leia o {status_path.name} antes de continuar "
            f"(a partir de agora, salve o histórico sempre em {_status_file_name(activity_id)}, "
            "mesmo que tenha lido um STATUS.md antigo sem sufixo).\n\n" + prompt
        )
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
                block_spec = s.get("specFile")
                if block_spec:
                    note += f"\n  Este bloco tem uma spec própria (leia antes de trabalhar nele): {block_spec}"
                return note

            pending_notes = "\n".join(_step_note(s) for s in pending_steps)
            prompt = (
                "Antes de mais nada, resolva os passos ainda pendentes do checklist desta "
                "atividade (alguns podem ter sido adicionados manualmente por mim depois da "
                f"última vez que você rodou):\n{pending_notes}\n\n{prompt}"
            )

    spec_file = activity.get("specFile")
    if spec_file:
        prompt = f"{_block_mode_instruction(activity_id, spec_file, is_first_start, project['name'])}\n\n{prompt}"

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
    data = _read_progress_data(folder, activity_id)
    steps = data.get("steps", [])
    summary = data.get("summary", "")
    return {
        "steps": steps if isinstance(steps, list) else [],
        "summary": summary if isinstance(summary, str) else "",
    }


@router.get("/activities/{activity_id}/diff-summary")
def get_activity_diff_summary(activity_id: str) -> dict:
    """Lista real (via `git diff`, ver `git_utils.diff_summary`) dos
    arquivos que essa atividade criou/mexeu/removeu na branch dela em
    relação à branch de desenvolvimento do projeto — complementa o
    "summary" (que é a explicação em prosa do Claude sobre o que/porquê)
    com o "o quê" exato, sem depender dele lembrar/listar cada arquivo
    certo numa spec grande com muitos blocos. Melhor esforço: qualquer
    situação em que não dá pra calcular (projeto sem devBranch, atividade
    ainda não iniciada, branch igual à de dev, pasta não é repo git válido)
    volta lista vazia em vez de erro — essa lista é só um extra
    informativo, não deveria travar a tela da atividade."""
    activities = _load()
    activity = _find(activities, activity_id)
    project = _find_project(_load_projects(), activity["projectId"])
    if project is None or not project["folders"]:
        return {"files": []}
    dev_branch = project.get("devBranch")
    branch = activity.get("branchName")
    if not dev_branch or not branch or branch == dev_branch:
        return {"files": []}
    folder = project["folders"][0]["path"]
    try:
        git_utils.fetch(folder)
        base_ref = f"origin/{dev_branch}" if git_utils.ref_exists(folder, f"origin/{dev_branch}") else dev_branch
        if not git_utils.ref_exists(folder, base_ref) or not git_utils.ref_exists(folder, branch):
            return {"files": []}
        files = git_utils.diff_summary(folder, base_ref, branch)
    except git_utils.GitError:
        return {"files": []}
    return {"files": files}


@router.post("/activities/{activity_id}/steps")
async def add_activity_step(
    activity_id: str,
    title: str = Form(...),
    files: list[UploadFile] = File(default=[]),
    parentId: str | None = Form(default=None),
) -> dict:
    """Adiciona um passo manual ao checklist de progresso da atividade —
    marcado com `source: "user"` pra distinguir dos passos que o próprio
    Claude gerencia (ver `_progress_instruction`: ele é instruído a nunca
    remover steps com essa marca). Aceita imagens junto (multipart, não
    JSON) — salvas numa subpasta própria do step dentro do escopo da
    atividade, reinjetadas no prompt em `start_activity` quando o passo
    ainda estiver pendente.

    `parentId`, quando presente, amarra esse passo a um bloco específico
    (modo blocos, ver `_block_mode_instruction`) — vira uma subtask exibida
    no painel de detalhe daquele bloco no diagrama, em vez do checklist
    "solto" da atividade."""
    activities = _load()
    activity = _find(activities, activity_id)
    folder = _project_folder(activity["projectId"])
    title = title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Título do passo não pode ser vazio.")
    step: dict = {"title": title, "status": "pending", "source": "user"}
    if parentId:
        step["parentId"] = parentId
    if files:
        # Upload fica fora do lock (I/O de imagem não mexe no arquivo de
        # progresso) — só o ciclo lê-modifica-escreve dos steps precisa
        # ser serializado (ver _PROGRESS_LOCK).
        step["attachments"] = await _save_uploaded_images(f"{activity_id}/steps", files)
    with _PROGRESS_LOCK:
        steps = _read_progress(folder, activity_id)
        steps.append(step)
        _write_progress(folder, activity_id, steps)
    return {"steps": steps}


@router.post("/activities/{activity_id}/blocks")
async def add_activity_block(
    activity_id: str,
    title: str = Form(...),
    dependsOn: list[str] = Form(default=[]),
    specFile: UploadFile | None = File(default=None),
) -> dict:
    """Adiciona um bloco novo (não uma subtask) ao plano — um nó de
    verdade no diagrama, com `dependsOn` próprio, seguindo a mesma trava
    de sempre do modo blocos (só começa quando as dependências estiverem
    "done" e "released": true). Pensado pro caso do usuário: um pedido
    extra que surge depois que todos os blocos originais da spec já
    terminaram (ou no meio do trabalho, também funciona).

    `dependsOn` sempre ganha, além do que for passado, o id do último
    bloco já concluído (se houver algum) — regra do usuário: um bloco
    novo nunca fica sem depender de nada quando já existe trabalho feito,
    pra garantir uma sequência em vez de deixar ele largado sem ordem.

    Aceita opcionalmente um `.md` próprio desse bloco (`specFile`, campo
    novo no dict do bloco — mesma ideia do `specFile` da atividade, só que
    escopado a este bloco só) — pensado pro caso de "o backend mandou um
    doc novo dos endpoints reais, isso vira o escopo de um bloco de
    ajuste" em vez de eu ter que colar o conteúdo em algum lugar manualmente.
    `_block_mode_instruction` avisa o Claude pra ler esse arquivo antes de
    trabalhar num bloco que o tenha, e `_step_note` (retomada) repete esse
    aviso se o bloco ainda estiver pendente quando eu voltar pra atividade.

    Diferente de `add_activity_step`: isso só faz sentido em atividades no
    modo blocos (com `specFile` da atividade), e avisa o terminal com
    `send_new_block_instruction` (mensagem de "bloco novo no plano"),
    diferente do "bloco liberado" de `release_activity_step` — é uma
    adição ao plano, não a liberação de algo que já existia nele.
    `source: "user"` deixa esse bloco excluível depois (ver
    `delete_activity_block`, que também limpa a spec do disco).

    O aviso começa com um Esc automatizado (mesma `_type_into_window` de
    `release_activity_step`) — se o Claude estiver ativamente trabalhando
    agora, isso interrompe esse turno. Diferente da liberação, aqui não dá
    pra só "clicar de novo" pra confirmar (reenviar esta chamada criaria
    um bloco duplicado): o bloco é sempre criado, mas se
    `is_actively_working` achar que ele está ocupado, o aviso NÃO é
    mandado — devolve `needsConfirmation: true` e o `blockId` criado; quem
    quiser mandar mesmo assim usa `POST .../blocks/{blockId}/notify`
    (reenvia só o aviso, não recria nada)."""
    activities = _load()
    activity = _find(activities, activity_id)
    if not activity.get("specFile"):
        raise HTTPException(
            status_code=400,
            detail="Só dá pra adicionar um bloco novo em atividades no modo blocos (com spec anexada).",
        )
    folder = _project_folder(activity["projectId"])
    title = title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Título do bloco não pode ser vazio.")
    if specFile is not None and not (specFile.filename or "").lower().endswith(".md"):
        raise HTTPException(status_code=400, detail="Só arquivos .md são aceitos como spec do bloco.")

    with _PROGRESS_LOCK:
        steps = _read_progress(folder, activity_id)
        known_block_ids = {s["id"] for s in steps if s.get("id")}
        unknown = [dep for dep in dependsOn if dep not in known_block_ids]
        if unknown:
            raise HTTPException(status_code=400, detail=f"Dependência(s) inexistente(s): {', '.join(unknown)}.")
        block_id = f"block-{uuid.uuid4().hex[:8]}"
        # Um bloco novo sempre depende do último bloco já concluído (pedido
        # do usuário) — garante uma sequência, evita um bloco criado depois
        # ficar sem nenhuma dependência e o Claude poder pular pra ele sem
        # ordem nenhuma. Forçado aqui no backend (não só sugerido no
        # front) pra valer de verdade mesmo numa chamada direta à API.
        # "Último" = último em ordem no array de steps com status "done" —
        # sem timestamp de conclusão real, é o melhor proxy disponível pra
        # "ordem" num plano que normalmente já é escrito nessa sequência.
        last_done_block_id = next(
            (s["id"] for s in reversed(steps) if s.get("id") and s.get("status") == "done"), None
        )
        final_depends_on = list(dependsOn)
        if last_done_block_id and last_done_block_id not in final_depends_on:
            final_depends_on.append(last_done_block_id)
        new_block: dict = {
            "id": block_id,
            "title": title,
            "status": "pending",
            "dependsOn": final_depends_on,
            "source": "user",
        }
        if specFile is not None:
            content = await specFile.read()
            new_block["specFile"] = attachments_store.save_file(
                f"{activity_id}/blocks/{block_id}", specFile.filename or "spec.md", content
            )
        steps.append(new_block)
        _write_progress(folder, activity_id, steps)

    if claude_terminal.is_actively_working(activity_id):
        return {"steps": steps, "sent": False, "needsConfirmation": True, "blockId": block_id}
    sent = claude_terminal.send_new_block_instruction(activity_id, title, new_block.get("specFile"))
    return {"steps": steps, "sent": sent, "needsConfirmation": False, "blockId": block_id}


@router.post("/activities/{activity_id}/blocks/{block_id}/notify")
def notify_activity_block(activity_id: str, block_id: str) -> dict:
    """Reenvia o aviso de "bloco novo no plano" pra um bloco que já
    existe — usado quando `add_activity_block` voltou `needsConfirmation:
    true` (Claude parecia ocupado na hora da criação) e eu decido mandar
    mesmo assim. Não recria nada, só dispara `send_new_block_instruction`
    de novo pro título já salvo."""
    activities = _load()
    activity = _find(activities, activity_id)
    folder = _project_folder(activity["projectId"])
    steps = _read_progress(folder, activity_id)
    block = next((s for s in steps if s.get("id") == block_id), None)
    if block is None:
        raise HTTPException(status_code=404, detail="Esse bloco não existe no checklist desta atividade.")
    sent = claude_terminal.send_new_block_instruction(activity_id, block.get("title", block_id), block.get("specFile"))
    return {"sent": sent}


@router.delete("/activities/{activity_id}/steps")
def delete_activity_step(activity_id: str, payload: ActivityStepTitle) -> dict:
    """Remove um passo do checklist — só permite excluir os que foram
    adicionados manualmente (`source: "user"`); os que o Claude criou como
    parte do próprio plano não podem ser apagados por aqui."""
    activities = _load()
    activity = _find(activities, activity_id)
    folder = _project_folder(activity["projectId"])
    with _PROGRESS_LOCK:
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


@router.delete("/activities/{activity_id}/blocks/{block_id}")
def delete_activity_block(activity_id: str, block_id: str) -> dict:
    """Remove um bloco criado manualmente (`source: "user"`, ver
    `add_activity_block`) — blocos que vieram da decomposição original da
    spec (escritos pelo próprio Claude) não podem ser apagados por aqui,
    mesma regra de `delete_activity_step` pros passos soltos. Diferente
    daquele endpoint (usa `id`, não `title` — blocos têm id próprio e
    títulos poderiam colidir) e faz cascata: também remove as subtasks
    amarradas a ele (`parentId == block_id`, junto com os anexos delas) e
    tira esse id de qualquer "dependsOn" de outro bloco — sem isso, um
    bloco que dependesse do apagado ficaria travado pra sempre, apontando
    pra uma dependência que não existe mais."""
    activities = _load()
    activity = _find(activities, activity_id)
    folder = _project_folder(activity["projectId"])
    with _PROGRESS_LOCK:
        steps = _read_progress(folder, activity_id)
        block = next((s for s in steps if s.get("id") == block_id), None)
        if block is None:
            raise HTTPException(status_code=404, detail="Esse bloco não existe no checklist desta atividade.")
        if block.get("source") != "user":
            raise HTTPException(
                status_code=400,
                detail="Só dá pra excluir blocos criados manualmente — os que vieram da spec original não podem ser apagados por aqui.",
            )
        remaining: list[dict] = []
        for step in steps:
            if step.get("id") == block_id or step.get("parentId") == block_id:
                for attachment_path in step.get("attachments", []):
                    attachments_store.delete_image(attachment_path)
                if step.get("specFile"):
                    attachments_store.delete_image(step["specFile"])
                continue
            depends_on = step.get("dependsOn")
            if depends_on and block_id in depends_on:
                step["dependsOn"] = [d for d in depends_on if d != block_id]
            remaining.append(step)
        _write_progress(folder, activity_id, remaining)
    return {"steps": remaining}


@router.post("/activities/{activity_id}/steps/{step_id}/validate")
def validate_activity_step(activity_id: str, step_id: str) -> dict:
    """Marca um bloco (passo com `id`, modo blocos) como aprovado pelo
    humano — só o humano chama isso, mesmo espírito de
    AcceptanceCriterion.met. De propósito NÃO libera o Claude pra seguir
    sozinho (ver `release_activity_step` pra isso): entre aprovar e liberar
    a próxima etapa eu ainda posso pedir subtasks extras neste bloco (POST
    .../steps com parentId), e só libero depois que elas também estiverem
    resolvidas."""
    activities = _load()
    activity = _find(activities, activity_id)
    folder = _project_folder(activity["projectId"])
    with _PROGRESS_LOCK:
        steps = _read_progress(folder, activity_id)
        for step in steps:
            if step.get("id") == step_id:
                step["validated"] = True
                _write_progress(folder, activity_id, steps)
                return {"steps": steps}
    raise HTTPException(status_code=404, detail="Esse bloco não existe no checklist desta atividade.")


@router.post("/activities/{activity_id}/steps/{step_id}/release")
def release_activity_step(activity_id: str, step_id: str, confirm: bool = False) -> dict:
    """Libera o Claude pra seguir pro(s) próximo(s) bloco(s) cujas
    dependências já estejam satisfeitas — só depois que eu já aprovei este
    bloco (`validated`, ver `validate_activity_step`) E todas as subtasks
    amarradas a ele (parentId == step_id) estiverem "done", incluindo as
    que eu pedir depois da aprovação inicial. Sem essa segunda trava,
    aprovar cedo demais deixaria pedidos extras pendentes pra trás. Mesmo
    best-effort de `pause_activity` quanto ao terminal: se não houver
    janela aberta agora, a liberação não é reenviada automaticamente depois
    — a atividade precisa ser retomada pra o Claude ver o estado atual.

    O aviso pro terminal (`send_advance_instruction`) começa com um Esc
    automatizado (ver `_type_into_window`) — se o Claude estiver ativamente
    gerando/rodando ferramenta AGORA (em outro bloco, não necessariamente
    o que está sendo liberado), esse Esc interrompe esse turno no meio.
    Por isso, sem `confirm=True`, se `is_actively_working` achar que ele
    está ocupado, devolve `needsConfirmation: true` SEM persistir nada —
    `released` só vira `true` quando o aviso realmente vai ser mandado
    (nessa chamada, com `is_actively_working` false, ou numa seguinte com
    `confirm=True`). Bug real corrigido: a versão anterior persistia
    `released` ANTES dessa checagem — um primeiro clique que pedia
    confirmação já deixava a pill "liberado" acesa e o botão travado
    (`canRelease` exige `!released`) pra sempre, mesmo o aviso nunca tendo
    sido enviado de verdade."""
    activities = _load()
    activity = _find(activities, activity_id)
    folder = _project_folder(activity["projectId"])

    def _check_ready() -> tuple[list[dict], dict]:
        steps = _read_progress(folder, activity_id)
        block = next((s for s in steps if s.get("id") == step_id), None)
        if block is None:
            raise HTTPException(status_code=404, detail="Esse bloco não existe no checklist desta atividade.")
        if not block.get("validated"):
            raise HTTPException(status_code=400, detail="Aprove este bloco antes de liberar a próxima etapa.")
        pending_subtasks = [s for s in steps if s.get("parentId") == step_id and s.get("status") != "done"]
        if pending_subtasks:
            raise HTTPException(
                status_code=400,
                detail="Ainda há subtasks pendentes neste bloco — resolva-as antes de liberar a próxima etapa.",
            )
        return steps, block

    with _PROGRESS_LOCK:
        steps, block = _check_ready()

    # Fora do lock: é só leitura de tela (osascript), não mexe no arquivo —
    # segurar o lock aqui travaria à toa outros cliques (ex: Aprovar num
    # bloco diferente) esperando sem necessidade.
    if not confirm and claude_terminal.is_actively_working(activity_id):
        return {"steps": steps, "sent": False, "needsConfirmation": True}

    # Reconfere (não reaproveita o snapshot de cima) porque pode ter
    # passado tempo real entre a checagem e aqui (o usuário precisa clicar
    # de novo pra confirmar) — algo pode ter mudado nesse intervalo.
    with _PROGRESS_LOCK:
        steps, block = _check_ready()
        block["released"] = True
        _write_progress(folder, activity_id, steps)

    sent = claude_terminal.send_advance_instruction(activity_id, block.get("title", step_id))
    return {"steps": steps, "sent": sent, "needsConfirmation": False}


@router.post("/activities/{activity_id}/pause")
def pause_activity(activity_id: str) -> dict:
    activities = _load()
    activity = _find(activities, activity_id)
    sent = claude_terminal.send_pause_instruction(activity_id, _pause_instruction(activity_id))
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
    # Passos com `id` são blocos (modo blocos, ver _block_mode_instruction) —
    # "done" ali é só o que o Claude acha, "validated" é a confirmação minha
    # de fora. Concluir a atividade não pode passar por cima disso.
    if any(step.get("id") and not step.get("validated") for step in steps):
        raise HTTPException(status_code=400, detail="Ainda há blocos concluídos que você não validou.")

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
