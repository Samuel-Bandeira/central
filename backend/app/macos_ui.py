import subprocess


def set_frontmost_window_fullscreen(process_name: str) -> None:
    """Coloca a janela mais à frente do processo em tela cheia (ocupa um
    Space próprio do macOS), via a Accessibility API (System Events).

    Exige permissão de Acessibilidade concedida à automação (System
    Settings > Privacy & Security > Accessibility) — sem isso, falha
    silenciosamente. Não deve travar nenhum fluxo por causa disso, é só um
    acabamento visual."""
    script = f"""
    tell application "System Events"
        tell process "{process_name}"
            set value of attribute "AXFullScreen" of window 1 to true
        end tell
    end tell
    """
    subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
