import json
import subprocess
import tempfile
import time
from pathlib import Path

from . import macos_ui

APP_SUPPORT_DIR = Path.home() / "Library" / "Application Support" / "central-launcher"
PROMPTS_DIR = APP_SUPPORT_DIR / "claude-prompts"
WINDOW_IDS_PATH = APP_SUPPORT_DIR / "claude-window-ids.json"

PAUSE_INSTRUCTION = (
    "Pausando por aqui antes de fechar a janela. Antes de encerrar: atualize (ou "
    "crie) o STATUS.md com um resumo de tudo que já foi discutido e decidido "
    "nesta conversa até agora — incluindo perguntas que você fez e minhas "
    "respostas — o que já foi feito e o que falta. O STATUS.md é histórico de "
    "trabalho local, não deve ir pro repositório — se ele ainda não estiver no "
    ".gitignore do projeto, adicione uma linha pra ele lá antes de commitar. "
    "Depois, dê commit e push. Me avise por aqui quando terminar; eu fecho "
    "esta janela manualmente."
)


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


def send_pause_instruction(activity_id: str) -> bool:
    """Não fecha a janela. Em vez disso "digita" (via AppleScript, `do
    script ... in window id X`) um pedido pro Claude atualizar o STATUS.md
    com o que foi discutido/decidido até agora (incluindo perguntas e
    respostas da conversa) e dar commit+push antes de encerrar.

    Fechar a janela direto (o que essa função fazia antes) dependia da
    própria preferência do Terminal.app de perguntar "tem processo rodando,
    fecha mesmo?" — mas isso é configurável pelo usuário e, se estiver
    desligado, a janela fecha na hora sem o Claude ter chance de salvar
    nada. Em vez de depender disso, avisamos o Claude e deixamos você
    fechar a janela manualmente depois que ele confirmar que terminou.

    Manda um Esc antes do texto: se o Claude estiver parado num menu de
    permissão (escolha numerada tipo "1. Yes / 2. Yes, allow.../ 3. No"),
    digitar texto + Enter direto confirma a opção selecionada em vez de
    virar mensagem de chat — o Esc fecha esse menu e volta pro prompt
    normal antes de digitarmos de verdade.

    O Esc vai numa chamada separada, com uma pausa antes do texto. Mandar
    Esc colado direto no texto (numa `do script` só) é um erro clássico de
    automação de terminal: se os dois chegam rápido demais, o parser do
    terminal interpreta como um atalho Meta/Alt+tecla em vez de duas teclas
    separadas, e come o primeiro caractere do texto (confirmado na prática:
    "teste" virou "este"). A pausa dá tempo do parser fechar a sequência de
    escape antes do texto real chegar.

    Retorna False se não há janela conhecida (ou ela já fechou) pra essa
    atividade."""
    window_ids = _load_window_ids()
    window_id = window_ids.get(activity_id)
    if window_id is None or not _window_exists(window_id):
        return False

    escape_script = f'tell application "Terminal" to do script (ASCII character 27) in window id {window_id}'
    subprocess.run(["osascript", "-e", escape_script], capture_output=True, text=True)
    time.sleep(0.3)

    text_script = f"""
    tell application "Terminal"
        do script "{_escape_for_applescript(PAUSE_INSTRUCTION)}" in window id {window_id}
    end tell
    """
    subprocess.run(["osascript", "-e", text_script], capture_output=True, text=True)
    time.sleep(0.3)

    # Um bloco grande de texto chegando de uma vez costuma ser tratado pelo
    # terminal como "colar" (paste) — e a maioria das TUIs de chat trata
    # Enter dentro de um paste como quebra de linha, não como "enviar"
    # (proteção padrão pra colar texto multi-linha sem submeter no meio).
    # Confirmado na prática: o texto ficou digitado, sem enviar. Por isso
    # manda um Enter separado, depois, como evento próprio.
    submit_script = f'tell application "Terminal" to do script "" in window id {window_id}'
    subprocess.run(["osascript", "-e", submit_script], capture_output=True, text=True)
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
