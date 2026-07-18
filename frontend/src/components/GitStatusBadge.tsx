import { useEffect, useState } from 'react';
import { FiAlertTriangle, FiCheckCircle } from 'react-icons/fi';
import { api } from '../api/client';

const POLL_INTERVAL_MS = 10000;

interface GitStatus {
  currentBranch: string | null;
  devBranch: string | null;
  upToDate: boolean | null;
}

interface Props {
  projectId: string;
}

export function GitStatusBadge({ projectId }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    function poll() {
      api
        .getGitStatus(projectId)
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {
          // projeto pode não ser um repo git — sem indicativo, sem erro
        });
    }
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [projectId]);

  if (status === null) {
    return <span className="git-status-badge git-status-loading">Carregando branch…</span>;
  }

  if (!status.currentBranch) return null;

  return (
    <span
      className="git-status-badge"
      title={
        status.upToDate === null
          ? `Branch atual: ${status.currentBranch}`
          : status.upToDate
            ? `Branch atual: ${status.currentBranch} — em dia com ${status.devBranch}`
            : `Branch atual: ${status.currentBranch} — atrás de ${status.devBranch}`
      }
    >
      {status.upToDate === true && <FiCheckCircle className="git-status-icon git-status-up-to-date" />}
      {status.upToDate === false && <FiAlertTriangle className="git-status-icon git-status-behind" />}
      {status.currentBranch}
    </span>
  );
}
