import { useEffect, useState } from 'react';
import { FiAlertTriangle, FiCheckCircle } from 'react-icons/fi';
import { VscSourceControl } from 'react-icons/vsc';
import { api } from '../api/client';

const POLL_INTERVAL_MS = 10000;

interface GitStatus {
  currentBranch: string | null;
  devBranch: string | null;
  upToDate: boolean | null;
  uncommittedCount: number | null;
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

  const loading = status === null;

  if (!loading && !status.currentBranch) return null;

  const hasChanges = !loading && (status.uncommittedCount ?? 0) > 0;

  return (
    <span className="git-status-row">
      <span
        className={`git-changes-indicator${loading ? ' is-loading' : hasChanges ? ' has-changes' : ''}`}
        title={
          loading
            ? 'Carregando mudanças…'
            : status.uncommittedCount === null
              ? 'Não foi possível checar mudanças não commitadas'
              : hasChanges
                ? `${status.uncommittedCount} arquivo(s) com mudanças não commitadas`
                : 'Sem mudanças não commitadas'
        }
      >
        <VscSourceControl />
        {hasChanges && <span className="git-changes-badge">{status.uncommittedCount}</span>}
      </span>
      <span
        className={`git-status-badge${loading ? ' git-status-loading' : ''}`}
        title={
          loading
            ? 'Carregando branch…'
            : status.upToDate === null
              ? `Branch atual: ${status.currentBranch}`
              : status.upToDate
                ? `Branch atual: ${status.currentBranch} — em dia com ${status.devBranch}`
                : `Branch atual: ${status.currentBranch} — atrás de ${status.devBranch}`
        }
      >
        {!loading && status.upToDate === true && <FiCheckCircle className="git-status-icon git-status-up-to-date" />}
        {!loading && status.upToDate === false && <FiAlertTriangle className="git-status-icon git-status-behind" />}
        {loading ? 'Carregando branch…' : status.currentBranch}
      </span>
    </span>
  );
}
