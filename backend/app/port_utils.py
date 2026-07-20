import json
import subprocess
from pathlib import Path

_COMPOSE_FILENAMES = ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml")
_DOCKER_TIMEOUT_S = 5


def _child_pids(pid: str) -> list[str]:
    result = subprocess.run(["pgrep", "-P", pid], capture_output=True, text=True)
    return [p for p in result.stdout.split() if p]


def _process_tree(root_pid: str) -> list[str]:
    """PID raiz + todos os descendentes. O comando do projeto costuma rodar
    através de uma cadeia shell -> npm -> node (ou similar), então a porta
    real é aberta por um processo filho, não pelo PID que o launchd
    reporta."""
    pids = [root_pid]
    frontier = [root_pid]
    while frontier:
        children = [child for pid in frontier for child in _child_pids(pid)]
        pids.extend(children)
        frontier = children
    return pids


def listening_ports(root_pid: str) -> list[int]:
    """Portas TCP em LISTEN abertas por `root_pid` ou qualquer descendente
    dele. Lido do processo real via lsof a cada chamada — nunca fica
    desatualizado (ex: dev server que sobe numa porta diferente porque a
    default estava ocupada)."""
    pids = _process_tree(root_pid)
    result = subprocess.run(
        ["lsof", "-iTCP", "-sTCP:LISTEN", "-a", "-n", "-P", "-p", ",".join(pids)],
        capture_output=True,
        text=True,
    )
    ports: set[int] = set()
    for line in result.stdout.splitlines()[1:]:
        cols = line.split()
        if not cols:
            continue
        # A coluna NAME de um socket LISTEN vem como "*:3000 (LISTEN)" — dois
        # tokens separados por espaço. "(LISTEN)" não tem ":", então cai pro
        # token anterior, que é o endereço:porta de verdade.
        name = cols[-2] if cols[-1] == "(LISTEN)" else cols[-1]
        port_str = name.rsplit(":", 1)[-1]
        if port_str.isdigit():
            ports.add(int(port_str))
    return sorted(ports)


def _has_compose_file(working_directory: str) -> bool:
    base = Path(working_directory)
    return any((base / name).is_file() for name in _COMPOSE_FILENAMES)


def compose_ports(working_directory: str) -> list[int]:
    """Portas publicadas por containers de um `docker compose` rodando
    nessa pasta. Existe porque, nesse caso, quem escuta no host não é um
    processo filho do `docker compose up` — é um helper do Docker Desktop
    (ex: `com.docker.backend`), fora da árvore de processos do comando. A
    própria CLI do compose é quem sabe o mapeamento de portas."""
    if not _has_compose_file(working_directory):
        return []
    try:
        result = subprocess.run(
            ["docker", "compose", "ps", "--format", "json"],
            cwd=working_directory,
            capture_output=True,
            text=True,
            timeout=_DOCKER_TIMEOUT_S,
        )
    except (subprocess.TimeoutExpired, OSError):
        return []
    if result.returncode != 0:
        return []

    ports: set[int] = set()
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            container = json.loads(line)
        except json.JSONDecodeError:
            continue
        if container.get("State") != "running":
            continue
        for publisher in container.get("Publishers") or []:
            published = publisher.get("PublishedPort")
            if published:
                ports.add(int(published))
    return sorted(ports)


def project_ports(root_pid: str, working_directory: str | None) -> list[int]:
    ports = set(listening_ports(root_pid))
    if working_directory:
        ports.update(compose_ports(working_directory))
    return sorted(ports)
