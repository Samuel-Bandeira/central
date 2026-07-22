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


def uncommitted_count(folder: str) -> int:
    """Quantidade de arquivos com mudanças não commitadas (modificados,
    adicionados, removidos ou não rastreados)."""
    output = _run(folder, "status", "--porcelain")
    return len([line for line in output.splitlines() if line.strip()])


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


def diff_summary(folder: str, base_ref: str, branch: str) -> list[dict]:
    """Lista de arquivos que `branch` criou/mexeu/removeu desde que
    divergiu de `base_ref` — diff de três pontos (`base...branch`), mesmo
    critério do "Compare" do GitHub/GitLab (compara contra o ancestral
    comum, não contra a ponta atual de `base_ref`, então commits novos em
    `base_ref` depois da divergência não aparecem como "mudança" da
    atividade). Fonte real pro "o que foi feito nesta atividade" — ao
    contrário de pedir pro Claude listar isso de memória (não confiável
    numa spec grande com muitos blocos), isso é o próprio git calculando."""
    output = _run(folder, "diff", "--name-status", f"{base_ref}...{branch}")
    files: list[dict] = []
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        code = parts[0]
        if code.startswith("R") and len(parts) == 3:
            files.append({"path": parts[2], "oldPath": parts[1], "status": "renamed"})
        elif len(parts) == 2:
            status = {"A": "added", "M": "modified", "D": "deleted"}.get(code[0], "modified")
            files.append({"path": parts[1], "oldPath": None, "status": status})
    return files


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
