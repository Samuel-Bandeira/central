import os
import re
from urllib.parse import quote

import httpx

from . import git_utils

API_BASE = "https://gitlab.com/api/v4"

_REMOTE_PATH_RE = re.compile(r"gitlab\.com[:/](.+?)(?:\.git)?/?$")


class GitlabError(Exception):
    pass


def project_path_from_remote(folder: str) -> str:
    """Descobre o `namespace/projeto` (com subgrupos, se houver) a partir do
    remoto `origin` da pasta — sem exigir nenhuma configuração extra por
    projeto. Só suporta gitlab.com (SaaS), não instâncias self-hosted."""
    url = git_utils.remote_url(folder)
    if url is None:
        raise GitlabError("A pasta não tem um remoto 'origin' configurado.")
    match = _REMOTE_PATH_RE.search(url)
    if not match:
        raise GitlabError(f"O remoto 'origin' não parece ser do gitlab.com: {url}")
    return match.group(1)


def _client() -> httpx.Client:
    token = os.getenv("GITLAB_TOKEN")
    if not token:
        raise GitlabError(
            "GITLAB_TOKEN não está configurado — crie backend/.env com GITLAB_TOKEN=<seu token> e reinicie o backend."
        )
    return httpx.Client(base_url=API_BASE, headers={"PRIVATE-TOKEN": token}, timeout=10.0)


def _raise_for_status(response: httpx.Response) -> None:
    if response.status_code < 400:
        return
    try:
        message = response.json().get("message", response.text)
    except ValueError:
        message = response.text
    raise GitlabError(f"GitLab respondeu {response.status_code}: {message}")


def find_open_mr(project_path: str, source_branch: str) -> dict | None:
    """Primeiro MR aberto com essa branch como origem, ou `None` — usado
    pra não abrir um MR duplicado quando já existe um em andamento."""
    encoded = quote(project_path, safe="")
    try:
        with _client() as client:
            response = client.get(
                f"/projects/{encoded}/merge_requests",
                params={"source_branch": source_branch, "state": "opened"},
            )
    except httpx.HTTPError as exc:
        raise GitlabError(f"Falha ao consultar MRs no GitLab: {exc}") from exc
    _raise_for_status(response)
    results = response.json()
    return results[0] if results else None


def create_mr(project_path: str, source_branch: str, target_branch: str, title: str, description: str) -> dict:
    encoded = quote(project_path, safe="")
    try:
        with _client() as client:
            response = client.post(
                f"/projects/{encoded}/merge_requests",
                json={
                    "source_branch": source_branch,
                    "target_branch": target_branch,
                    "title": title,
                    "description": description,
                },
            )
    except httpx.HTTPError as exc:
        raise GitlabError(f"Falha ao criar MR no GitLab: {exc}") from exc
    _raise_for_status(response)
    return response.json()
