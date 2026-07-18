import { useCallback, useEffect, useState } from 'react';
import { api } from './api/client';
import type { Project, Section } from './types';
import { TabBar } from './components/TabBar';
import { ProjectsTab } from './pages/ProjectsTab';
import { ProjectDetailTab } from './pages/ProjectDetailTab';
import { ActivitiesTab } from './pages/ActivitiesTab';
import { TrelloTab } from './pages/TrelloTab';

export type Tab =
  | { id: 'projects'; kind: 'projects' }
  | { id: string; kind: 'detail'; projectId: string }
  | { id: string; kind: 'activities'; projectId: string }
  | { id: string; kind: 'trello'; projectId: string };

const TABS_STORAGE_KEY = 'central-launcher.tabs';
const DEFAULT_TABS: Tab[] = [{ id: 'projects', kind: 'projects' }];

function loadStoredTabsState(): { tabs: Tab[]; activeTabId: string } {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) return { tabs: DEFAULT_TABS, activeTabId: 'projects' };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return { tabs: DEFAULT_TABS, activeTabId: 'projects' };
    return { tabs: parsed.tabs, activeTabId: parsed.activeTabId ?? parsed.tabs[0].id };
  } catch {
    return { tabs: DEFAULT_TABS, activeTabId: 'projects' };
  }
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>(() => loadStoredTabsState().tabs);
  const [activeTabId, setActiveTabId] = useState(() => loadStoredTabsState().activeTabId);

  useEffect(() => {
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({ tabs, activeTabId }));
  }, [tabs, activeTabId]);

  const refreshProjects = useCallback(async () => {
    setProjects(await api.listProjects());
  }, []);

  const refreshSections = useCallback(async () => {
    setSections(await api.listSections());
  }, []);

  useEffect(() => {
    Promise.all([refreshProjects(), refreshSections()])
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [refreshProjects, refreshSections]);

  function openDetailTab(project: Project) {
    const tabId = `detail-${project.id}`;
    setTabs((prev) => (prev.some((t) => t.id === tabId) ? prev : [...prev, { id: tabId, kind: 'detail', projectId: project.id }]));
    setActiveTabId(tabId);
  }

  function openActivitiesTab(project: Project) {
    const tabId = `activities-${project.id}`;
    setTabs((prev) => (prev.some((t) => t.id === tabId) ? prev : [...prev, { id: tabId, kind: 'activities', projectId: project.id }]));
    setActiveTabId(tabId);
  }

  function openTrelloTab(project: Project) {
    const tabId = `trello-${project.id}`;
    setTabs((prev) => (prev.some((t) => t.id === tabId) ? prev : [...prev, { id: tabId, kind: 'trello', projectId: project.id }]));
    setActiveTabId(tabId);
  }

  function closeTab(tabId: string) {
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
    setActiveTabId((current) => (current === tabId ? 'projects' : current));
  }

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  return (
    <div className="app">
      <TabBar tabs={tabs} activeTabId={activeTabId} projects={projects} onSelect={setActiveTabId} onClose={closeTab} />
      <div className="tab-content">
        {loading && <p className="pending-note">Carregando...</p>}
        {error && <p className="pending-note">Erro ao carregar dados: {error}</p>}
        {!loading && !error && activeTab.kind === 'projects' && (
          <ProjectsTab
            projects={projects}
            sections={sections}
            onProjectsChange={refreshProjects}
            onSectionsChange={refreshSections}
            onOpenDetail={openDetailTab}
            onOpenActivities={openActivitiesTab}
            onOpenTrello={openTrelloTab}
          />
        )}
        {!loading && !error && activeTab.kind === 'detail' && (
          <ProjectDetailTab
            key={activeTab.projectId}
            project={projects.find((p) => p.id === activeTab.projectId) ?? null}
            onProjectsChange={refreshProjects}
          />
        )}
        {!loading && !error && activeTab.kind === 'activities' && (
          <ActivitiesTab
            key={activeTab.projectId}
            project={projects.find((p) => p.id === activeTab.projectId) ?? null}
            allProjects={projects}
          />
        )}
        {!loading && !error && activeTab.kind === 'trello' && (
          <TrelloTab
            key={activeTab.projectId}
            project={projects.find((p) => p.id === activeTab.projectId) ?? null}
            onProjectsChange={refreshProjects}
          />
        )}
      </div>
    </div>
  );
}

export default App;
