import subprocess
import time
from pathlib import Path


def _escape_for_applescript(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _tag(section_id: str) -> str:
    return f"launcher:{section_id}"


def _has_tagged_tab(tag: str) -> bool:
    script = f"""
    tell application "Terminal"
        set found to false
        repeat with w in windows
            repeat with t in tabs of w
                if (custom title of t) starts with "{_escape_for_applescript(tag)}" then
                    set found to true
                end if
            end repeat
        end repeat
        return found
    end tell
    """
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    return result.stdout.strip() == "true"


def open_tail_window(section_id: str, projects: list[tuple[str, Path]]) -> None:
    """Abre uma janela do Terminal.app por projeto, cada uma rodando
    `tail -f` só do log daquele projeto — evita misturar a saída de projetos
    diferentes numa aba só. Simplificação em relação ao arquitetura.md (que
    descreve abas dentro de uma única janela): juntar tudo numa janela só via
    AppleScript exige reaproveitar abas de forma pouco confiável (na prática,
    o Terminal só cria aba nova de forma confiável quando você mesmo aperta
    Cmd+T) — janelas separadas são o caminho robusto.

    Marca cada janela com um título customizado (`launcher:<section_id>:
    <nome>`) e não abre nada se já existir alguma janela pra essa seção —
    evita empilhar janelas a cada play, mesmo quando nada de novo foi
    iniciado.
    """
    if not projects:
        return
    tag = _tag(section_id)
    if _has_tagged_tab(tag):
        return

    lines = ['tell application "Terminal"', "activate"]
    for i, (name, log_path) in enumerate(projects):
        command = f"tail -n +1 -f '{log_path}'"
        title = f"{tag}:{name}"
        var = f"theWindow{i}"
        lines.append(f'set {var} to do script "{_escape_for_applescript(command)}"')
        lines.append(f'set custom title of {var} to "{_escape_for_applescript(title)}"')
        # sem essa pausa, criar janelas em sequência rápida demais deixa o
        # Terminal instável — ex: a última janela recusa fechar depois
        lines.append("delay 0.3")
    lines.append("end tell")
    script = "\n".join(lines)
    subprocess.run(["osascript", "-e", script], capture_output=True, text=True)


def _close_tagged_windows(tag: str) -> None:
    script = f"""
    tell application "Terminal"
        set winsToClose to {{}}
        repeat with w in windows
            repeat with t in tabs of w
                if (custom title of t) starts with "{_escape_for_applescript(tag)}" then
                    set end of winsToClose to w
                end if
            end repeat
        end repeat
        repeat with w in winsToClose
            try
                close w
            end try
        end repeat
    end tell
    """
    subprocess.run(["osascript", "-e", script], capture_output=True, text=True)


def close_tail_window(section_id: str, log_paths: list[Path]) -> None:
    """Mata o `tail -f` de verdade (via pkill, casando pelo caminho do log —
    mais confiável do que caçar PID pelo AppleScript) e fecha a(s) janela(s)
    do Terminal marcada(s) pra essa seção, já sem processo rodando nelas
    (então o Terminal não pergunta "tem certeza?").

    Fechar múltiplas janelas do Terminal em sequência é instável às vezes —
    uma ou outra pode não fechar de primeira — então tenta de novo antes de
    desistir."""
    for log_path in log_paths:
        subprocess.run(["pkill", "-f", str(log_path)], capture_output=True, text=True)

    tag = _tag(section_id)
    for _attempt in range(3):
        if not _has_tagged_tab(tag):
            return
        _close_tagged_windows(tag)
        time.sleep(0.3)
