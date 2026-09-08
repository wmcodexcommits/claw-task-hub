import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  AlertTriangle,
  Box,
  CheckCircle2,
  Circle,
  CircleDot,
  Clock3,
  Database,
  Diamond,
  Flag,
  FolderOpen,
  Layers,
  Link,
  ListFilter,
  MessageSquarePlus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { design } from "./styles/design-system.js";
import "./App.css";

type ProjectHealth = "on_track" | "at_risk" | "off_track" | "complete";

type Project = {
  id: string;
  external_id?: string | null;
  name: string;
  summary?: string | null;
  description?: string | null;
  status: string;
  priority: number;
  lead?: string | null;
  target_date?: string | null;
  source: string;
  updated_at: string;
  issue_count: number;
  done_count?: number;
  active_count?: number;
  blocker_count?: number;
  health?: ProjectHealth | null;
  latest_update_body?: string | null;
  latest_update_at?: string | null;
};

type Issue = {
  id: string;
  external_id?: string | null;
  identifier?: string;
  title: string;
  description?: string;
  status: string;
  status_type: IssueStatusType;
  priority: number;
  assignee?: string | null;
  project_id?: string;
  project_name?: string;
  team_name?: string;
  labels: string[];
  updated_at: string;
  active_claim_count?: number;
  active_claim_agent?: string | null;
  active_claim_harness?: string | null;
  active_claims?: IssueClaim[];
  last_acceptance_at?: string | null;
  last_acceptance_comment?: IssueComment | null;
  comments?: IssueComment[];
  blocker_count?: number;
  blocking_count?: number;
  dependencies?: IssueDependency[];
  blocking?: IssueDependency[];
};

type IssueComment = { id: string; body: string; author: string; created_at: string };

type IssueDependency = {
  id: string;
  status: "open" | "resolved";
  reason?: string | null;
  blocker_identifier: string;
  blocker_title: string;
  resolved_at?: string | null;
};

type ProjectUpdate = {
  id: string;
  body: string;
  health: ProjectHealth;
  author?: string | null;
  created_at: string;
};

type IssueClaim = {
  id: string;
  session_id: string;
  agent_name: string;
  harness?: string | null;
  note?: string | null;
  claimed_at?: string;
  expires_at: string;
};

type AppPage = "projects" | "workspace" | "project";
type ProjectTab = "overview" | "activity" | "issues";
type StatusMode = "all" | "active" | "started" | "paused" | "backlog" | "todo" | "blockers" | "completed" | "canceled";
type IssueDisplayLimit = "50" | "100" | "200" | "all";
type IssueStatusType = "started" | "blocked" | "paused" | "backlog" | "unstarted" | "completed" | "canceled";
type IssueDraftPriority = "1" | "2" | "3" | "4";
type IssuePriorityFilter = "all" | "1" | "2" | "3" | "4";
type ProjectStatusFilter = "all" | "active" | "paused" | "backlog" | "completed";
type ProjectHealthFilter = "all" | ProjectHealth | "none";
type ProjectSort = "updated" | "name" | "priority" | "target_date" | "issues";

type ContextBinding = {
  id: string;
  context_key: string;
  project_id: string;
  project_name?: string;
  default_tab: ProjectTab;
  url_path: string;
};

type ContextResolution = {
  binding: ContextBinding | null;
  project: Project | null;
  url_path: string | null;
};

type RouteDescriptor = {
  kind: "projects" | "workspace" | "project" | "issue" | "context";
  projectId?: string;
  issueId?: string;
  contextKey?: string;
  tab: ProjectTab;
  tabExplicit?: boolean;
  statusMode: StatusMode;
  query: string;
  issueDisplayLimit: IssueDisplayLimit;
  priorityFilter: IssuePriorityFilter;
  assigneeFilter: string;
  labelFilter: string;
};

type ApiIssueGroup = {
  key: string;
  status_type: IssueStatusType;
  label: string;
  total: number;
  returned: number;
  truncated: boolean;
  issues: Issue[];
};

type UiIssueGroup = {
  key: string;
  statusType: IssueStatusType;
  label: string;
  total: number;
  returned: number;
  truncated: boolean;
  items: Issue[];
};

type ActivityEvent = {
  id: string;
  identifier?: string;
  title: string;
  status: string;
  status_type: string;
  priority: number;
  updated_at: string;
  type: "issue" | "comment" | "dependency" | "project_update";
  verb: "completed" | "started" | "blocker" | "unblocked" | "updated" | "commented" | "project_updated";
  author?: string;
  body?: string;
  health?: ProjectUpdate["health"];
  blocker_identifier?: string;
  blocker_title?: string;
};

type ProjectDetail = {
  project: Project;
  counts: { total: number; done: number; started: number; open: number; blockers: number };
  statusCounts: { status: string; status_type: string; count: number }[];
  priorityCounts: { priority: number; count: number }[];
  issues: Issue[];
  issueGroups?: ApiIssueGroup[];
  issueDisplayLimit?: IssueDisplayLimit;
  projectUpdates: ProjectUpdate[];
  activity: ActivityEvent[];
};

type ManagedDatabase = {
  id: string;
  name: string;
  fileName: string;
  path: string;
  active: boolean;
};

type DatabaseCatalogue = {
  active: ManagedDatabase;
  databases: ManagedDatabase[];
};

type RefreshSnapshot = {
  refreshed_at: string;
  projects: Project[];
  issues: Issue[];
  issueGroups: ApiIssueGroup[];
  issueDisplayLimit: IssueDisplayLimit;
  databases: DatabaseCatalogue;
  includes_issues: boolean;
};

type HealthState = "unknown" | "checking" | "healthy" | "error";

const apiBase = import.meta.env.VITE_CLAW_TASK_HUB_API_BASE ?? "http://127.0.0.1:4781/api";
const displayDateLocale = "en-US";
const defaultIssueDisplayLimit: IssueDisplayLimit = "50";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

async function fetchProjectDetail(projectId: string, issueLimit: IssueDisplayLimit): Promise<ProjectDetail> {
  return api<ProjectDetail>(`/projects/${encodeURIComponent(projectId)}?issues_per_status=${encodeURIComponent(issueLimit)}`);
}

