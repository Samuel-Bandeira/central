import subprocess


class GitError(Exception):
    pass


def _run(folder: str, *args: str) -> str:
    result = subprocess.run(["git", "-C", folder, *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise GitError(result.stderr.strip() or f"git {' '.join(args)} falhou")
    return result.stdout.strip()


def is_clean(folder: str) -> bool:
    return _run(folder, "status", "--porcelain") == ""


def current_branch(folder: str) -> str:
    return _run(folder, "rev-parse", "--abbrev-ref", "HEAD")


def current_commit(folder: str) -> str:
    return _run(folder, "rev-parse", "HEAD")


def pull(folder: str) -> None:
    _run(folder, "pull")


def checkout(folder: str, branch: str) -> None:
    """Troca pra `branch`. Se não existir localmente, tenta um `checkout`
    simples primeiro — se houver um `origin/<branch>` correspondente, o
    próprio git cria a branch local já rastreando o remoto (comportamento
    padrão do git, não precisamos reimplementar isso). Só cai pra
    `checkout -b` (branch nova a partir do HEAD atual) se nem isso existir.

    Não confere árvore limpa aqui — quem chama decide a política (ex: recusar
    a troca se houver mudança não commitada numa branch diferente)."""
    result = subprocess.run(["git", "-C", folder, "checkout", branch], capture_output=True, text=True)
    if result.returncode == 0:
        return
    _run(folder, "checkout", "-b", branch)


def ref_exists(folder: str, ref: str) -> bool:
    result = subprocess.run(
        ["git", "-C", folder, "rev-parse", "--verify", "--quiet", ref], capture_output=True, text=True
    )
    return result.returncode == 0


def commits_behind(folder: str, base_ref: str) -> int:
    """Quantos commits `base_ref` tem que o HEAD atual não tem — ou seja, o
    quanto a branch atual está desatualizada em relação a essa referência."""
    return int(_run(folder, "rev-list", "--count", f"HEAD..{base_ref}"))


def commits_ahead(folder: str, base_ref: str) -> int:
    """Quantos commits o HEAD atual tem que `base_ref` não tem — ou seja, o
    quanto a branch atual avançou em relação a essa referência."""
    return int(_run(folder, "rev-list", "--count", f"{base_ref}..HEAD"))


def fetch(folder: str) -> None:
    """`git fetch --prune`, melhor esforço — ignora erro se não houver
    remoto configurado (mesmo padrão usado antes de comparar branches)."""
    subprocess.run(["git", "-C", folder, "fetch", "--prune"], capture_output=True, text=True)


def remote_url(folder: str) -> str | None:
    """URL do remoto `origin`, ou `None` se a pasta não tiver um (não
    levanta `GitError` — não ter remoto é uma situação normal, não um
    erro)."""
    result = subprocess.run(
        ["git", "-C", folder, "remote", "get-url", "origin"], capture_output=True, text=True
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def push(folder: str, branch: str) -> None:
    """`git push -u origin <branch>`. Levanta `GitError` se falhar (ex:
    remoto divergiu e precisa de resolução manual) — quem chama decide
    como reportar isso."""
    _run(folder, "push", "-u", "origin", branch)


def list_branches(folder: str) -> list[str]:
    """`git fetch --prune` (melhor esforço — ignora erro se não tiver
    remoto configurado) e retorna os nomes de branch conhecidos (locais +
    remotos), sem duplicar e sem o prefixo do remoto (ex: "origin/develop"
    vira só "develop")."""
    subprocess.run(["git", "-C", folder, "fetch", "--prune"], capture_output=True, text=True)

    remotes_result = subprocess.run(["git", "-C", folder, "remote"], capture_output=True, text=True)
    remotes = [r for r in remotes_result.stdout.splitlines() if r.strip()]

    result = subprocess.run(
        ["git", "-C", folder, "branch", "-a", "--format=%(refname:short)"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise GitError(result.stderr.strip() or "git branch falhou")

    names: set[str] = set()
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line or line in remotes:
            # "origin" sozinho é o HEAD simbólico do remoto (refname:short
            # de refs/remotes/origin/HEAD vira só "origin", sem "/HEAD") —
            # não é uma branch de verdade.
            continue
        remote = next((r for r in remotes if line.startswith(f"{r}/")), None)
        names.add(line[len(remote) + 1 :] if remote else line)
    return sorted(names)
