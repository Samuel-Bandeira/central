import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface Props {
  folderPath: string | undefined;
  value: string;
  onChange: (value: string) => void;
}

export function DevBranchSelect({ folderPath, value, onChange }: Props) {
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!folderPath) {
      setBranches([]);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .getGitBranches(folderPath)
      .then(({ branches }) => {
        if (!cancelled) setBranches(branches);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [folderPath]);

  if (!folderPath) {
    return <p className="pending-note">Cadastre uma pasta do projeto primeiro pra listar as branches.</p>;
  }

  // Se não der pra listar (ex: pasta ainda não é um repo git), cai pra
  // texto livre em vez de travar a configuração.
  if (loadError) {
    return (
      <>
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="ex: develop, ou main" />
        <span className="field-hint field-error">Não consegui listar as branches ({loadError}) — digite manualmente.</span>
      </>
    );
  }

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={loading}>
      <option value="" disabled>
        {loading ? 'Carregando...' : 'Selecione a branch'}
      </option>
      {value && !branches.includes(value) && <option value={value}>{value} (atual)</option>}
      {branches.map((b) => (
        <option key={b} value={b}>
          {b}
        </option>
      ))}
    </select>
  );
}
