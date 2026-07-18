import type { Tab } from '../App';
import type { Project } from '../types';

interface Props {
  tabs: Tab[];
  activeTabId: string;
  projects: Project[];
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

const KIND_SUFFIX: Record<Exclude<Tab['kind'], 'projects'>, string> = {
  detail: '',
  activities: ' · Claude',
  trello: ' · Trello',
};

export function TabBar({ tabs, activeTabId, projects, onSelect, onClose }: Props) {
  return (
    <div className="tabbar">
      {tabs.map((tab) => {
        const label =
          tab.kind === 'projects'
            ? 'Projetos'
            : (projects.find((p) => p.id === tab.projectId)?.name ?? 'Projeto removido') + KIND_SUFFIX[tab.kind];
        return (
          <div key={tab.id} className={`tab ${tab.id === activeTabId ? 'tab-active' : ''}`} onClick={() => onSelect(tab.id)}>
            <span>{label}</span>
            {tab.kind !== 'projects' && (
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