async function fetchRefreshSnapshot(issueLimit: IssueDisplayLimit, includeIssues: boolean, explicitRefresh: boolean): Promise<RefreshSnapshot> {
  const refreshParams = new URLSearchParams({
    issues_per_status: String(issueLimit),
    include_issues: String(includeIssues),
  });
  try {
    return explicitRefresh
      ? await api<RefreshSnapshot>("/refresh", {
          method: "POST",
          body: JSON.stringify({ issues_per_status: issueLimit, include_issues: includeIssues }),
        })
      : await api<RefreshSnapshot>(`/snapshot?${refreshParams.toString()}`);
  } catch {
    // Keep the UI usable while an already-running local API is being upgraded.
    const [projectsResult, issuesResult, databases] = await Promise.all([
      api<{ projects: Project[] }>("/projects"),
      includeIssues
        ? api<{ issues: Issue[]; issueGroups?: ApiIssueGroup[] }>(`/issues?per_status_limit=${encodeURIComponent(issueLimit)}`)
        : Promise.resolve({ issues: [], issueGroups: [] }),
      api<DatabaseCatalogue>("/databases").catch(() => ({
        active: { id: "configured.sqlite", name: "claw-task-hub", fileName: "configured.sqlite", path: "", active: true },
        databases: [],
      })),
    ]);
    return {
      refreshed_at: new Date().toISOString(),
      projects: projectsResult.projects,
      issues: issuesResult.issues,
      issueGroups: issuesResult.issueGroups ?? [],
      issueDisplayLimit: issueLimit,
      databases,
      includes_issues: includeIssues,
    };
  }
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaceIssues, setWorkspaceIssues] = useState<Issue[]>([]);
  const [workspaceIssueGroups, setWorkspaceIssueGroups] = useState<ApiIssueGroup[]>([]);
  const [projectDetail, setProjectDetail] = useState<ProjectDetail | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
  const [serverSearchResult, setServerSearchResult] = useState<{ scope: string; query: string; issues: Issue[] } | null>(null);
  const [page, setPage] = useState<AppPage>("projects");
  const [tab, setTab] = useState<ProjectTab>("overview");
  const [query, setQuery] = useState("");
  const [statusMode, setStatusMode] = useState<StatusMode>("all");
  const [issueDisplayLimit, setIssueDisplayLimit] = useState<IssueDisplayLimit>(defaultIssueDisplayLimit);
  const [issueDraftPriority, setIssueDraftPriority] = useState<IssueDraftPriority>("3");
  const [issuePriorityFilter, setIssuePriorityFilter] = useState<IssuePriorityFilter>("all");
  const [issueAssigneeFilter, setIssueAssigneeFilter] = useState("all");
  const [issueLabelFilter, setIssueLabelFilter] = useState("all");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [issueEditorOpen, setIssueEditorOpen] = useState(false);
  const [projectEditorOpen, setProjectEditorOpen] = useState(false);
  const [projectSaving, setProjectSaving] = useState(false);
  const [databaseEditorOpen, setDatabaseEditorOpen] = useState(false);
  const [databaseSaving, setDatabaseSaving] = useState(false);
  const [databaseError, setDatabaseError] = useState<string | null>(null);
  const [databaseDeleteTarget, setDatabaseDeleteTarget] = useState<ManagedDatabase | null>(null);
  const [databaseDeleting, setDatabaseDeleting] = useState(false);
  const [databaseDeleteError, setDatabaseDeleteError] = useState<string | null>(null);
  const [databaseCatalogue, setDatabaseCatalogue] = useState<DatabaseCatalogue | null>(null);
  const [healthState, setHealthState] = useState<HealthState>("unknown");
  const [darkMode, setDarkMode] = useState(() => window.localStorage.getItem("claw-task-hub-theme") !== "light");
  const [projectFiltersOpen, setProjectFiltersOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [projectStatusFilter, setProjectStatusFilter] = useState<ProjectStatusFilter>("all");
  const [projectHealthFilter, setProjectHealthFilter] = useState<ProjectHealthFilter>("all");
  const [projectSort, setProjectSort] = useState<ProjectSort>("updated");
  const pageRef = useRef<AppPage>("projects");
  const issueDisplayLimitRef = useRef<IssueDisplayLimit>(defaultIssueDisplayLimit);
  const projectDetailRef = useRef<ProjectDetail | null>(null);
  const selectedIssueRef = useRef<Issue | null>(null);
  const routeApplyingRef = useRef(false);
  const [routingReady, setRoutingReady] = useState(false);
  const refreshInFlightRef = useRef(false);
  const lastRefreshStartedAtRef = useRef(0);
  const refreshGenerationRef = useRef(0);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  useEffect(() => {
    projectDetailRef.current = projectDetail;
  }, [projectDetail]);

  useEffect(() => {
    selectedIssueRef.current = selectedIssue;
  }, [selectedIssue]);

  useEffect(() => {
    issueDisplayLimitRef.current = issueDisplayLimit;
  }, [issueDisplayLimit]);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    window.localStorage.setItem("claw-task-hub-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  const applyRouteFromLocation = useCallback(async () => {
    const route = parseRoute(window.location);
    routeApplyingRef.current = true;
    issueDisplayLimitRef.current = route.issueDisplayLimit;
    setIssueDisplayLimit(route.issueDisplayLimit);
    setQuery(route.query);
    setStatusMode(route.statusMode);
    setIssuePriorityFilter(route.priorityFilter);
    setIssueAssigneeFilter(route.assigneeFilter);
    setIssueLabelFilter(route.labelFilter);
    setCreateError(null);
    try {
      if (route.kind === "project" && route.projectId) {
        const detail = await fetchProjectDetail(route.projectId, route.issueDisplayLimit);
        setProjectDetail(detail);
        setSelectedIssue(detail.issues[0] ?? null);
        setPage("project");
        setTab(route.tab);
        return;
      }
      if (route.kind === "issue" && route.issueId) {
        const issue = await api<{ issue: Issue }>(`/issues/${encodeURIComponent(route.issueId)}`);
        if (issue.issue.project_id) {
          const detail = await fetchProjectDetail(issue.issue.project_id, route.issueDisplayLimit);
          setProjectDetail(detail);
          setSelectedIssue(issue.issue);
          setPage("project");
          setTab("issues");
        } else {
          setProjectDetail(null);
          setSelectedIssue(issue.issue);
          setPage("workspace");
          setTab("issues");
        }
        return;
      }
      if (route.kind === "context" && route.contextKey) {
        const resolution = await api<ContextResolution>(`/context-bindings/resolve?context_key=${encodeURIComponent(route.contextKey)}`);
        if (resolution.project?.id) {
          const detail = await fetchProjectDetail(resolution.project.id, route.issueDisplayLimit);
          setProjectDetail(detail);
          setSelectedIssue(detail.issues[0] ?? null);
          setPage("project");
          setTab(route.tabExplicit ? route.tab : parseProjectTab(resolution.binding?.default_tab) ?? "issues");
          return;
        }
      }
      if (route.kind === "workspace") {
        setProjectDetail(null);
        setSelectedIssue(null);
        setPage("workspace");
        setTab("issues");
        return;
      }
      setProjectDetail(null);
      setSelectedIssue(null);
      setPage("projects");
      setTab("overview");
    } catch (error) {
      setProjectDetail(null);
      setSelectedIssue(null);
      setPage("projects");
      setTab("overview");
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      routeApplyingRef.current = false;
      setRoutingReady(true);
    }
  }, []);

  useEffect(() => {
    const initialRouteTimer = window.setTimeout(() => {
      void applyRouteFromLocation();
    }, 0);
    const onPopState = () => {
      void applyRouteFromLocation();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.clearTimeout(initialRouteTimer);
      window.removeEventListener("popstate", onPopState);
    };
  }, [applyRouteFromLocation]);

  useEffect(() => {
    if (!routingReady || routeApplyingRef.current) return;
    const path = currentRoutePath({
      page,
      projectId: projectDetail?.project.id,
      tab,
      query,
      statusMode,
      issueDisplayLimit,
      priorityFilter: issuePriorityFilter,
      assigneeFilter: issueAssigneeFilter,
      labelFilter: issueLabelFilter,
    });
    replaceBrowserPath(path);
  }, [issueAssigneeFilter, issueDisplayLimit, issueLabelFilter, issuePriorityFilter, page, projectDetail?.project.id, query, routingReady, statusMode, tab]);

  const refresh = useCallback(async (force = false, explicitRefresh = false) => {
    if (refreshInFlightRef.current) return;
    const startedAt = Date.now();
    if (!force && startedAt - lastRefreshStartedAtRef.current < 1200) return;
    lastRefreshStartedAtRef.current = startedAt;
    refreshInFlightRef.current = true;
    const snapshot = {
      page: pageRef.current,
      projectId: projectDetailRef.current?.project.id,
      issueId: selectedIssueRef.current?.id,
      issueDisplayLimit: issueDisplayLimitRef.current,
    };
    const generation = ++refreshGenerationRef.current;
    try {
      const [fresh, detail, selected] = await Promise.all([
        fetchRefreshSnapshot(snapshot.issueDisplayLimit, snapshot.page === "workspace", explicitRefresh),
        snapshot.page === "project" && snapshot.projectId
          ? api<ProjectDetail>(`/projects/${encodeURIComponent(snapshot.projectId)}?issues_per_status=${encodeURIComponent(snapshot.issueDisplayLimit)}`)
          : Promise.resolve(null),
        snapshot.issueId ? api<{ issue: Issue }>(`/issues/${encodeURIComponent(snapshot.issueId)}`).catch(() => null) : Promise.resolve(null),
      ]);
      if (generation !== refreshGenerationRef.current) return;
      setDatabaseCatalogue(fresh.databases);
      setProjects(fresh.projects);
      if (fresh.includes_issues) {
        setWorkspaceIssues(fresh.issues);
        setWorkspaceIssueGroups(fresh.issueGroups);
      }
      const samePage = pageRef.current === snapshot.page;
      const sameProject = projectDetailRef.current?.project.id === snapshot.projectId;
      const sameIssueContext = samePage && (snapshot.page !== "project" || sameProject);
      if (detail && samePage && sameProject) setProjectDetail(detail);
      if (selected?.issue && sameIssueContext && selectedIssueRef.current?.id === snapshot.issueId) setSelectedIssue(selected.issue);
      else if (snapshot.issueId && detail && sameIssueContext && selectedIssueRef.current?.id === snapshot.issueId) {
        setSelectedIssue(detail.issues.find((issue) => issue.id === snapshot.issueId) ?? detail.issues[0] ?? null);
      }
    } finally {
      if (generation === refreshGenerationRef.current) refreshInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    const events = new EventSource(`${apiBase}/events`);
    const handleRefresh = () => void refresh(true);
    events.addEventListener("data-refresh", handleRefresh);
    return () => {
      events.removeEventListener("data-refresh", handleRefresh);
      events.close();
    };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    const pollHealth = async () => {
      if (active) setHealthState("checking");
      try {
        await api<{ ok: true }>("/health");
        if (active) setHealthState("healthy");
      } catch {
        if (active) setHealthState("error");
      }
    };
    void pollHealth();
    const timer = window.setInterval(() => void pollHealth(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const projectId = page === "project" ? projectDetail?.project.id : undefined;
    const scope = `${page}:${projectId ?? ""}`;
    const params = new URLSearchParams({ query: trimmed, limit: "250" });
    if (projectId) params.set("project_id", projectId);
    let cancelled = false;
    api<{ issues: Issue[] }>(`/issues?${params.toString()}`)
      .then((result) => {
        if (!cancelled) setServerSearchResult({ scope, query: trimmed, issues: result.issues });
      })
      .catch(() => {
        if (!cancelled) setServerSearchResult({ scope, query: trimmed, issues: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [page, projectDetail?.project.id, query]);

  async function openProject(project: Project, nextTab: ProjectTab = "overview") {
    const detail = await fetchProjectDetail(project.id, issueDisplayLimitRef.current);
    setProjectDetail(detail);
    setSelectedIssue(detail.issues[0] ?? null);
    setPage("project");
    setTab(nextTab);
    setQuery("");
    setStatusMode("all");
    setIssuePriorityFilter("all");
    setIssueAssigneeFilter("all");
    setIssueLabelFilter("all");
    setCreateError(null);
    pushBrowserPath(projectRoutePath(project.id, nextTab));
  }

  function openProjectsPage() {
    pageRef.current = "projects";
    setPage("projects");
    setProjectDetail(null);
    setSelectedIssue(null);
    setCreateError(null);
    pushBrowserPath("/projects");
  }

  function openWorkspacePage() {
    pageRef.current = "workspace";
    setPage("workspace");
    setProjectDetail(null);
    setSelectedIssue(workspaceIssues[0] ?? null);
    setTab("issues");
    setQuery("");
    setStatusMode("all");
    setIssuePriorityFilter("all");
    setIssueAssigneeFilter("all");
    setIssueLabelFilter("all");
    setCreateError(null);
    pushBrowserPath(workspaceRoutePath({ query: "", statusMode: "all", issueDisplayLimit, priorityFilter: "all", assigneeFilter: "all", labelFilter: "all" }));
    void refresh(true);
  }

  function changeTab(nextTab: ProjectTab) {
    setTab(nextTab);
    if (projectDetailRef.current?.project.id) {
      pushBrowserPath(projectRoutePath(projectDetailRef.current.project.id, nextTab, {
        query,
        statusMode,
        issueDisplayLimit,
        priorityFilter: issuePriorityFilter,
        assigneeFilter: issueAssigneeFilter,
        labelFilter: issueLabelFilter,
      }));
    }
  }

  function changeIssueDisplayLimit(value: IssueDisplayLimit) {
    issueDisplayLimitRef.current = value;
    setIssueDisplayLimit(value);
    void refresh(true);
  }

  async function openIssue(issue: Issue, reveal = false) {
    const detail = await api<{ issue: Issue }>(`/issues/${encodeURIComponent(issue.id)}`);
    setSelectedIssue(detail.issue);
    if (reveal) {
      pushBrowserPath(issueRoutePath(detail.issue));
      setDetailOpen(true);
    }
  }

  async function createIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
    if (!title) return;
    if (!projectDetail?.project.id) {
      setCreateError("Open a project before creating an issue.");
      return;
    }
    setCreateError(null);
    setCreating(true);
    try {
      const created = await api<{ issue: Issue }>("/issues", {
        method: "POST",
        body: JSON.stringify({
          title,
          description: String(data.get("description") ?? ""),
          project_id: projectDetail.project.id,
          status: "Todo",
          status_type: "unstarted",
          priority: Number(issueDraftPriority),
          labels: ["local"],
        }),
      });
      form.reset();
      setIssueDraftPriority("3");
      setIssueEditorOpen(false);
      await refresh();
      await openIssue(created.issue);
      changeTab("issues");
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    if (!name) return;
    setCreateError(null);
    setProjectSaving(true);
    try {
      const created = await api<{ project: Project }>("/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
          summary: String(data.get("summary") ?? "").trim() || undefined,
          description: String(data.get("description") ?? "").trim() || undefined,
          status: String(data.get("status") ?? "Backlog"),
          priority: Number(data.get("priority") ?? 3),
          lead: String(data.get("lead") ?? "").trim() || null,
          target_date: String(data.get("target_date") ?? "").trim() || null,
          source: "local",
        }),
      });
      form.reset();
      setProjectEditorOpen(false);
      await refresh(true);
      await openProject(created.project);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectSaving(false);
    }
  }

  async function createDatabase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const path = String(data.get("path") ?? "").trim();
    if (!name) return;
    setDatabaseError(null);
    setDatabaseSaving(true);
    try {
      const catalogue = await api<DatabaseCatalogue>("/databases", {
        method: "POST",
        body: JSON.stringify({ name, path: path || undefined }),
      });
      form.reset();
      setDatabaseCatalogue(catalogue);
      setDatabaseEditorOpen(false);
      resetForDatabaseChange();
      await refreshAfterDatabaseChange();
    } catch (error) {
      setDatabaseError(error instanceof Error ? error.message : String(error));
    } finally {
      setDatabaseSaving(false);
    }
  }

  async function activateDatabase(id: string) {
    if (databaseCatalogue?.active.id === id) return;
    setDatabaseError(null);
    try {
      const catalogue = await api<DatabaseCatalogue>(`/databases/${encodeURIComponent(id)}/activate`, {
        method: "POST",
        body: "{}",
      });
      setDatabaseCatalogue(catalogue);
      resetForDatabaseChange();
      await refreshAfterDatabaseChange();
    } catch (error) {
      setDatabaseError(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteDatabase() {
    const target = databaseDeleteTarget;
    if (!target || target.active) return;
    setDatabaseDeleteError(null);
    setDatabaseDeleting(true);
    try {
      const catalogue = await api<DatabaseCatalogue>(`/databases/${encodeURIComponent(target.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ confirm: true }),
      });
      setDatabaseCatalogue(catalogue);
      setDatabaseDeleteTarget(null);
    } catch (error) {
      setDatabaseDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDatabaseDeleting(false);
    }
  }

  function resetForDatabaseChange() {
    setProjects([]);
    setWorkspaceIssues([]);
    setWorkspaceIssueGroups([]);
    setProjectDetail(null);
    setSelectedIssue(null);
    setServerSearchResult(null);
    setPage("projects");
    setTab("overview");
    clearIssueFilters();
    setProjectQuery("");
    setProjectStatusFilter("all");
    setProjectHealthFilter("all");
    replaceBrowserPath("/projects");
  }

  async function refreshAfterDatabaseChange() {
    refreshGenerationRef.current += 1;
    refreshInFlightRef.current = false;
    lastRefreshStartedAtRef.current = 0;
    await refresh(true);
  }

  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedIssue) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = String(data.get("body") ?? "").trim();
    if (!body) return;
    await api(`/issues/${encodeURIComponent(selectedIssue.id)}/comments`, {
      method: "POST",
      body: JSON.stringify({ body, author: "Agent" }),
    });
    form.reset();
    await openIssue(selectedIssue);
  }

  async function postProjectUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectDetail) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = String(data.get("body") ?? "").trim();
    if (!body) return;
    setCreateError(null);
    try {
      await api(`/projects/${encodeURIComponent(projectDetail.project.id)}/updates`, {
        method: "POST",
        body: JSON.stringify({ body, health: String(data.get("health") ?? "on_track"), author: "Agent" }),
      });
      form.reset();
      await refresh(true);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  }

  async function addDependency(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedIssue) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const blockerIssueId = String(data.get("blocker_issue_id") ?? "").trim();
    if (!blockerIssueId) return;
    setCreateError(null);
    try {
      await api(`/issues/${encodeURIComponent(selectedIssue.id)}/dependencies`, {
        method: "POST",
        body: JSON.stringify({ blocker_issue_id: blockerIssueId, reason: String(data.get("reason") ?? "").trim() }),
      });
      form.reset();
      await refresh(true);
      await openIssue(selectedIssue);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  }

  async function resolveDependency(dependencyId: string) {
    if (!selectedIssue) return;
    await api(`/issue-dependencies/${encodeURIComponent(dependencyId)}/resolve`, { method: "POST", body: "{}" });
    await refresh(true);
    await openIssue(selectedIssue);
  }

  async function updateIssueStatus(status: string) {
    if (!selectedIssue) return;
    const result = await api<{ issue: Issue }>("/issues", {
      method: "POST",
      body: JSON.stringify({ issue_id: selectedIssue.id, status }),
    });
    setSelectedIssue(result.issue);
    await refresh(true);
  }

  const searchScope = `${page}:${page === "project" ? projectDetail?.project.id ?? "" : ""}`;
  const trimmedQuery = query.trim();
  const matchingServerSearch =
    trimmedQuery && serverSearchResult?.query === trimmedQuery && serverSearchResult.scope === searchScope ? serverSearchResult.issues : null;
  const sourceIssueGroups = projectDetail?.issueGroups ?? workspaceIssueGroups;
  const loadedIssueSource = useMemo(() => {
    const groupedIssues = sourceIssueGroups.flatMap((group) => group.issues);
    const fallbackIssues = projectDetail?.issues ?? workspaceIssues;
    const unique = new Map<string, Issue>();
    for (const issue of groupedIssues.length ? groupedIssues : fallbackIssues) unique.set(issue.id, issue);
    return [...unique.values()];
  }, [projectDetail?.issues, sourceIssueGroups, workspaceIssues]);
  const issueFilterSource = useMemo(
    () => trimmedQuery ? matchingServerSearch ?? [] : loadedIssueSource,
    [loadedIssueSource, matchingServerSearch, trimmedQuery],
  );
  const issueAssignees = useMemo(
    () => [...new Set(loadedIssueSource.map((issue) => issue.assignee?.trim()).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b)),
    [loadedIssueSource],
  );
  const issueLabels = useMemo(
    () => [...new Set(loadedIssueSource.flatMap((issue) => issue.labels ?? []).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [loadedIssueSource],
  );
  const hasAdvancedIssueFilters = issuePriorityFilter !== "all" || issueAssigneeFilter !== "all" || issueLabelFilter !== "all";
  const filteredIssues = useMemo(() => {
    const lower = trimmedQuery.toLowerCase();
    return issueFilterSource.filter((issue) => {
      const text = [
        issue.id,
        issue.external_id,
        issue.identifier,
        issue.title,
        issue.description,
        issue.assignee,
        issue.project_name,
        issue.team_name,
        ...(issue.labels ?? []),
      ].filter(Boolean).join(" ").toLowerCase();
      const matchesText = !lower || text.includes(lower);
      const statusType = resolveUiStatusType(issue);
      const matchesMode = matchesStatusMode(statusMode, statusType);
      const matchesPriority = issuePriorityFilter === "all" || issue.priority === Number(issuePriorityFilter);
      const matchesAssignee =
        issueAssigneeFilter === "all" ||
        (issueAssigneeFilter === "unassigned" ? !issue.assignee?.trim() : issue.assignee === issueAssigneeFilter);
      const matchesLabel = issueLabelFilter === "all" || issue.labels?.includes(issueLabelFilter);
      return matchesText && matchesMode && matchesPriority && matchesAssignee && matchesLabel;
    });
  }, [issueAssigneeFilter, issueFilterSource, issueLabelFilter, issuePriorityFilter, statusMode, trimmedQuery]);
  const visibleIssueGroups = useMemo(() => {
    if (!trimmedQuery && !hasAdvancedIssueFilters && sourceIssueGroups.length) {
      return sourceIssueGroups
        .map(apiGroupToUiGroup)
        .filter((group) => group.items.length && matchesStatusMode(statusMode, group.statusType));
    }
    return groupIssues(filteredIssues);
  }, [filteredIssues, hasAdvancedIssueFilters, sourceIssueGroups, statusMode, trimmedQuery]);
  const visibleSelectedIssue = selectedIssue && filteredIssues.some((issue) => issue.id === selectedIssue.id)
    ? selectedIssue
    : filteredIssues[0] ?? null;

  useEffect(() => {
    if (page !== "workspace" && (page !== "project" || tab !== "issues")) return;
    const currentIssueId = selectedIssueRef.current?.id;
    if (currentIssueId && filteredIssues.some((issue) => issue.id === currentIssueId)) return;
    const nextIssue = filteredIssues[0] ?? null;
    selectedIssueRef.current = nextIssue;
    setSelectedIssue(nextIssue);
  }, [filteredIssues, page, tab]);

  function downloadProjectShortcut() {
    if (!projectDetail?.project) return;
    downloadShortcut(projectDetail.project, "issues");
  }

  function clearIssueFilters() {
    setQuery("");
    setStatusMode("all");
    setIssuePriorityFilter("all");
    setIssueAssigneeFilter("all");
    setIssueLabelFilter("all");
  }

  return (
    <main className="linear-shell">
      <TopChrome
        catalogue={databaseCatalogue}
        healthState={healthState}
        darkMode={darkMode}
        onNewDatabase={() => {
          setDatabaseError(null);
          setDatabaseEditorOpen(true);
        }}
        onActivateDatabase={activateDatabase}
        onDeleteDatabase={(database) => {
          setDatabaseDeleteError(null);
          setDatabaseDeleteTarget(database);
        }}
        onToggleDarkMode={() => setDarkMode((enabled) => !enabled)}
        onRefresh={() => refresh(true, true)}
      />
      <section className="linear-page">
        <HeaderBar
          page={page}
          tab={tab}
          project={projectDetail?.project}
          onProjects={openProjectsPage}
          onWorkspace={openWorkspacePage}
          onTab={changeTab}
          onProjectShortcut={downloadProjectShortcut}
          projectFiltersOpen={projectFiltersOpen}
          projectSettingsOpen={projectSettingsOpen}
          onToggleProjectFilters={() => setProjectFiltersOpen((open) => !open)}
          onToggleProjectSettings={() => setProjectSettingsOpen((open) => !open)}
          onNewProject={() => {
            setCreateError(null);
            setProjectEditorOpen(true);
          }}
        />

        {page === "projects" ? (
          <ProjectsPage
            projects={projects}
            filtersOpen={projectFiltersOpen}
            settingsOpen={projectSettingsOpen}
            query={projectQuery}
            statusFilter={projectStatusFilter}
            healthFilter={projectHealthFilter}
            sort={projectSort}
            onQuery={setProjectQuery}
            onStatusFilter={setProjectStatusFilter}
            onHealthFilter={setProjectHealthFilter}
            onSort={setProjectSort}
            onClearFilters={() => {
              setProjectQuery("");
              setProjectStatusFilter("all");
              setProjectHealthFilter("all");
            }}
            onOpenProject={openProject}
          />
        ) : page === "workspace" ? (
          <IssuesPage
            title="All issues"
            issues={filteredIssues}
            issueGroups={visibleIssueGroups}
            selectedIssue={visibleSelectedIssue}
            query={query}
            statusMode={statusMode}
            issueDisplayLimit={issueDisplayLimit}
            priorityFilter={issuePriorityFilter}
            assigneeFilter={issueAssigneeFilter}
            labelFilter={issueLabelFilter}
            assignees={issueAssignees}
            labels={issueLabels}
            canCreate={false}
            onQuery={setQuery}
            onStatusMode={setStatusMode}
            onIssueDisplayLimit={changeIssueDisplayLimit}
            onPriorityFilter={setIssuePriorityFilter}
            onAssigneeFilter={setIssueAssigneeFilter}
            onLabelFilter={setIssueLabelFilter}
            onClearFilters={clearIssueFilters}
            onNewIssue={() => setIssueEditorOpen(true)}
            onOpenIssue={openIssue}
            onAddComment={addComment}
            onAddDependency={addDependency}
            onResolveDependency={resolveDependency}
            onStatusChange={updateIssueStatus}
          />
        ) : tab === "overview" && projectDetail ? (
          <ProjectOverview detail={projectDetail} onTab={changeTab} />
        ) : tab === "activity" && projectDetail ? (
          <ProjectActivity detail={projectDetail} onPostUpdate={postProjectUpdate} error={createError} />
        ) : projectDetail ? (
          <IssuesPage
            title={projectDetail.project.name}
            issues={filteredIssues}
            issueGroups={visibleIssueGroups}
            selectedIssue={visibleSelectedIssue}
            query={query}
            statusMode={statusMode}
            issueDisplayLimit={issueDisplayLimit}
            priorityFilter={issuePriorityFilter}
            assigneeFilter={issueAssigneeFilter}
            labelFilter={issueLabelFilter}
            assignees={issueAssignees}
            labels={issueLabels}
            canCreate={true}
            onQuery={setQuery}
            onStatusMode={setStatusMode}
            onIssueDisplayLimit={changeIssueDisplayLimit}
            onPriorityFilter={setIssuePriorityFilter}
            onAssigneeFilter={setIssueAssigneeFilter}
            onLabelFilter={setIssueLabelFilter}
            onClearFilters={clearIssueFilters}
            onNewIssue={() => {
              setCreateError(null);
              setIssueEditorOpen(true);
            }}
            onOpenIssue={openIssue}
            onAddComment={addComment}
            onAddDependency={addDependency}
            onResolveDependency={resolveDependency}
            onStatusChange={updateIssueStatus}
          />
        ) : null}
      </section>
      <footer className="askbar">Ask Claw Task Hub</footer>
      {detailOpen && selectedIssue ? (
        <IssueDialog
          issue={selectedIssue}
          onClose={() => setDetailOpen(false)}
          onAddComment={addComment}
          onAddDependency={addDependency}
          onResolveDependency={resolveDependency}
          onStatusChange={updateIssueStatus}
        />
      ) : null}
      {projectEditorOpen ? (
        <ProjectDialog
          saving={projectSaving}
          error={createError}
          onClose={() => setProjectEditorOpen(false)}
          onSubmit={createProject}
        />
      ) : null}
      {databaseEditorOpen ? (
        <DatabaseDialog
          saving={databaseSaving}
          error={databaseError}
          onClose={() => setDatabaseEditorOpen(false)}
          onSubmit={createDatabase}
        />
      ) : null}
      {databaseDeleteTarget ? (
        <DeleteDatabaseDialog
          database={databaseDeleteTarget}
          deleting={databaseDeleting}
          error={databaseDeleteError}
          onClose={() => {
            if (!databaseDeleting) setDatabaseDeleteTarget(null);
          }}
          onConfirm={() => void deleteDatabase()}
        />
      ) : null}
      {issueEditorOpen && projectDetail ? (
        <NewIssueDialog
          projectName={projectDetail.project.name}
          priority={issueDraftPriority}
          saving={creating}
          error={createError}
          onPriority={setIssueDraftPriority}
          onClose={() => setIssueEditorOpen(false)}
          onSubmit={createIssue}
        />
      ) : null}
    </main>
  );
}

function TopChrome({
  catalogue,
  healthState,
  darkMode,
  onNewDatabase,
  onActivateDatabase,
  onDeleteDatabase,
  onToggleDarkMode,
  onRefresh,
}: {
  catalogue: DatabaseCatalogue | null;
  healthState: HealthState;
  darkMode: boolean;
  onNewDatabase: () => void;
  onActivateDatabase: (id: string) => Promise<void>;
  onDeleteDatabase: (database: ManagedDatabase) => void;
  onToggleDarkMode: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const activeName = catalogue?.active.name ?? "claw-task-hub";
  async function runRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <header className="top-chrome">
      <div className="window-tab">
        <Database size={15} />
        <span>{activeName}</span>
      </div>
      <div className="address">Claw Task Hub</div>
      <button className="top-refresh-pill" aria-label="Refresh data" aria-busy={refreshing} disabled={refreshing} onClick={() => void runRefresh()}>
        <RefreshCw className={refreshing ? "refresh-spin" : undefined} size={14} />
        <span>Refresh data</span>
      </button>
      <span
        className={`ghost-icon health-check ${healthState}`}
        role="status"
        aria-label={healthState === "healthy" ? "Server healthy" : healthState === "error" ? "Server unavailable" : "Checking server health"}
        title={healthState === "healthy" ? "Server healthy" : healthState === "error" ? "Server health check failed" : "Check server health"}
      ><Activity size={16} /></span>
      <div className="toolbar-menu-wrap">
        <button className={menuOpen ? "ghost-icon active" : "ghost-icon"} aria-label="Manage databases" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button>
        {menuOpen ? (
          <div className="toolbar-menu database-menu" role="menu" aria-label="Databases">
            <strong>Databases</strong>
            {(catalogue?.databases ?? []).map((database) => (
              <div className="database-menu-row" key={database.id} role="presentation">
                <button
                  className="database-select"
                  role="menuitemradio"
                  aria-checked={database.active}
                  disabled={database.active}
                  onClick={() => {
                    setMenuOpen(false);
                    void onActivateDatabase(database.id);
                  }}
                  title={database.path}
                >{database.fileName}{database.active ? " (active)" : ""}</button>
                {!database.active ? (
                  <button
                    className="database-delete"
                    role="menuitem"
                    aria-label={`Delete ${database.fileName}`}
                    title={`Delete ${database.fileName}`}
                    onClick={() => {
                      setMenuOpen(false);
                      onDeleteDatabase(database);
                    }}
                  ><Trash2 size={14} /></button>
                ) : null}
              </div>
            ))}
            <button role="menuitem" onClick={() => { setMenuOpen(false); onNewDatabase(); }}>Create database</button>
            <button role="menuitemcheckbox" aria-checked={darkMode} onClick={onToggleDarkMode}>Dark mode {darkMode ? "✓" : ""}</button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

function HeaderBar({
  page,
  tab,
  project,
  onProjects,
  onWorkspace,
  onTab,
  onProjectShortcut,
  projectFiltersOpen,
  projectSettingsOpen,
  onToggleProjectFilters,
  onToggleProjectSettings,
  onNewProject,
}: {
  page: AppPage;
  tab: ProjectTab;
  project?: Project;
  onProjects: () => void;
  onWorkspace: () => void;
  onTab: (tab: ProjectTab) => void;
  onProjectShortcut: () => void;
  projectFiltersOpen: boolean;
  projectSettingsOpen: boolean;
  onToggleProjectFilters: () => void;
  onToggleProjectSettings: () => void;
  onNewProject: () => void;
}) {
  const showProjectTabs = page === "project";
  return (
    <>
      <div className="crumbbar">
        <span className="crumb-icon decorative" aria-hidden="true"><Layers size={15} /></span>
        {page === "projects" ? (
          <strong>Projects</strong>
        ) : page === "workspace" ? (
          <strong>Issues</strong>
        ) : (
          <>
            <button onClick={onProjects}>Projects</button>
            <span>›</span>
            <strong>{project?.name}</strong>
          </>
        )}
        <div className="crumb-actions">
          {project ? (
            <button
              className="project-shortcut-button"
              title="Download project shortcut"
              aria-label="Download project shortcut"
              onClick={onProjectShortcut}
            >
              <Link size={15} />
              <span>Shortcut</span>
            </button>
          ) : null}
          {page === "projects" ? (
            <button className="project-shortcut-button" onClick={onNewProject} aria-label="New project">
              <Plus size={15} />
              <span>New project</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="view-tabs">
        {page === "projects" || page === "workspace" ? (
          <>
            <button className={page === "projects" ? "pill active" : "pill"} aria-current={page === "projects" ? "page" : undefined} onClick={onProjects}>All projects</button>
            <button className={page === "workspace" ? "pill active" : "pill"} aria-current={page === "workspace" ? "page" : undefined} onClick={onWorkspace}>All issues</button>
          </>
        ) : showProjectTabs ? (
          <>
            <button className={tab === "overview" ? "pill active" : "pill"} onClick={() => onTab("overview")}>Overview</button>
            <button className={tab === "activity" ? "pill active" : "pill"} onClick={() => onTab("activity")}>Activity</button>
            <button className={tab === "issues" ? "pill active" : "pill"} onClick={() => onTab("issues")}>Issues</button>
          </>
        ) : null}
        {page === "projects" ? (
          <div className="view-tools">
            <button
              className={projectFiltersOpen ? "round-icon active" : "round-icon"}
              onClick={onToggleProjectFilters}
              aria-label="Filter projects"
              aria-expanded={projectFiltersOpen}
            ><ListFilter size={15} /></button>
            <button
              className={projectSettingsOpen ? "round-icon active" : "round-icon"}
              onClick={onToggleProjectSettings}
              aria-label="Configure project view"
              aria-expanded={projectSettingsOpen}
            ><SlidersHorizontal size={15} /></button>
          </div>
        ) : null}
      </div>
    </>
  );
}

function ProjectsPage({
  projects,
  filtersOpen,
  settingsOpen,
  query,
  statusFilter,
  healthFilter,
  sort,
  onQuery,
  onStatusFilter,
  onHealthFilter,
  onSort,
  onClearFilters,
  onOpenProject,
}: {
  projects: Project[];
  filtersOpen: boolean;
  settingsOpen: boolean;
  query: string;
  statusFilter: ProjectStatusFilter;
  healthFilter: ProjectHealthFilter;
  sort: ProjectSort;
  onQuery: (value: string) => void;
  onStatusFilter: (value: ProjectStatusFilter) => void;
  onHealthFilter: (value: ProjectHealthFilter) => void;
  onSort: (value: ProjectSort) => void;
  onClearFilters: () => void;
  onOpenProject: (project: Project) => void;
}) {
  const visibleProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = projects.filter((project) => {
      const text = [
        project.name,
        project.summary,
        project.description,
        project.status,
        project.lead,
        project.source,
        project.latest_update_body,
      ].filter(Boolean).join(" ").toLowerCase();
      const statusType = resolveProjectStatusType(project.status);
      const matchesStatus = statusFilter === "all" ||
        (statusFilter === "active" && ["started", "blocked", "unstarted"].includes(statusType)) ||
        statusType === statusFilter;
      const matchesHealth = healthFilter === "all" ||
        (healthFilter === "none" ? !project.health : project.health === healthFilter);
      return (!normalizedQuery || text.includes(normalizedQuery)) && matchesStatus && matchesHealth;
    });
    return filtered.sort((left, right) => {
      if (sort === "name") return left.name.localeCompare(right.name);
      if (sort === "priority") return left.priority - right.priority || left.name.localeCompare(right.name);
      if (sort === "issues") return right.issue_count - left.issue_count || left.name.localeCompare(right.name);
      if (sort === "target_date") {
        return (left.target_date || "9999-12-31").localeCompare(right.target_date || "9999-12-31") || left.name.localeCompare(right.name);
      }
      return (right.latest_update_at || right.updated_at).localeCompare(left.latest_update_at || left.updated_at);
    });
  }, [healthFilter, projects, query, sort, statusFilter]);
  const filtersActive = Boolean(query.trim()) || statusFilter !== "all" || healthFilter !== "all";

  return (
    <section className="projects-screen">
      {filtersOpen || settingsOpen ? (
        <div className="project-view-config">
          {filtersOpen ? (
            <div className="project-filter-controls">
              <label className="project-search"><Search size={15} /><input aria-label="Search projects" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search projects" /></label>
              <InlineDropdown label="Status" ariaLabel="Filter projects by status" control="status" value={statusFilter} options={[{ value: "all", label: "All" }, { value: "active", label: "Active" }, { value: "paused", label: "Paused" }, { value: "backlog", label: "Backlog" }, { value: "completed", label: "Completed" }]} onChange={(value) => onStatusFilter(value as ProjectStatusFilter)} />
              <InlineDropdown label="Health" ariaLabel="Filter projects by health" control="health" value={healthFilter} options={[{ value: "all", label: "All" }, { value: "on_track", label: "On track" }, { value: "at_risk", label: "At risk" }, { value: "off_track", label: "Off track" }, { value: "complete", label: "Complete" }, { value: "none", label: "No update" }]} onChange={(value) => onHealthFilter(value as ProjectHealthFilter)} />
              <button type="button" disabled={!filtersActive} onClick={onClearFilters}><X size={14} /> Clear</button>
            </div>
          ) : null}
          {settingsOpen ? (
            <div className="project-sort-control">
              <InlineDropdown label="Sort" ariaLabel="Sort projects" control="sort" value={sort} options={[{ value: "updated", label: "Recently updated" }, { value: "name", label: "Name" }, { value: "priority", label: "Priority" }, { value: "target_date", label: "Target date" }, { value: "issues", label: "Issue count" }]} onChange={(value) => onSort(value as ProjectSort)} />
            </div>
          ) : null}
          <span className="project-result-count">{visibleProjects.length} of {projects.length} projects</span>
        </div>
      ) : null}
      <div className="projects-table">
        <div className="project-row project-head">
          <span className="project-name project-name-head"><span className="project-icon" aria-hidden="true" /><span>Name</span></span>
          <span>Health</span>
          <span>Priority</span>
          <span>Lead</span>
          <span>Target date</span>
          <span>Issues</span>
          <span>Status</span>
        </div>
        {visibleProjects.map((project) => (
          <button key={project.id} className="project-row" onClick={() => onOpenProject(project)}>
            <span className="project-name"><ProjectIcon project={project} /><span><strong>{project.name}</strong>{project.summary || project.description ? <small>{project.summary || project.description}</small> : null}</span></span>
            <ProjectHealthBadge project={project} />
            <span className="project-priority" title={`Priority: ${priorityName(project.priority)}`}><PriorityBars priority={project.priority} /> {priorityName(project.priority)}</span>
            <span className="project-lead">{project.lead ? <><Avatar label={project.lead} /> {project.lead}</> : <><UserRound className="dim" size={16} /> <span className="dim">Unassigned</span></>}</span>
            <span className={project.target_date ? "project-target" : "project-target dim"}>{project.target_date ? formatProjectDate(project.target_date) : "No target date"}</span>
            <strong className="project-issues" title={`${project.done_count ?? 0} done, ${project.active_count ?? 0} active, ${project.blocker_count ?? 0} blocked`}>{project.issue_count}</strong>
            <StatusPill status={project.status} statusType={resolveProjectStatusType(project.status)} />
          </button>
        ))}
        {visibleProjects.length === 0 ? <div className="empty-list project-empty">{projects.length === 0 ? "No projects yet." : "No projects match the current filters."}</div> : null}
      </div>
    </section>
  );
}

function ProjectDialog({ saving, error, onClose, onSubmit }: { saving: boolean; error: string | null; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <div className="issue-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="issue-dialog project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="dialog-close" onClick={onClose} aria-label="Close new project"><X size={16} /></button>
        <h2 id="project-dialog-title">New project</h2>
        <form className="project-form" onSubmit={onSubmit}>
          <label><span>Name</span><input name="name" aria-label="Project name" required autoFocus /></label>
          <label><span>Summary</span><input name="summary" aria-label="Project summary" /></label>
          <label className="project-form-wide"><span>Description</span><textarea name="description" aria-label="Project description" rows={4} /></label>
          <label><span>Status</span><select name="status" aria-label="Project status" defaultValue="Backlog"><option>Backlog</option><option>Planned</option><option>In Progress</option><option>Paused</option><option>Done</option><option>Canceled</option></select></label>
          <label><span>Priority</span><select name="priority" aria-label="Project priority" defaultValue="3"><option value="1">Urgent</option><option value="2">High</option><option value="3">Medium</option><option value="4">Low</option></select></label>
          <label><span>Lead</span><input name="lead" aria-label="Project lead" /></label>
          <label><span>Target date</span><input name="target_date" aria-label="Project target date" type="date" /></label>
          {error ? <div className="create-error project-form-wide"><AlertTriangle size={14} />{error}</div> : null}
          <div className="project-form-actions project-form-wide"><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={saving}>{saving ? "Saving" : "Create project"}</button></div>
        </form>
      </section>
    </div>
  );
}

function DatabaseDialog({ saving, error, onClose, onSubmit }: { saving: boolean; error: string | null; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const nameRef = useRef<HTMLInputElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  async function browseForDatabase() {
    setPickerError(null);
    setPicking(true);
    try {
      const result = await api<{ path?: string; cancelled?: boolean }>("/filesystem/database-path", {
        method: "POST",
        body: JSON.stringify({ name: nameRef.current?.value.trim() || "claw-task-hub" }),
      });
      if (result.path && pathRef.current) pathRef.current.value = result.path;
    } catch (browseError) {
      setPickerError(`${browseError instanceof Error ? browseError.message : String(browseError)} Enter an absolute path manually.`);
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className="issue-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="issue-dialog database-dialog" role="dialog" aria-modal="true" aria-labelledby="database-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="dialog-close" onClick={onClose} aria-label="Close new database"><X size={16} /></button>
        <h2 id="database-dialog-title">New database</h2>
        <p>Choose where to store the new SQLite database, then make it active. Existing databases are preserved and remain available from the database menu.</p>
        <form className="database-form" onSubmit={onSubmit}>
          <label><span>Name</span><input ref={nameRef} name="name" aria-label="Database name" required autoFocus maxLength={80} /></label>
          <label>
            <span>Location</span>
            <div className="database-path-control">
              <input ref={pathRef} name="path" aria-label="Database location" placeholder="Default managed database folder" maxLength={4096} />
              <button type="button" disabled={picking} onClick={() => void browseForDatabase()}><FolderOpen size={15} />{picking ? "Choosing…" : "Browse…"}</button>
            </div>
            <small>Leave blank to use the managed database folder, or choose an absolute `.sqlite` path.</small>
          </label>
          {error || pickerError ? <div className="create-error"><AlertTriangle size={14} />{error || pickerError}</div> : null}
          <div className="project-form-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={saving}>{saving ? "Creating" : "Create database"}</button></div>
        </form>
      </section>
    </div>
  );
}

function DeleteDatabaseDialog({
  database,
  deleting,
  error,
  onClose,
  onConfirm,
}: {
  database: ManagedDatabase;
  deleting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="issue-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="issue-dialog database-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-database-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="dialog-close" disabled={deleting} onClick={onClose} aria-label="Close delete database"><X size={16} /></button>
        <h2 id="delete-database-dialog-title">Delete database?</h2>
        <p>This permanently deletes the selected SQLite database and cannot be undone.</p>
        <div className="database-delete-summary">
          <strong>{database.fileName}</strong>
          <code>{database.path}</code>
        </div>
        {error ? <div className="create-error"><AlertTriangle size={14} />{error}</div> : null}
        <div className="project-form-actions">
          <button type="button" disabled={deleting} onClick={onClose}>Cancel</button>
          <button className="danger-action" type="button" disabled={deleting} onClick={onConfirm}>{deleting ? "Deleting" : "Delete database"}</button>
        </div>
      </section>
    </div>
  );
}

function NewIssueDialog({
  projectName,
  priority,
  saving,
  error,
  onPriority,
  onClose,
  onSubmit,
}: {
  projectName: string;
  priority: IssueDraftPriority;
  saving: boolean;
  error: string | null;
  onPriority: (value: IssueDraftPriority) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="issue-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="issue-dialog new-issue-dialog" role="dialog" aria-modal="true" aria-labelledby="new-issue-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="dialog-close" onClick={onClose} aria-label="Close new issue"><X size={16} /></button>
        <h2 id="new-issue-dialog-title">New issue</h2>
        <p>New issue in {projectName}</p>
        <form className="new-issue-form" onSubmit={onSubmit}>
          <label><span>Title</span><input name="title" aria-label="Issue title" required autoFocus /></label>
          <label><span>Description</span><textarea name="description" aria-label="Issue description" rows={5} /></label>
          <div className="new-issue-priority"><span>Priority</span><IssuePriorityPicker value={priority} onChange={onPriority} /></div>
          {error ? <div className="create-error"><AlertTriangle size={14} />{error}</div> : null}
          <div className="project-form-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={saving}>{saving ? "Creating" : "Create issue"}</button></div>
        </form>
      </section>
    </div>
  );
}

function ProjectOverview({ detail, onTab }: { detail: ProjectDetail; onTab: (tab: ProjectTab) => void }) {
  const project = detail.project;
  const topResources = detail.issues.slice(0, 16);
  return (
    <section className="project-overview-linear">
      <div className="project-hero">
        <h1>{project.name}</h1>
        <p>{project.summary || project.description || "Browse every local issue imported from history or created by agents."}</p>
      </div>

      <div className="properties-row">
        <span className="prop-label">Properties</span>
        <StatusPill status={project.status || "In Progress"} statusType={resolveProjectStatusType(project.status)} />
        <ProjectHealthBadge project={project} />
        <span className="prop-item"><PriorityBars priority={project.priority} /> {priorityName(project.priority)}</span>
        <span className="prop-item"><Avatar label={project.lead || "Unassigned"} /> {project.lead || "Unassigned"}</span>
        <span className="prop-item">{project.target_date ? formatProjectDate(project.target_date) : "No target date"}</span>
        <span className="prop-item"><Box size={14} /> {projectSourceLabel(project.source)}</span>
      </div>

      <div className="resources-row">
        <span className="prop-label">Resources</span>
        <div className="resource-list">
          {topResources.map((issue) => (
            <button key={issue.id} onClick={() => onTab("issues")}>
              <span>{resourceIcon(issue)}</span>
              <span>{issueCode(issue)} {issue.title}</span>
            </button>
          ))}
        </div>
      </div>

      <button className="update-box" onClick={() => onTab("activity")}>
        <MessageSquarePlus size={16} />
        <span>{detail.projectUpdates.length ? "Write project update" : "Write first project update"}</span>
      </button>
    </section>
  );
}

function ProjectActivity({
  detail,
  onPostUpdate,
  error,
}: {
  detail: ProjectDetail;
  onPostUpdate: (event: FormEvent<HTMLFormElement>) => void;
  error: string | null;
}) {
  return (
    <section className="activity-linear">
      <form className="update-composer" onSubmit={onPostUpdate}>
        <div className="composer-tabs">
          <strong>Update</strong>
          <select name="health" aria-label="Project health" defaultValue="on_track">
            <option value="on_track">On track</option>
            <option value="at_risk">At risk</option>
            <option value="off_track">Off track</option>
            <option value="complete">Complete</option>
          </select>
        </div>
        <textarea name="body" aria-label="Project update" placeholder="Write a project update..." required maxLength={10000} />
        <div className="composer-props">
          <span>Priority</span><strong>{priorityName(detail.project.priority)}</strong>
          <span>Lead</span><strong><Avatar label={detail.project.lead || "Unassigned"} /> {detail.project.lead || "Unassigned"}</strong>
          <span>Progress</span><strong>{detail.counts.done} done / {detail.counts.started} in progress / {detail.counts.blockers} blocked / {detail.counts.open} open</strong>
        </div>
        {error ? <div className="create-error"><AlertTriangle size={14} />{error}</div> : null}
        <button type="submit">Post update</button>
      </form>
      <div className="timeline">
        {/* Optional-chained deliberately. An API response without this key threw a
            TypeError here, React aborted the render, and the Activity tab went
            blank — which reads as "the app is broken" rather than "the server
            is running old code", and the real cause took a stale-process check
            to find. A missing key now degrades to the empty state. */}
        {(detail.projectUpdates?.length ?? 0) === 0 ? <div className="empty-list">No project updates yet</div> : null}
        {(detail.activity ?? []).map((event) => (
          <div key={`${event.id}-${event.updated_at}`} className="timeline-row">
            <StatusIcon statusType={event.status_type} />
            <span><strong>{activityText(event)}</strong>{event.body ? ` — ${event.body}` : ""} / {formatDate(event.updated_at)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function IssuesPage({
  title,
  issues,
  issueGroups,
  selectedIssue,
  query,
  statusMode,
  issueDisplayLimit,
  priorityFilter,
  assigneeFilter,
  labelFilter,
  assignees,
  labels,
  canCreate,
  onQuery,
  onStatusMode,
  onIssueDisplayLimit,
  onPriorityFilter,
  onAssigneeFilter,
  onLabelFilter,
  onClearFilters,
  onNewIssue,
  onOpenIssue,
  onAddComment,
  onAddDependency,
  onResolveDependency,
  onStatusChange,
}: {
  title: string;
  issues: Issue[];
  issueGroups: UiIssueGroup[];
  selectedIssue: Issue | null;
  query: string;
  statusMode: StatusMode;
  issueDisplayLimit: IssueDisplayLimit;
  priorityFilter: IssuePriorityFilter;
  assigneeFilter: string;
  labelFilter: string;
  assignees: string[];
  labels: string[];
  canCreate: boolean;
  onQuery: (value: string) => void;
  onStatusMode: (mode: StatusMode) => void;
  onIssueDisplayLimit: (value: IssueDisplayLimit) => void;
  onPriorityFilter: (value: IssuePriorityFilter) => void;
  onAssigneeFilter: (value: string) => void;
  onLabelFilter: (value: string) => void;
  onClearFilters: () => void;
  onNewIssue: () => void;
  onOpenIssue: (issue: Issue, reveal?: boolean) => void;
  onAddComment: (event: FormEvent<HTMLFormElement>) => void;
  onAddDependency: (event: FormEvent<HTMLFormElement>) => void;
  onResolveDependency: (dependencyId: string) => void;
  onStatusChange: (status: string) => void;
}) {
  const grouped = issueGroups;
  const issueLimitEnabled = grouped.some((group) => group.total > 50);
  const filtersActive = Boolean(query.trim()) || statusMode !== "all" || priorityFilter !== "all" || assigneeFilter !== "all" || labelFilter !== "all";
  return (
    <section className="issues-screen">
      <div className="issue-filter-row">
        <div className="searchbar"><Search size={16} /><input aria-label={`Search ${title}`} value={query} onChange={(event) => onQuery(event.target.value)} placeholder={`Search ${title}`} /></div>
        <InlineDropdown
          className="issue-limit-control"
          label="Rows/group"
          ariaLabel="Issues per status"
          control="rows"
          value={issueDisplayLimit}
          options={[{ value: "50", label: "50" }, { value: "100", label: "100" }, { value: "200", label: "200" }, { value: "all", label: "All" }]}
          disabled={!issueLimitEnabled}
          title={issueLimitEnabled ? "Set the maximum rows shown in each status group" : "Every status group already has 50 or fewer issues"}
          onChange={(value) => onIssueDisplayLimit(value as IssueDisplayLimit)}
        />
        <span className="filter-results" aria-live="polite">{issues.length} shown</span>
        {filtersActive ? <button className="clear-filter-button" onClick={onClearFilters}><X size={14} /> Clear filters</button> : null}
        {canCreate ? <button className="primary-action" type="button" onClick={onNewIssue}><Plus size={15} /> New issue</button> : null}
      </div>
      <div className="mode-row">
        <button className={statusMode === "blockers" ? "mode-chip danger active" : "mode-chip danger"} onClick={() => onStatusMode("blockers")}><AlertTriangle size={14} />Blockers</button>
        <button className={statusMode === "all" ? "mode-chip active" : "mode-chip"} onClick={() => onStatusMode("all")}>All statuses</button>
        <button className={statusMode === "active" ? "mode-chip active" : "mode-chip"} onClick={() => onStatusMode("active")}>Active</button>
        <button className={statusMode === "started" ? "mode-chip active" : "mode-chip"} onClick={() => onStatusMode("started")}>In progress</button>
        <button className={statusMode === "paused" ? "mode-chip active" : "mode-chip"} onClick={() => onStatusMode("paused")}>Paused</button>
        <button className={statusMode === "backlog" ? "mode-chip active" : "mode-chip"} onClick={() => onStatusMode("backlog")}>Backlog</button>
        <button className={statusMode === "todo" ? "mode-chip active" : "mode-chip"} onClick={() => onStatusMode("todo")}>Todo</button>
        <button className={statusMode === "completed" ? "mode-chip active" : "mode-chip"} onClick={() => onStatusMode("completed")}>Done</button>
        <button className={statusMode === "canceled" ? "mode-chip active" : "mode-chip"} onClick={() => onStatusMode("canceled")}>Canceled</button>
        <div className="issue-advanced-filters">
          <InlineDropdown label="Priority" ariaLabel="Filter issues by priority" control="priority" value={priorityFilter} options={[{ value: "all", label: "All" }, { value: "1", label: "P1" }, { value: "2", label: "P2" }, { value: "3", label: "P3" }, { value: "4", label: "P4" }]} onChange={(value) => onPriorityFilter(value as IssuePriorityFilter)} />
          <InlineDropdown label="Assignee" ariaLabel="Filter issues by assignee" control="assignee" value={assigneeFilter} options={[{ value: "all", label: "All" }, { value: "unassigned", label: "Unassigned" }, ...assignees.map((assignee) => ({ value: assignee, label: assignee }))]} onChange={onAssigneeFilter} />
          <InlineDropdown label="Label" ariaLabel="Filter issues by label" control="label" value={labelFilter} options={[{ value: "all", label: "All" }, ...labels.map((label) => ({ value: label, label }))]} onChange={onLabelFilter} />
        </div>
      </div>
      <div className="issues-and-detail">
        <VirtualizedIssueList
          groups={grouped}
          selectedIssueId={selectedIssue?.id}
          emptyMessage={emptyListReason(statusMode, query, filtersActive)}
          onOpenIssue={onOpenIssue}
        />
        <IssueDetail
          issue={selectedIssue}
          onAddComment={onAddComment}
          onAddDependency={onAddDependency}
          onResolveDependency={onResolveDependency}
          onStatusChange={onStatusChange}
        />
      </div>
    </section>
  );
}

const issueGroupHeaderHeight = design.dimensions.issueGroup;
const issueRowHeight = design.dimensions.issueRow;
const issueListOverscan = design.dimensions.issueOverscan;

type InlineDropdownOption = { value: string; label: string };

function InlineDropdown({
  label,
  ariaLabel,
  control,
  value,
  options,
  disabled = false,
  className = "",
  title,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  control: "status" | "health" | "sort" | "rows" | "priority" | "assignee" | "label";
  value: string;
  options: InlineDropdownOption[];
  disabled?: boolean;
  className?: string;
  title?: string;
  onChange: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;

  const positionMenu = useCallback(() => {
    const trigger = rootRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = design.placement.viewportGap;
    const below = window.innerHeight - rect.bottom - gap;
    const above = rect.top - gap;
    const useAbove = below < design.placement.dropdownMinimumSpace && above > below;
    setMenuStyle({
      left: rect.left,
      ...(useAbove ? { bottom: window.innerHeight - rect.top + gap } : { top: rect.bottom + gap }),
      width: rect.width,
      maxHeight: Math.max(design.placement.dropdownMinimumHeight, Math.min(design.placement.dropdownMaximumHeight, useAbove ? above : below)),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>(".inline-select-trigger")?.focus();
      }
    };
    const reposition = () => positionMenu();
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, positionMenu]);

  return (
    <div ref={rootRef} className={`inline-control ${className}`.trim()} data-control={control} title={title}>
      <button
        type="button"
        className="inline-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-value={value}
        disabled={disabled}
        onClick={() => {
          if (!open) positionMenu();
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            positionMenu();
            setOpen(true);
          }
        }}
      >
        <span>{label}</span>
        <strong>{selectedLabel}</strong>
      </button>
      {open && menuStyle ? createPortal(
        <div ref={menuRef} className="inline-dropdown-menu" role="listbox" aria-label={`${ariaLabel} options`} style={menuStyle}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                rootRef.current?.querySelector<HTMLButtonElement>(".inline-select-trigger")?.focus();
              }}
            >{option.label}</button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function VirtualizedIssueList({
  groups,
  selectedIssueId,
  emptyMessage,
  onOpenIssue,
}: {
  groups: UiIssueGroup[];
  selectedIssueId?: string;
  emptyMessage: string;
  onOpenIssue: (issue: Issue, reveal?: boolean) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 720 });
  const layouts = useMemo(() => {
    return groups.reduce<{ layouts: { group: UiIssueGroup; collapsed: boolean; top: number; height: number }[]; nextTop: number }>((result, group) => {
      const collapsed = collapsedGroups.has(group.key);
      const height = issueGroupHeaderHeight + (collapsed ? 0 : group.items.length * issueRowHeight);
      return {
        layouts: [...result.layouts, { group, collapsed, top: result.nextTop, height }],
        nextTop: result.nextTop + height,
      };
    }, { layouts: [], nextTop: 0 }).layouts;
  }, [collapsedGroups, groups]);
  const totalHeight = layouts.reduce((height, layout) => height + layout.height, 0);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => setViewport((current) => ({ scrollTop: list.scrollTop, height: list.clientHeight || current.height }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  if (groups.length === 0) {
    return <div className="linear-issue-list"><div className="empty-list">{emptyMessage}</div></div>;
  }

  const visibleTop = Math.max(0, viewport.scrollTop - issueListOverscan);
  const visibleBottom = viewport.scrollTop + viewport.height + issueListOverscan;
  return (
    <div
      ref={listRef}
      className="linear-issue-list"
      onScroll={(event) => setViewport({ scrollTop: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
    >
      <div className="virtual-issue-space" style={{ height: totalHeight }}>
        {layouts.map(({ group, collapsed, top, height }) => {
          const rowTop = top + issueGroupHeaderHeight;
          const firstRow = collapsed ? 0 : Math.max(0, Math.floor((visibleTop - rowTop) / issueRowHeight));
          const lastRow = collapsed ? 0 : Math.min(group.items.length, Math.ceil((visibleBottom - rowTop) / issueRowHeight));
          const visibleIssues = firstRow < lastRow ? group.items.slice(firstRow, lastRow) : [];
          return (
            <div
              key={group.key}
              className="issue-group"
              data-total={group.total}
              data-returned={group.items.length}
              style={{ top, height }}
            >
              <div className="group-head">
                <button
                  type="button"
                  className="group-toggle"
                  aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.label}`}
                  aria-expanded={!collapsed}
                  onClick={() => setCollapsedGroups((current) => {
                    const next = new Set(current);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
                    return next;
                  })}
                ><span aria-hidden="true">{collapsed ? "›" : "⌄"}</span></button>
                <StatusIcon statusType={group.statusType} />
                <strong>{group.label}</strong>
                <em>{groupCountLabel(group)}</em>
              </div>
              {visibleIssues.map((issue, visibleIndex) => {
                const issueIndex = firstRow + visibleIndex;
                return (
                  <button
                    key={issue.id}
                    className={selectedIssueId === issue.id ? "linear-issue-row active" : "linear-issue-row"}
                    style={{ top: issueGroupHeaderHeight + issueIndex * issueRowHeight }}
                    onClick={() => onOpenIssue(issue)}
                    onDoubleClick={() => onOpenIssue(issue, true)}
                  >
                    <span className="issue-id">{issueCode(issue)}</span>
                    <StatusIcon statusType={resolveUiStatusType(issue)} />
                    <strong>{issue.title}</strong>
                    <span className="relation">{issue.project_name}</span>
                    <time>{formatShortDate(issue.updated_at)}</time>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IssuePriorityPicker({ value, onChange }: { value: IssueDraftPriority; onChange: (value: IssueDraftPriority) => void }) {
  const [open, setOpen] = useState(false);
  const options: { value: IssueDraftPriority; label: string }[] = [
    { value: "1", label: "P1 Urgent" },
    { value: "2", label: "P2 High" },
    { value: "3", label: "P3 Medium" },
    { value: "4", label: "P4 Low" },
  ];
  return (
    <div className="issue-priority-picker">
      <button
        type="button"
        className={`priority-picker-pill p${value}`}
        aria-label={`New issue priority P${value}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      ><Flag size={13} />P{value}</button>
      {open ? (
        <div className="priority-picker-menu" role="menu" aria-label="New issue priority choices">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={value === option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >{option.label}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type IssueWorkflowHandlers = {
  onAddDependency: (event: FormEvent<HTMLFormElement>) => void;
  onResolveDependency: (dependencyId: string) => void;
  onStatusChange: (status: string) => void;
};

function IssueDetail({
  issue,
  onAddComment,
  onAddDependency,
  onResolveDependency,
  onStatusChange,
}: { issue: Issue | null; onAddComment: (event: FormEvent<HTMLFormElement>) => void } & IssueWorkflowHandlers) {
  if (!issue) return <aside className="issue-detail empty-detail">Select an issue</aside>;
  return (
    <aside className="issue-detail">
      <div className="detail-top"><span>{issueCode(issue)}</span><StatusPill status={issue.status} statusType={resolveUiStatusType(issue)} /></div>
      <h2>{issue.title}</h2>
      <div className="detail-pills"><PriorityPill priority={issue.priority} /><span>{issue.project_name}</span><span>{issue.team_name}</span></div>
      <p>{issue.description || "No description yet."}</p>
      <AgentStatePanel issue={issue} />
      <IssueWorkflowControls issue={issue} onAddDependency={onAddDependency} onResolveDependency={onResolveDependency} onStatusChange={onStatusChange} />
      <div className="comments-box">
        <strong>Activity</strong>
        {issue.comments?.map((comment) => <article key={comment.id}><b>{comment.author}</b><span>{comment.body}</span></article>)}
        <form onSubmit={onAddComment}><input name="body" aria-label="Add agent note" placeholder="Add an agent note" /><button>Add</button></form>
      </div>
    </aside>
  );
}

function IssueDialog({
  issue,
  onClose,
  onAddComment,
  onAddDependency,
  onResolveDependency,
  onStatusChange,
}: { issue: Issue; onClose: () => void; onAddComment: (event: FormEvent<HTMLFormElement>) => void } & IssueWorkflowHandlers) {
  return (
    <div className="issue-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="issue-dialog" role="dialog" aria-modal="true" aria-labelledby="issue-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="dialog-close" onClick={onClose} aria-label="Close issue detail"><X size={16} /></button>
        <div className="detail-top"><span>{issueCode(issue)}</span><StatusPill status={issue.status} statusType={resolveUiStatusType(issue)} /></div>
        <h2 id="issue-dialog-title">{issue.title}</h2>
        <div className="detail-pills"><PriorityPill priority={issue.priority} /><span>{issue.project_name}</span><span>{issue.team_name}</span></div>
        <p>{issue.description || "No description yet."}</p>
        <AgentStatePanel issue={issue} />
        <IssueWorkflowControls issue={issue} onAddDependency={onAddDependency} onResolveDependency={onResolveDependency} onStatusChange={onStatusChange} />
        <div className="comments-box">
          <strong>Activity</strong>
          {issue.comments?.map((comment) => <article key={comment.id}><b>{comment.author}</b><span>{comment.body}</span></article>)}
          <form onSubmit={onAddComment}><input name="body" aria-label="Add agent note" placeholder="Add an agent note" /><button>Add</button></form>
        </div>
      </section>
    </div>
  );
}

function IssueWorkflowControls({ issue, onAddDependency, onResolveDependency, onStatusChange }: { issue: Issue } & IssueWorkflowHandlers) {
  return (
    <section className="workflow-controls">
      <label>
        <span>Status</span>
        <select aria-label="Issue status" value={issue.status} onChange={(event) => onStatusChange(event.target.value)}>
          <option value="Backlog">Backlog</option>
          <option value="Todo">Todo</option>
          <option value="In Progress">In Progress</option>
          <option value="Blocked">Blocked</option>
          <option value="Paused">Paused</option>
          <option value="Done">Done</option>
          <option value="Canceled">Canceled</option>
        </select>
      </label>
      <strong>Blocked by</strong>
      {issue.dependencies?.length ? issue.dependencies.map((dependency) => (
        <article key={dependency.id} className={dependency.status === "open" ? "dependency open" : "dependency resolved"}>
          <span>{dependency.blocker_identifier} {dependency.blocker_title}{dependency.reason ? ` — ${dependency.reason}` : ""}</span>
          {dependency.status === "open" ? <button type="button" onClick={() => onResolveDependency(dependency.id)}>Resolve</button> : <em>Resolved</em>}
        </article>
      )) : <span className="dim">No blockers</span>}
      <form className="dependency-form" onSubmit={onAddDependency}>
        <input name="blocker_issue_id" aria-label="Blocking issue" placeholder="Blocking issue, e.g. CTH-123" required />
        <input name="reason" aria-label="Blocker reason" placeholder="Why it blocks this issue" maxLength={2000} />
        <button type="submit">Add blocker</button>
      </form>
    </section>
  );
}

function parseRoute(location: Location): RouteDescriptor {
  const params = new URLSearchParams(location.search);
  const query = params.get("q") ?? params.get("query") ?? "";
  const issueDisplayLimit = parseIssueDisplayLimitParam(params.get("limit") ?? params.get("issues_per_status"));
  const statusMode = parseStatusModeParam(params.get("status"));
  const priorityFilter = parseIssuePriorityFilter(params.get("priority"));
  const assigneeFilter = params.get("assignee") || "all";
  const labelFilter = params.get("label") || "all";
  const issueFilters = { statusMode, query, issueDisplayLimit, priorityFilter, assigneeFilter, labelFilter };
  const queryTab = parseProjectTab(params.get("tab"));
  const contextKey = params.get("context_key");
  const projectId = params.get("project_id");
  const issueId = params.get("issue");
  if (contextKey) {
    return { kind: "context", contextKey, tab: queryTab ?? "issues", tabExplicit: Boolean(queryTab), ...issueFilters };
  }
  if (issueId) {
    return { kind: "issue", issueId, tab: "issues", ...issueFilters };
  }
  if (projectId) {
    return { kind: "project", projectId, tab: queryTab ?? "issues", ...issueFilters };
  }
  const segments = location.pathname.split("/").map((part) => part.trim()).filter(Boolean).map(decodeUrlSegment);
  if (!segments.length) return { kind: "projects", tab: "overview", ...issueFilters };
  if (segments[0] === "workspace") return { kind: "workspace", tab: "issues", ...issueFilters };
  if (segments[0] === "issues" && segments[1]) {
    return { kind: "issue", issueId: segments[1], tab: "issues", ...issueFilters };
  }
  if (segments[0] === "contexts" && segments[1]) {
    const pathTab = parseProjectTab(segments[2]);
    return { kind: "context", contextKey: segments[1], tab: pathTab ?? queryTab ?? "issues", tabExplicit: Boolean(pathTab || queryTab), ...issueFilters };
  }
  if (segments[0] === "projects" && segments[1]) {
    return { kind: "project", projectId: segments[1], tab: parseProjectTab(segments[2]) ?? queryTab ?? "overview", ...issueFilters };
  }
  return { kind: "projects", tab: "overview", ...issueFilters };
}

function currentRoutePath(input: {
  page: AppPage;
  projectId?: string;
  tab: ProjectTab;
  query: string;
  statusMode: StatusMode;
  issueDisplayLimit: IssueDisplayLimit;
  priorityFilter: IssuePriorityFilter;
  assigneeFilter: string;
  labelFilter: string;
}) {
  if (input.page === "project" && input.projectId) {
    return projectRoutePath(input.projectId, input.tab, input);
  }
  if (input.page === "workspace") return workspaceRoutePath(input);
  return "/projects";
}

function projectRoutePath(projectId: string, tab: ProjectTab = "overview", options: Partial<Pick<RouteDescriptor, "query" | "statusMode" | "issueDisplayLimit" | "priorityFilter" | "assigneeFilter" | "labelFilter">> = {}) {
  return `/projects/${encodeURIComponent(projectId)}/${tab}${routeQuery(options)}`;
}

function downloadShortcut(project: Project, tab: ProjectTab) {
  const url = `${window.location.origin}${projectRoutePath(project.id, tab)}`;
  const body = `[InternetShortcut]\r\nURL=${url}\r\n`;
  const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `Open Claw Task Hub - ${safeFileName(project.name)}.url`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function safeFileName(value: string) {
  return (
    value
      .replace(/[<>:"/\\|?*]/g, "-")
      .split("")
      .filter((char) => char.charCodeAt(0) >= 32)
      .join("")
      .replace(/\s+/g, " ")
      .trim() || "Project"
  );
}

function workspaceRoutePath(options: Partial<Pick<RouteDescriptor, "query" | "statusMode" | "issueDisplayLimit" | "priorityFilter" | "assigneeFilter" | "labelFilter">> = {}) {
  return `/workspace/issues${routeQuery(options)}`;
}

function issueRoutePath(issue: Issue) {
  return `/issues/${encodeURIComponent(issueCode(issue))}`;
}

function routeQuery(options: Partial<Pick<RouteDescriptor, "query" | "statusMode" | "issueDisplayLimit" | "priorityFilter" | "assigneeFilter" | "labelFilter">>) {
  const params = new URLSearchParams();
  const query = options.query?.trim();
  if (query) params.set("q", query);
  if (options.statusMode && options.statusMode !== "all") params.set("status", options.statusMode);
  if (options.issueDisplayLimit && options.issueDisplayLimit !== defaultIssueDisplayLimit) params.set("limit", options.issueDisplayLimit);
  if (options.priorityFilter && options.priorityFilter !== "all") params.set("priority", options.priorityFilter);
  if (options.assigneeFilter && options.assigneeFilter !== "all") params.set("assignee", options.assigneeFilter);
  if (options.labelFilter && options.labelFilter !== "all") params.set("label", options.labelFilter);
  const value = params.toString();
  return value ? `?${value}` : "";
}

function pushBrowserPath(path: string) {
  const current = `${window.location.pathname}${window.location.search}`;
  if (current !== path) window.history.pushState({}, "", path);
}

function replaceBrowserPath(path: string) {
  const current = `${window.location.pathname}${window.location.search}`;
  if (current !== path) window.history.replaceState({}, "", path);
}

function parseProjectTab(value: string | null | undefined): ProjectTab | null {
  if (value === "overview" || value === "activity" || value === "issues") return value;
  return null;
}

function parseStatusModeParam(value: string | null | undefined): StatusMode {
  if (value === "active" || value === "started" || value === "paused" || value === "backlog" || value === "todo" || value === "blockers" || value === "completed" || value === "canceled") return value;
  return "all";
}

function parseIssuePriorityFilter(value: string | null | undefined): IssuePriorityFilter {
  if (value === "1" || value === "2" || value === "3" || value === "4") return value;
  return "all";
}

function parseIssueDisplayLimitParam(value: string | null | undefined): IssueDisplayLimit {
  if (value === "100" || value === "200" || value === "all") return value;
  return "50";
}

function decodeUrlSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function AgentStatePanel({ issue }: { issue: Issue }) {
  const claimCount = activeClaimCount(issue);
  const activeClaims = issue.active_claims ?? [];
  const acceptance = issue.last_acceptance_comment ?? latestAcceptanceForIssue(issue);
  const hasClaimConflict = claimCount > 1;
  return (
    <section className={hasClaimConflict ? "agent-state warning" : "agent-state"} aria-label="Agent state">
      <div className="agent-state-head">
        <strong>Agent state</strong>
        {hasClaimConflict ? <span><AlertTriangle size={14} />Multiple active claims</span> : null}
      </div>
      {activeClaims.length ? (
        <div className="agent-state-lines">
          {activeClaims.map((claim) => (
            <div key={claim.id}>
              <UserRound size={14} />
              <span><b>{claim.agent_name}</b>{claim.harness ? ` via ${claim.harness}` : ""}</span>
              {claim.note ? <em>{claim.note}</em> : null}
            </div>
          ))}
        </div>
      ) : claimCount > 0 ? (
        <div className="agent-state-lines">
          <div><UserRound size={14} /><span><b>{issue.active_claim_agent || "Agent"}</b>{issue.active_claim_harness ? ` via ${issue.active_claim_harness}` : ""}</span></div>
        </div>
      ) : (
        <p>No active agent claim.</p>
      )}
      {acceptance ? (
        <div className="acceptance-note">
          <CheckCircle2 size={14} />
          <span><b>{acceptance.author}</b> accepted on {formatShortDate(acceptance.created_at)}: {acceptance.body}</span>
        </div>
      ) : (
        <p>No acceptance comment yet.</p>
      )}
    </section>
  );
}

function issueCode(issue: Pick<Issue, "identifier" | "id">) {
  return issue.identifier || issue.id;
}

function activeClaimCount(issue: Issue) {
  return Number(issue.active_claim_count ?? issue.active_claims?.length ?? 0);
}

function latestAcceptanceForIssue(issue: Issue) {
  return issue.comments?.filter(isAcceptanceComment).at(-1) ?? null;
}

function isAcceptanceComment(comment: IssueComment) {
  const body = comment.body.trim().toLowerCase();
  return (
    body.startsWith("acceptance") ||
    body.startsWith("accepted") ||
    body.startsWith("plan/fact acceptance") ||
    (body.startsWith("repeat ") && body.includes(" acceptance")) ||
    body.startsWith("reviewer-opponent acceptance") ||
    (body.startsWith("closure note:") && body.includes("acceptance was already reached"))
  );
}

function apiGroupToUiGroup(group: ApiIssueGroup): UiIssueGroup {
  return {
    key: group.key,
    statusType: group.status_type,
    label: group.label,
    total: group.total,
    returned: group.returned,
    truncated: group.truncated,
    items: group.issues,
  };
}

function emptyListReason(statusMode: StatusMode, query: string, filtersActive: boolean) {
  const trimmed = query.trim();
  if (trimmed) return `No issues match "${trimmed}"${statusMode === "all" ? "" : ` in ${statusModeLabel(statusMode)}`}`;
  if (filtersActive) return "No issues match the active filters";
  if (statusMode === "all") return "No issues yet";
  return `No issues in ${statusModeLabel(statusMode)}`;
}

function statusModeLabel(statusMode: StatusMode) {
  if (statusMode === "blockers") return "Blockers";
  if (statusMode === "active") return "Active";
  if (statusMode === "started") return "In progress";
  if (statusMode === "paused") return "Paused";
  if (statusMode === "backlog") return "Backlog";
  if (statusMode === "todo") return "Todo";
  if (statusMode === "completed") return "Done";
  if (statusMode === "canceled") return "Canceled";
  return "All statuses";
}

function matchesStatusMode(statusMode: StatusMode, statusType: IssueStatusType) {
  return statusMode === "all" ||
    (statusMode === "active" && ["started", "blocked", "paused"].includes(statusType)) ||
    (statusMode === "started" && statusType === "started") ||
    (statusMode === "paused" && statusType === "paused") ||
    (statusMode === "backlog" && statusType === "backlog") ||
    (statusMode === "todo" && statusType === "unstarted") ||
    (statusMode === "blockers" && statusType === "blocked") ||
    (statusMode === "completed" && statusType === "completed") ||
    (statusMode === "canceled" && statusType === "canceled");
}

function groupCountLabel(group: UiIssueGroup) {
  return group.truncated ? `${group.returned}/${group.total}` : String(group.total);
}

function groupIssues(issues: Issue[]): UiIssueGroup[] {
  const order: [IssueStatusType, string][] = [
    ["started", "In Progress"],
    ["blocked", "Blocked"],
    ["paused", "Paused"],
    ["backlog", "Backlog"],
    ["unstarted", "Todo"],
    ["completed", "Done"],
    ["canceled", "Canceled"],
  ];
  return order
    .map(([statusType, label]) => ({
      key: statusType,
      statusType,
      label,
      total: issues.filter((issue) => resolveUiStatusType(issue) === statusType).length,
      returned: issues.filter((issue) => resolveUiStatusType(issue) === statusType).length,
      truncated: false,
      items: issues.filter((issue) => {
        const resolved = resolveUiStatusType(issue);
        return resolved === statusType;
      }),
    }))
    .filter((group) => group.items.length);
}

function resolveUiStatusType(issue: Pick<Issue, "status" | "status_type">) {
  // An unresolved dependency is an effective Blocked state even when the
  // issue's persisted workflow status remains Todo or In Progress.
  if (issue.status_type === "blocked") return "blocked";
  const status = issue.status.trim().toLowerCase();
  if (["done", "completed"].includes(status)) return "completed";
  if (["in progress", "started"].includes(status)) return "started";
  if (["todo", "to do"].includes(status)) return "unstarted";
  if (["blocked", "blocker"].includes(status)) return "blocked";
  if (["paused", "pause"].includes(status)) return "paused";
  if (["canceled", "cancelled"].includes(status)) return "canceled";
  return issue.status_type;
}

function ProjectIcon({ project }: { project: Project }) {
  return <span className="project-icon" title={`${project.name} project`}><Diamond size={11} strokeWidth={1.4} /></span>;
}

function StatusIcon({ statusType }: { statusType: string }) {
  if (statusType === "completed") return <CheckCircle2 className="sicon done" size={16} />;
  if (statusType === "blocked") return <AlertTriangle className="sicon blocker" size={16} />;
  if (statusType === "started") return <Clock3 className="sicon started" size={16} />;
  if (statusType === "paused") return <CircleDot className="sicon paused" size={16} />;
  if (statusType === "backlog") return <Circle className="sicon backlog" size={16} />;
  if (statusType === "canceled") return <X className="sicon canceled" size={16} />;
  return <CircleDot className="sicon todo" size={16} />;
}

function StatusPill({ status, statusType }: { status: string; statusType: string }) {
  return <span className={`status-pill ${statusType}`}><StatusIcon statusType={statusType} />{status}</span>;
}

function PriorityPill({ priority }: { priority: number }) {
  return <span className={`priority p${priority}`}><Flag size={13} />P{priority}</span>;
}

function PriorityBars({ priority }: { priority: number }) {
  return <span className={`pbars p${priority}`}><i /><i /><i /></span>;
}

function ProjectHealthBadge({ project }: { project: Project }) {
  if (!project.health) {
    return <span className="health-badge none" title="No project update has set health"><Circle size={14} /> No update</span>;
  }
  return (
    <span className={`health-badge ${project.health}`} title={project.latest_update_body || `Health: ${projectHealthLabel(project.health)}`}>
      <span className="health-dot" /> {projectHealthDisplayLabel(project.health)}
    </span>
  );
}

function Avatar({ label }: { label: string }) {
  return <span className="avatar">{label.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span>;
}

function priorityName(priority: number) {
  if (priority === 0) return "No priority";
  if (priority === 1) return "Urgent";
  if (priority === 2) return "High";
  if (priority === 4) return "Low";
  return "Medium";
}

function resourceIcon(issue: Issue) {
  if (issue.priority === 1) return "🚨";
  if (issue.status_type === "completed") return "📄";
  if (issue.status_type === "started") return "📊";
  return "▰";
}

function activityText(event: ActivityEvent) {
  if (event.type === "project_update") return `${event.author || "Agent"} posted ${projectHealthLabel(event.health)} update`;
  if (event.type === "dependency") {
    return event.verb === "unblocked"
      ? `${event.identifier} resolved blocker ${event.blocker_identifier}`
      : `${event.identifier} blocked by ${event.blocker_identifier}`;
  }
  if (event.type === "comment") return `${event.author || "Agent"} commented`;
  if (event.verb === "completed") return `${event.identifier} completed`;
  if (event.verb === "started") return `${event.identifier} moved to In Progress`;
  if (event.verb === "blocker") return `${event.identifier} marked blocker`;
  return `${event.identifier} updated`;
}

function projectHealthLabel(health?: ProjectUpdate["health"]) {
  if (health === "at_risk") return "at-risk";
  if (health === "off_track") return "off-track";
  if (health === "complete") return "complete";
  return "on-track";
}

function projectHealthDisplayLabel(health: ProjectHealth) {
  if (health === "at_risk") return "At risk";
  if (health === "off_track") return "Off track";
  if (health === "complete") return "Complete";
  return "On track";
}

function resolveProjectStatusType(value: string): IssueStatusType {
  const status = value.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (["done", "completed", "complete", "finished"].includes(status)) return "completed";
  if (["canceled", "cancelled"].includes(status)) return "canceled";
  if (["paused", "pause", "suspended"].includes(status)) return "paused";
  if (["backlog", "planned", "planning"].includes(status)) return "backlog";
  if (["todo", "to do", "unstarted"].includes(status)) return "unstarted";
  if (["blocked", "off track"].includes(status)) return "blocked";
  return "started";
}

function projectSourceLabel(source: string) {
  if (source === "local") return "Local workspace";
  return `${source.charAt(0).toUpperCase()}${source.slice(1)} source`;
}

function formatProjectDate(value: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(displayDateLocale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat(displayDateLocale, { month: "short", day: "numeric" }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(displayDateLocale, { month: "long", day: "numeric" }).format(new Date(value));
}

export default App;
