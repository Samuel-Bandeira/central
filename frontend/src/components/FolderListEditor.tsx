import { useState } from 'react';
import type { Folder } from '../types';
import { api } from '../api/client';

interface Props {
  folders: Folder[];
  onChange: (folders: Folder[]) => void;
}

export function FolderListEditor({ folders, onChange }: Props) {
  const [pickingIndex, setPickingIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function update(index: number, field: keyof Folder, value: string) {
    onChange(folders.map((f, i) => (i === index ? { ...f, [field]: value } : f)));
  }

  function add() {
    onChange([...folders, { name: '', path: '' }]);
  }

  function remove(index: number) {
    onChange(folders.filter((_, i) => i !== index));
  }

  async function pickPath(index: number) {
    setPickingIndex(index);
    setError(null);
    try {
      const { path } = await api.pickFolder();
      if (!path) return;
      const suggestedName = folders[index].name.trim() || path.split('/').filter(Boolean).pop() || '';
      onChange(folders.map((f, i) => (i === index ? { ...f, path, name: suggestedName } : f)));
    } catch (err) {
      setError(String(err));
    } finally {
      setPickingIndex(null);
    }
  }

  return (
    <div className="field">
      <span>Pastas</span>
      {folders.map((folder, i) => (
        <div className="folder-row" key={i}>
          <input placeholder="nome (ex: frontend)" value={folder.name} onChange={(e) => update(i, 'name', e.target.value)} />
          <input placeholder="caminho absoluto" value={folder.path} onChange={(e) => update(i, 'path', e.target.value)} />
          <button type="button" className="btn" onClick={() => pickPath(i)} disabled={pickingIndex === i}>
            {pickingIndex === i ? '...' : 'Selecionar...'}
          </button>
          <button type="button" className="btn" onClick={() => remove(i)} aria-label="Remover pasta">
            ×
          </button>
        </div>
      ))}
      <button type="button" className="btn" onClick={add}>
        + Adicionar pasta
      </button>
      {error && <p className="pending-note field-error">Não foi possível abrir o seletor de pastas: {error}</p>}
    </div>
  );
}
