import json
import subprocess
import tempfile
import time
from pathlib import Path

from . import macos_ui

APP_SUPPORT_DIR = Path.home() / "Library" / "Application Support" / "central-launcher"
PROMPTS_DIR = APP_SUPPORT_DIR / "claude-prompts"
WINDOW_IDS_PATH = APP_SUPPORT_DIR / "claude-window-ids.json"


def _escape_for_applescript(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _tag(activity_id: str) -> str:
    return f"claude-activity:{activity_id}"


def _load_window_ids() -> dict[str, int]:
    if not WINDOW_IDS_PATH.exists():
        return {}
    return json.loads(WINDOW_IDS_PATH.read_text())


def _save_window_ids(window_ids: dict[str, int]) -> None:
    WINDOW_IDS_PATH.parent.mkdir(parents=True, exist_ok=True)
    WINDOW_IDS_PATH.write_text(json.dumps(window_ids))


def _all_window_ids() -> set[int]:
    result = subprocess.run(
        ["osascript", "-e", 'tell application "Terminal" to return id of every window'],
        capture_output=True,
        text=True,
    )
    text = result.stdout.strip()
    if not text:
        return set()
    return {int(part.strip()) for part in text.split(",") if part.strip().isdigit()}


def _window_exists(window_id: int) -> bool:
    script = f'tell application "Terminal" to return (exists window id {window_id})'
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    return result.stdout.strip() == "true"


def list_open_activity_ids(known_ids: list[str]) -> list[str]:
    window_ids = _load_window_ids()
    return [activity_id for activity_id in known_ids if activity_id in window_ids and _window_exists(window_ids[activity_id])]


def is_waiting_for_input(activity_id: str) -> bool:
    """Melhor esforço: lê o conteúdo visível da janela do Terminal e tenta
    adivinhar se o Claude está parado esperando algo de você — respondeu
    uma pergunta, terminou o turno, ou está num menu de permissão — em vez
    de ativamente gerando/rodando ferramenta. Baseado em texto que o
    próprio Claude Code CLI imprime (confirmado lendo o conteúdo real de
    uma janela ao vivo, 2026-07-20): enquanto está trabalhando, o rodapé
    mostra um spinner com "(esc to interrupt)"; quando o turno termina (ou
    fica parado num menu de permissão), esse texto some. Ausência de "esc
    to interrupt" nos últimos caracteres visíveis == precisa de você.
    Inerentemente frágil (texto de UI de terceiro, muda entre versões do
    CLI) — se parar de bater, é aqui que ajustar. Retorna False se a
    janela não existe ou não deu pra ler o conteúdo (nada a indicar).

    Exceção: quando o Claude dispara um agente em background e fica só
    aguardando a notificação de conclusão, o rodapé "esc to interrupt"
    some (não tem geração ativa), mas ele não está parado esperando você —
    está esperando o subagente. Esse estado imprime "Waiting for N
    background agent(s) to finish", então tratamos essa string como sinal
    de "ainda ocupado" e caímos de volta na heurística padrão se ela não
    aparecer."""
    window_ids = _load_window_ids()
    window_id = window_ids.get(activity_id)
    if window_id is None or not _window_exists(window_id):
        return False
    script = f'tell application "Terminal" to return contents of selected tab of window id {window_id}'
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        return False
    tail = result.stdout[-4000:]
    if "esc to interrupt" in tail:
        return False
    if "background agent" in tail and "Waiting for" in tail:
        return False
    return True


def open_claude_window(activity_id: str, folder: str, prompt: str, related_folders: list[str] | None = None) -> None:
    """Abre uma janela do Terminal.app na pasta do projeto rodando `claude`
    com o prompt carregado. O prompt vai pra um arquivo temporário (não
    direto no comando do AppleScript) porque descrições longas ou com aspas/
    quebras de linha não escapam bem dentro do osascript.

    A janela é identificada pelo `id` nativo do Terminal.app (guardado em
    `claude-window-ids.json`), não pelo título — o próprio Claude Code
    sobrescreve o "custom title" da aba com uma descrição da tarefa via
    escape sequence assim que inicia, então título não é confiável pra saber
    se a janela ainda está aberta. O id é capturado comparando a lista de
    janelas antes/depois de abrir (mais robusto do que assumir que a janela
    nova vira "window 1" — na prática isso nem sempre acontece quando o
    Terminal não está em foco real no momento da automação)."""
    window_ids = _load_window_ids()
    existing = window_ids.get(activity_id)
    if existing is not None and _window_exists(existing):
        return

    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
    prompt_file = tempfile.NamedTemporaryFile(
        dir=PROMPTS_DIR, prefix=f"{activity_id}-", suffix=".txt", delete=False
    )
    prompt_file.write(prompt.encode("utf-8"))
    prompt_file.close()

    before_ids = _all_window_ids()

    tag = _tag(activity_id)
    # --permission-mode auto: aprova sozinho ações seguras (editar arquivo,
    # rodar comando comum) via classificador, mas ainda bloqueia coisas
    # realmente arriscadas (force push, rm -rf /, vazar credencial, etc.).
    # Sem essa flag, o Claude Code inicia no modo padrão, que pausa pedindo
    # aprovação a cada ferramenta — não tem nada a ver com a instrução de
    # perguntar sobre o escopo da tarefa (essa é proposital, continua).
    #
    # --add-dir libera de antemão o acesso às pastas dos projetos citados
    # com @menção — sem isso, o Claude para pra pedir permissão toda vez
    # que tenta ler/escrever num projeto relacionado que está fora da pasta
    # onde ele foi iniciado.
    #
    # O prompt vem ANTES das flags de propósito: --add-dir aceita múltiplos
    # valores (variádica), e se o prompt vier logo depois dela na mesma
    # linha, o parser do CLI engole o prompt como se fosse mais um
    # diretório — resultado: Claude abre normal, mas sem nenhuma mensagem
    # inicial (só o placeholder vazio). Prompt primeiro evita a ambiguidade.
    add_dir_flags = "".join(f" --add-dir '{f}'" for f in (related_folders or []))
    command = f"cd {folder} && claude \"$(cat '{prompt_file.name}')\" --permission-mode auto{add_dir_flags}"
    script = f"""
    tell application "Terminal"
        activate
        set theTab to do script "{_escape_for_applescript(command)}"
        set custom title of theTab to "{_escape_for_applescript(tag)}"
    end tell
    """
    subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    macos_ui.set_frontmost_window_fullscreen("Terminal")

    after_ids = _all_window_ids()
    new_ids = after_ids - before_ids
    if new_ids:
        window_ids[activity_id] = new_ids.pop()
        _save_window_ids(window_ids)


def _type_into_window(window_id: int, text: str) -> None:
    """"Digita" `text` na janela do Terminal via AppleScript (`do script ...
    in window id X`), em 3 chamadas separadas — técnica testada e corrigida
    várias vezes em produção, cada detalhe abaixo veio de um bug real:

    1. Um Esc sozinho primeiro: se o Claude estiver parado num menu de
       permissão (escolha numerada tipo "1. Yes / 2. Yes, allow.../ 3. No"),
       digitar texto + Enter direto confirma a opção selecionada em vez de
       virar mensagem de chat — o Esc fecha esse menu e volta pro prompt
       normal antes de digitarmos de verdade.
    2. Uma pausa depois do Esc: mandá-lo colado direto no texto (numa `do
       script` só) é um erro clássico de automação de terminal — se os dois
       chegam rápido demais, o parser interpreta como atalho Meta/Alt+tecla
       em vez de duas teclas separadas, e come o primeiro caractere do texto
       (confirmado na prática: "teste" virou "este").
    3. Um Enter vazio numa chamada própria, no final, com pausa antes: um
       bloco grande de texto chegando de uma vez costuma ser tratado pelo
       terminal como "colar" (paste), e a maioria das TUIs de chat trata
       Enter dentro de um paste como quebra de linha, não como "enviar"
       (confirmado na prática: o texto ficou digitado, sem enviar)."""
    escape_script = f'tell application "Terminal" to do script (ASCII character 27) in window id {window_id}'
    subprocess.run(["osascript", "-e", escape_script], capture_output=True, text=True)
    time.sleep(0.3)

    text_script = f"""
    tell application "Terminal"
        do script "{_escape_for_applescript(text)}" in window id {window_id}
    end tell
    """
    subprocess.run(["osascript", "-e", text_script], capture_output=True, text=True)
    time.sleep(0.3)

    submit_script = f'tell application "Terminal" to do script "" in window id {window_id}'
    subprocess.run(["osascript", "-e", submit_script], capture_output=True, text=True)


def send_pause_instruction(activity_id: str, instruction_text: str) -> bool:
    """Não fecha a janela. Em vez disso "digita" (via `_type_into_window`) um
    pedido pro Claude salvar o progresso (texto montado por quem chama —
    `routers/activities.py`, dono de todas as strings de instrução do app)
    antes de encerrar.

    Fechar a janela direto (o que essa função fazia antes) dependia da
    própria preferência do Terminal.app de perguntar "tem processo rodando,
    fecha mesmo?" — mas isso é configurável pelo usuário e, se estiver
    desligado, a janela fecha na hora sem o Claude ter chance de salvar
    nada. Em vez de depender disso, avisamos o Claude e deixamos você
    fechar a janela manualmente depois que ele confirmar que terminou.

    Retorna False se não há janela conhecida (ou ela já fechou) pra essa
    atividade."""
    window_ids = _load_window_ids()
    window_id = window_ids.get(activity_id)
    if window_id is None or not _window_exists(window_id):
        return False
    _type_into_window(window_id, instruction_text)
    return True


def send_advance_instruction(activity_id: str, block_title: str) -> bool:
    """Mesma técnica de `send_pause_instruction`, mas pra destravar (não
    pausar): avisa que um bloco foi aprovado e liberado por fora e que o
    Claude pode seguir pro(s) próximo(s) bloco(s) do plano cujas
    dependências já estejam satisfeitas — usado pelo endpoint "Liberar
    próxima etapa" das tasks grandes (ver `release_activity_step` em
    routers/activities.py), que só chega a ser chamado depois que o bloco
    foi aprovado E todas as subtasks dele já estão resolvidas. A janela
    continua aberta o tempo todo; isso só desbloqueia o próximo passo do
    trabalho, não abre/fecha nada.

    Retorna False se não há janela conhecida (ou ela já fechou) pra essa
    atividade."""
    window_ids = _load_window_ids()
    window_id = window_ids.get(activity_id)
    if window_id is None or not _window_exists(window_id):
        return False
    text = (
        f'O bloco "{block_title}" foi aprovado por mim e todas as subtasks dele '
        "já estão resolvidas. Pode seguir para o(s) próximo(s) bloco(s) do plano "
        "cujas dependências já estejam satisfeitas (status \"done\" e "
        "\"validated\": true) — sem pular nenhum que ainda não esteja liberado."
    )
    _type_into_window(window_id, text)
    return True


def close_window(activity_id: str) -> bool:
    """Fecha a janela de verdade. Só deve ser chamada depois de confirmar
    por fora (ex: um commit novo na branch) que o wrap-up realmente
    aconteceu — chamar isso às cegas, logo após `send_pause_instruction`,
    foi o que causava fechar a janela antes do Claude salvar.

    Retorna True só se a janela realmente fechou (ou já não existia)."""
    window_ids = _load_window_ids()
    window_id = window_ids.get(activity_id)
    if window_id is None:
        return True

    close_script = f"""
    tell application "Terminal"
        try
            close window id {window_id}
        end try
    end tell
    """
    for _attempt in range(3):
        if not _window_exists(window_id):
            del window_ids[activity_id]
            _save_window_ids(window_ids)
            return True
        subprocess.run(["osascript", "-e", close_script], capture_output=True, text=True)
        time.sleep(0.3)
    # Não conseguiu fechar (ex: ainda tem processo ativo pedindo confirmação
    # no Terminal) — mantém o rastreamento em vez de apagar às cegas, senão
    # o indicativo mostra "parou" com a janela ainda aberta de verdade.
    # Quem chama deve tentar de novo depois (ex: no próximo poll).
    return False
