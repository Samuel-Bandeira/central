import type { Tab } from '../App';
import type { Project } from '../types';

interface Props {
  tabs: Tab[];
  activeTabId: string;
  projects: Project[];
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

export function TabBar({ tabs, activeTabId, projects, onSelect, onClose }: Props) {
  return (
    <div className="tabbar">
      {tabs.map((tab) => {
        const label = tab.kind === 'projects' ? 'Projetos' : projects.find((p) => p.id === tab.projectId)?.name ?? 'Projeto removido';
        return (
          <div key={tab.id} className={`tab ${tab.id === activeTabId ? 'tab-active' : ''}`} onClick={() => onSelect(tab.id)}>
            <span>{label}</span>
            {tab.kind === 'detail' && (
              <button
                type="button"
                className="tab-close"
                aria-label={`Fechar aba ${label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
