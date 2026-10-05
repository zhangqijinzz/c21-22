import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProjectRepository } from "../../shared/repositories/projectRepository";
import type {
  LatencyProject,
  SimulationMode,
  WorkspaceDocument,
} from "../../shared/domain/types";
import {
  createProject,
  duplicateProject,
  renameProject,
  selectProject,
} from "../projects/projectViewModel";
import {
  addRequestNode,
  patchRequestNode,
  removeRequestNode,
  setConcurrency,
  toggleDependency,
  getGraphAnalysis,
} from "../graph-editor/graphViewModel";
import {
  compareScenarios,
  removeScenario,
  restoreScenario,
  saveScenario,
  type ScenarioComparison,
} from "../scenarios/scenarioViewModel";
import {
  buildGraphDiff,
  commitGraphApplication,
  createLiveView,
  createSnapshotView,
  LIVE_VIEW_ID,
  planGraphApplication,
  undoGraphApplication,
  type ApplicationPlan,
  type ConflictResolution,
  type GraphDiff,
  type GraphView,
  type InverseRule,
} from "../../shared/domain/liveDiff";
import { removeProject, updateProject } from "../projects/projectViewModel";
import { simulateProject } from "../../shared/domain/simulation";

export type LabStatus =
  "loading" | "ready" | "editing" | "simulating" | "error" | "completed";
export type LabModule =
  "projects" | "graph" | "simulation" | "scenarios" | "archive";

