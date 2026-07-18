import { useState } from 'react';
import type { Folder, ProjectInput } from '../types';
import { DevBranchSelect } from './DevBranchSelect';
import { FolderListEditor } from './FolderListEditor';

interface Props {
  onClose: () => void;
  onCreate: (input: ProjectInput) => Promise<void>;
}

export function NewProjectModal({ onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [folders, setFolders] = useState<Folder[]>([{ name: '', path: '' }]);
  const [runCommand, setRunCommand] = useState('');
  const [devBranch, setDevBranch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('O nome do projeto é obrigatório');
      return;
    }
    if (!devBranch.trim()) {
      setError('A branch de desenvolvimento é obrigatória — é a partir dela que as atividades com Claude vão partir');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        folders: folders.filter((f) => f.name.trim() && f.path.trim()),
        runCommand: runCommand.trim() || undefined,
        devBranch: devBranch.trim(),
      });
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <h2>Novo projeto</h2>

        <label className="field">
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>

        <FolderListEditor folders={folders} onChange={setFolders} />

        <label className="field">
          Branch de desenvolvimento
          <DevBranchSelect folderPath={folders[0]?.path.trim() || undefined} value={devBranch} onChange={setDevBranch} />
          <span className="field-hint">É a partir dela que as atividades com Claude criam a branch de cada tarefa.</span>
        </label>

        <label className="field">
          Comando de execução (opcional)
          <textarea
            className="run-command-input"
            placeholder={'npm run dev\n\nou várias linhas, ex:\nsource .venv/bin/activate\nuvicorn app.main:app --reload'}
            rows={3}
            value={runCommand}
            onChange={(e) => setRunCommand(e.target.value)}
          />
          <span className="field-hint">Aceita múltiplas linhas — roda como um script shell quando a seção é iniciada.</span>
        </label>

        {error && <p className="pending-note field-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Criando...' : 'Criar projeto'}
          </button>
        </div>
      </form>
    </div>
  );
}
