import os
import plistlib
import subprocess
from pathlib import Path

LABEL_PREFIX = "com.launcher."

LAUNCH_AGENTS_DIR = Path.home() / "Library" / "LaunchAgents"
LOGS_DIR = Path.home() / "Library" / "Logs" / "launcher"


def agent_label(project_id: str) -> str:
    return f"{LABEL_PREFIX}{project_id}"


def plist_path(project_id: str) -> Path:
    return LAUNCH_AGENTS_DIR / f"{agent_label(project_id)}.plist"


def log_path(section_id: str, project_id: str) -> Path:
    return LOGS_DIR / f"{section_id}-{project_id}.log"


def gui_domain() -> str:
    return f"gui/{os.getuid()}"


def _rc_file_for_shell(shell: str) -> str | None:
    name = Path(shell).name
    if name == "zsh":
        return "~/.zshrc"
    if name == "bash":
        return "~/.bashrc"
    return None


def write_plist(project_id: str, run_command: str, working_directory: str | None, log_file: Path) -> Path:
    log_file.parent.mkdir(parents=True, exist_ok=True)
    path = plist_path(project_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    # -l (login) carrega .zprofile/.bash_profile (ex: PATH do Homebrew). Mas
    # nvm/pyenv normalmente só se inicializam em shells *interativos*
    # (.zshrc/.bashrc) — usar -i pra isso se mostrou instável sob o launchd
    # (sem TTY, o shell pode encerrar o job sozinho depois de um tempo), então
    # carregamos esse arquivo manualmente dentro do próprio comando.
    shell = os.environ.get("SHELL", "/bin/zsh")
    rc_file = _rc_file_for_shell(shell)
    command = f"[ -f {rc_file} ] && source {rc_file}; {run_command}" if rc_file else run_command
    data: dict = {
        "Label": agent_label(project_id),
        "ProgramArguments": [shell, "-lc", command],
        "RunAtLoad": True,
        "StandardOutPath": str(log_file),
        "StandardErrorPath": str(log_file),
    }
    if working_directory:
        data["WorkingDirectory"] = working_directory
    with path.open("wb") as f:
        plistlib.dump(data, f)
    return path


def bootstrap(project_id: str) -> None:
    path = plist_path(project_id)
    subprocess.run(
        ["launchctl", "bootstrap", gui_domain(), str(path)],
        capture_output=True,
        text=True,
        check=True,
    )


def bootout(project_id: str) -> None:
    subprocess.run(
        ["launchctl", "bootout", f"{gui_domain()}/{agent_label(project_id)}"],
        capture_output=True,
        text=True,
        check=True,
    )


def list_agents() -> dict[str, str | None]:
    """Mapeia project_id -> PID (como string) dos agentes com.launcher.* que o
    launchd conhece. PID é None quando o agente está carregado mas não está
    de fato rodando (ex: o comando falhou e saiu, sem KeepAlive)."""
    result = subprocess.run(["launchctl", "list"], capture_output=True, text=True)
    agents: dict[str, str | None] = {}
    for line in result.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        pid, _status, label = parts
        if label.startswith(LABEL_PREFIX):
            agents[label[len(LABEL_PREFIX):]] = pid if pid.isdigit() else None
    return agents


def list_running_project_ids() -> set[str]:
    return {project_id for project_id, pid in list_agents().items() if pid is not None}