export function useLatencyLab() {
  const repository = useMemo(() => new ProjectRepository(), []);
  const [document, setDocument] = useState<WorkspaceDocument | null>(null);
  const documentRef = useRef<WorkspaceDocument | null>(null);
  const [status, setStatus] = useState<LabStatus>("loading");
  const [module, setModule] = useState<LabModule>("simulation");
  const [mode, setMode] = useState<SimulationMode>("expected");
  const [comparisonIds, setComparisonIds] = useState<{
    baselineId: string;
    comparisonId: string;
  }>({ baselineId: LIVE_VIEW_ID, comparisonId: "" });
  const [notice, setNotice] = useState("");
  const [persisted, setPersisted] = useState<"saving" | "saved" | "error">(
    "saved",
  );
  const queue = useRef(Promise.resolve());
  const revision = useRef(0);
  // 应用方案差异后的撤销记录；一旦用户手动改图就作废，避免回滚覆盖新编辑。
  const undoStack = useRef<
    { projectId: string; label: string; inverse: InverseRule[] }[]
  >([]);
  const activeProject =
    document?.projects.find(
      (project) => project.id === document.activeProjectId,
    ) ?? document?.projects[0];
  const result = useMemo(
    () => (activeProject ? simulateProject(activeProject, mode) : undefined),
    [activeProject, mode],
  );
  const graphAnalysis = useMemo(
    () => (activeProject ? getGraphAnalysis(activeProject) : undefined),
    [activeProject],
  );
  const scenarioList = activeProject?.scenarios ?? [];
  const resolveScenario = (id: string, fallbackIndex: number) =>
    scenarioList.find((scenario) => scenario.id === id) ??
    scenarioList[fallbackIndex];
  const baselineScenario =
    comparisonIds.baselineId === LIVE_VIEW_ID
      ? undefined
      : resolveScenario(comparisonIds.baselineId, 1);
  const comparisonScenario =
    comparisonIds.comparisonId === LIVE_VIEW_ID
      ? undefined
      : resolveScenario(comparisonIds.comparisonId, 0);
  const baselineIsLive = comparisonIds.baselineId === LIVE_VIEW_ID;
  const comparisonIsLive = comparisonIds.comparisonId === LIVE_VIEW_ID;
  const scenarioComparison: ScenarioComparison | undefined =
    baselineScenario && comparisonScenario
      ? compareScenarios(baselineScenario, comparisonScenario)
      : undefined;

  const liveView: GraphView | undefined = activeProject
    ? createLiveView(activeProject, mode)
    : undefined;
  const baselineView: GraphView | undefined = baselineIsLive
    ? liveView
    : baselineScenario
      ? createSnapshotView(baselineScenario)
      : undefined;
  const comparisonView: GraphView | undefined = comparisonIsLive
    ? liveView
    : comparisonScenario
      ? createSnapshotView(comparisonScenario)
      : undefined;
  // 差异视角固定为「方案 → 当前图」：live 在哪一侧就把它放到 current 位。
  const liveGraphDiff: GraphDiff | undefined =
    liveView &&
    baselineView &&
    comparisonView &&
    (baselineIsLive || comparisonIsLive)
      ? comparisonIsLive
        ? buildGraphDiff(liveView, baselineView)
        : buildGraphDiff(liveView, comparisonView)
      : undefined;
  const liveDiffScenarioName = comparisonIsLive
    ? (baselineScenario?.name ?? "")
    : (comparisonScenario?.name ?? "");
  const undoEntry = undoStack.current[undoStack.current.length - 1];
  const canUndoApply =
    Boolean(activeProject) && undoEntry?.projectId === activeProject?.id;
  const simulationValid =
    Boolean(activeProject) &&
    result?.entries.length === activeProject?.nodes.length;

  const selectComparisonScenario = useCallback(
    (side: "baselineId" | "comparisonId", id: string) => {
      setComparisonIds((current) => ({ ...current, [side]: id }));
    },
    [],
  );

  // 切换项目后，把指向不存在快照的选择修正到该项目的默认可用值。
  const activeProjectId = activeProject?.id;
  const scenarioVersion = scenarioList.map((scenario) => scenario.id).join("|");
  useEffect(() => {
    if (!activeProjectId) return;
    setComparisonIds((current) => {
      const ids = new Set(scenarioVersion ? scenarioVersion.split("|") : []);
      const fix = (id: string, preferLive: boolean): string => {
        if (id === LIVE_VIEW_ID) return LIVE_VIEW_ID;
        if (ids.has(id)) return id;
        if (preferLive && ids.size) return LIVE_VIEW_ID;
        return [...ids][0] ?? LIVE_VIEW_ID;
      };
      const baseline = fix(current.baselineId, true);
      const comparison = fix(current.comparisonId, false);
      if (
        baseline === current.baselineId &&
        comparison === current.comparisonId
      )
        return current;
      return { baselineId: baseline, comparisonId: comparison };
    });
  }, [activeProjectId, scenarioVersion]);

  useEffect(() => {
    let mounted = true;
    void repository
      .load()
      .then(({ document: loaded, recovered }) => {
        if (!mounted) return;
        documentRef.current = loaded;
        setDocument(loaded);
        setStatus("ready");
        if (recovered)
          setNotice("已载入示例工作区；后续修改会自动保存到此设备。");
      })
      .catch(() => {
        if (!mounted) return;
        setStatus("error");
        setNotice("本地项目读取失败，刷新页面可再次尝试。");
      });
    return () => {
      mounted = false;
    };
  }, [repository]);

  const commit = useCallback(
    (next: WorkspaceDocument, nextStatus: LabStatus = "editing") => {
      const currentRevision = ++revision.current;
      documentRef.current = next;
      setDocument(next);
      setStatus(nextStatus);
      setNotice("");
      setPersisted("saving");
      queue.current = queue.current
        .then(() => repository.save(next))
        .then(() => {
          if (revision.current === currentRevision) {
            setPersisted("saved");
            if (nextStatus === "editing") setStatus("completed");
          }
        })
        .catch(() => {
          if (revision.current === currentRevision) {
            setPersisted("error");
            setStatus("error");
            setNotice("保存失败。数据仍保留在当前页面，请重试保存。");
          }
        });
    },
    [repository],
  );

  const editProject = useCallback(
    (project: LatencyProject) => {
      const current = documentRef.current;
      if (current) commit(updateProject(current, project));
    },
    [commit],
  );

  // 手动编辑会让应用撤销记录失效；方案应用/撤销本身走 commitProjectChange 保留它。
  const manualEdit = useCallback(
    (project: LatencyProject) => {
      undoStack.current = undoStack.current.filter(
        (entry) => entry.projectId !== project.id,
      );
      editProject(project);
    },
    [editProject],
  );

  const commitProjectChange = useCallback(
    (project: LatencyProject) => {
      const current = documentRef.current;
      if (current) commit(updateProject(current, project));
    },
    [commit],
  );

  const chooseProject = useCallback(
    (id: string) => {
      const current = documentRef.current;
      if (current) commit(selectProject(current, id), "ready");
    },
    [commit],
  );

  const newProject = useCallback(() => {
    const current = documentRef.current;
    if (current) commit(createProject(current), "editing");
  }, [commit]);

  const renameActive = useCallback(
    (title: string) => {
      if (activeProject) editProject(renameProject(activeProject, title));
    },
    [activeProject, editProject],
  );

  const duplicateActive = useCallback(() => {
    const current = documentRef.current;
    if (current && activeProject)
      commit(duplicateProject(current, activeProject), "editing");
  }, [activeProject, commit]);

  const deleteProject = useCallback(
    (id: string) => {
      const current = documentRef.current;
      if (current && current.projects.length > 1)
        commit(removeProject(current, id), "editing");
      else setNotice("至少保留一个链路项目。");
    },
    [commit],
  );

  const addNode = useCallback(() => {
    if (activeProject) manualEdit(addRequestNode(activeProject));
  }, [activeProject, manualEdit]);
  const patchNode = useCallback(
    (id: string, patch: Parameters<typeof patchRequestNode>[2]) => {
      if (activeProject) manualEdit(patchRequestNode(activeProject, id, patch));
    },
    [activeProject, manualEdit],
  );
  const deleteNode = useCallback(
    (id: string) => {
      if (activeProject) manualEdit(removeRequestNode(activeProject, id));
    },
    [activeProject, manualEdit],
  );
  const setNodeDependency = useCallback(
    (id: string, dependencyId: string) => {
      if (!activeProject) return;
      const outcome = toggleDependency(activeProject, id, dependencyId);
      if (outcome.error) setNotice(outcome.error);
      else manualEdit(outcome.project);
    },
    [activeProject, manualEdit],
  );
  const setLimit = useCallback(
    (limit: number | null) => {
      if (activeProject) manualEdit(setConcurrency(activeProject, limit));
    },
    [activeProject, manualEdit],
  );

  const simulate = useCallback(
    (nextMode = mode) => {
      if (!activeProject) return undefined;
      setStatus("simulating");
      const result = simulateProject(activeProject, nextMode);
      setMode(nextMode);
      setStatus(
        result.warnings.some((warning) => warning.includes("循环"))
          ? "error"
          : "completed",
      );
      return result;
    },
    [activeProject, mode],
  );

  const saveSnapshot = useCallback(
    (name: string): boolean => {
      if (!activeProject) return false;
      const result = simulateProject(activeProject, mode);
      if (result.entries.length !== activeProject.nodes.length) {
        setNotice(result.warnings[0] ?? "请先修复链路配置再保存方案。");
        return false;
      }
      const next = saveScenario(activeProject, result, name);
      editProject(next);
      setComparisonIds({
        baselineId: LIVE_VIEW_ID,
        comparisonId: next.scenarios[0]?.id ?? "",
      });
      setNotice("方案快照已保存。");
      return true;
    },
    [activeProject, editProject, mode],
  );

  const removeSavedScenario = useCallback(
    (id: string) => {
      if (activeProject) editProject(removeScenario(activeProject, id));
    },
    [activeProject, editProject],
  );
  const restoreSavedScenario = useCallback(
    (id: string) => {
      if (activeProject) {
        undoStack.current = undoStack.current.filter(
          (entry) => entry.projectId !== activeProject.id,
        );
        editProject(restoreScenario(activeProject, id));
      }
    },
    [activeProject, editProject],
  );

  const planLiveApplication = useCallback(
    (selectedIds: string[]): ApplicationPlan | undefined => {
      if (!activeProject || !liveGraphDiff) return undefined;
      return planGraphApplication(
        activeProject,
        liveGraphDiff,
        selectedIds,
        mode,
      );
    },
    [activeProject, liveGraphDiff, mode],
  );

  const applyLiveDiff = useCallback(
    (
      selectedIds: string[],
      resolutions: Record<string, ConflictResolution>,
    ): { ok: boolean; error?: string } => {
      if (!activeProject || !liveGraphDiff)
        return { ok: false, error: "没有可应用的差异。" };
      const outcome = commitGraphApplication(
        activeProject,
        liveGraphDiff,
        selectedIds,
        resolutions,
        mode,
      );
      if (!outcome.project) return { ok: false, error: outcome.error };
      undoStack.current.push({
        projectId: activeProject.id,
        label: liveDiffScenarioName,
        inverse: outcome.inverse,
      });
      if (undoStack.current.length > 10) undoStack.current.shift();
      // 推演结果与保存状态随这一次原子提交同步更新。
      commitProjectChange(outcome.project);
      setNotice(
        `已将 ${selectedIds.length} 项差异应用到当前图，推演结果已同步更新。`,
      );
      return { ok: true };
    },
    [
      activeProject,
      liveGraphDiff,
      liveDiffScenarioName,
      mode,
      commitProjectChange,
    ],
  );

  const undoLastApply = useCallback(() => {
    if (!activeProject) return;
    const entry = undoStack.current[undoStack.current.length - 1];
    if (!entry || entry.projectId !== activeProject.id) return;
    const reverted = undoGraphApplication(activeProject, entry.inverse);
    undoStack.current.pop();
    commitProjectChange(reverted);
    setNotice(
      entry.label ? `已撤销自「${entry.label}」的应用。` : "已撤销上一次应用。",
    );
  }, [activeProject, commitProjectChange]);

  const retrySave = useCallback(() => {
    const current = documentRef.current;
    if (current) commit(current);
  }, [commit]);

  return {
    document,
    activeProject,
    result,
    graphAnalysis,
    simulationValid,
    status,
    module,
    setModule,
    mode,
    setMode,
    notice,
    setNotice,
    persisted,
    chooseProject,
    newProject,
    renameActive,
    duplicateActive,
    deleteProject,
    addNode,
    patchNode,
    deleteNode,
    setNodeDependency,
    setLimit,
    simulate,
    saveSnapshot,
    removeSavedScenario,
    restoreSavedScenario,
    retrySave,
    scenarioList,
    baselineScenario,
    comparisonScenario,
    scenarioComparison,
    selectComparisonScenario,
    liveGraphDiff,
    liveDiffScenarioName,
    baselineIsLive,
    comparisonIsLive,
    planLiveApplication,
    applyLiveDiff,
    undoLastApply,
    canUndoApply,
    undoLabel: undoEntry?.label ?? "",
  };
}
