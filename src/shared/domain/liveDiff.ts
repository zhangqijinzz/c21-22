import { analyzeGraph } from "./graph";
import { simulateProject } from "./simulation";
import type {
  LatencyProject,
  RequestNode,
  ScenarioSnapshot,
  SimulationMode,
} from "./types";

/** 可参与对比的图：已保存快照或正在编辑的当前图。 */
export interface GraphView {
  name: string;
  isLive: boolean;
  concurrencyLimit: number | null;
  nodes: RequestNode[];
  completionMs: number;
}

export const LIVE_VIEW_ID = "__live__";

export function createLiveView(
  project: LatencyProject,
  mode: SimulationMode,
): GraphView {
  const result = simulateProject(project, mode);
  return {
    name: "正在编辑的链路",
    isLive: true,
    concurrencyLimit: project.concurrencyLimit,
    nodes: structuredClone(project.nodes),
    completionMs:
      result.entries.length === project.nodes.length ? result.completionMs : 0,
  };
}

export function createSnapshotView(snapshot: ScenarioSnapshot): GraphView {
  return {
    name: snapshot.name,
    isLive: false,
    concurrencyLimit: snapshot.concurrencyLimit,
    nodes: structuredClone(snapshot.nodes),
    completionMs: snapshot.completionMs,
  };
}

export type DiffField =
  | "durationMs"
  | "jitterMs"
  | "timeoutMs"
  | "retryCount"
  | "failureRate"
  | "fallbackNodeId"
  | "dependencyIds";

export type DiffPresence = "added" | "removed";

export interface FieldDiff {
  kind: "field";
  id: string;
  nodeId: string;
  nodeName: string;
  field: DiffField;
  /** 生成差异时当前图上的取值，用于检测「对比之后又被修改」。 */
  currentValue: unknown;
  otherValue: unknown;
}

export interface PresenceDiff {
  kind: "presence";
  id: string;
  nodeId: string;
  nodeName: string;
  presence: DiffPresence;
  node: RequestNode;
  /** 该节点在方案侧拓扑中的序号，用于按原顺序插回当前图。 */
  otherOrder: number;
}

export interface ConcurrencyDiff {
  kind: "concurrency";
  id: string;
  currentValue: number | null;
  otherValue: number | null;
}

export type DiffItem = FieldDiff | PresenceDiff | ConcurrencyDiff;

export interface GraphDiff {
  items: DiffItem[];
  currentNodes: RequestNode[];
  otherNodes: RequestNode[];
  currentCompletionMs: number;
  otherCompletionMs: number;
  deltaMs: number;
}

export const FIELD_META: Record<DiffField, { label: string; suffix: string }> =
  {
    durationMs: { label: "预计耗时", suffix: " ms" },
    jitterMs: { label: "延迟波动", suffix: " ms" },
    timeoutMs: { label: "超时阈值", suffix: " ms" },
    retryCount: { label: "重试次数", suffix: " 次" },
    failureRate: { label: "失败概率", suffix: "%" },
    fallbackNodeId: { label: "降级目标", suffix: "" },
    dependencyIds: { label: "前置依赖", suffix: "" },
  };

function nameOf(nodes: RequestNode[], id: string | undefined): string {
  if (!id) return "";
  return nodes.find((node) => node.id === id)?.name ?? "已删除节点";
}

/** 格式化字段取值，引用在给定图中解析成节点名。 */
export function formatFieldValue(
  field: DiffField,
  value: unknown,
  contextNodes: RequestNode[],
): string {
  if (field === "dependencyIds") {
    const ids = Array.isArray(value) ? (value as string[]) : [];
    if (!ids.length) return "无";
    return ids.map((id) => nameOf(contextNodes, id)).join("、");
  }
  if (field === "fallbackNodeId") {
    if (!value) return "不降级";
    return nameOf(contextNodes, String(value));
  }
  return `${value}${FIELD_META[field].suffix}`;
}

const DIFF_FIELDS: DiffField[] = [
  "durationMs",
  "jitterMs",
  "timeoutMs",
  "retryCount",
  "failureRate",
  "fallbackNodeId",
  "dependencyIds",
];

function sameFieldValue(field: DiffField, a: unknown, b: unknown): boolean {
  if (field === "dependencyIds") {
    const left = Array.isArray(a) ? [...(a as string[])].sort() : [];
    const right = Array.isArray(b) ? [...(b as string[])].sort() : [];
    return left.join("|") === right.join("|");
  }
  return a === b;
}

/**
 * 逐项对比当前图与另一张图（通常是已保存方案）。
 * 视角固定为「方案 → 当前图」：added = 方案里有、当前图没有。
 */
export function buildGraphDiff(
  current: GraphView,
  other: GraphView,
): GraphDiff {
  const currentById = new Map(current.nodes.map((node) => [node.id, node]));
  const otherById = new Map(other.nodes.map((node) => [node.id, node]));
  const items: DiffItem[] = [];

  if (current.concurrencyLimit !== other.concurrencyLimit)
    items.push({
      kind: "concurrency",
      id: "concurrency",
      currentValue: current.concurrencyLimit,
      otherValue: other.concurrencyLimit,
    });

  other.nodes.forEach((otherNode, otherOrder) => {
    const currentNode = currentById.get(otherNode.id);
    if (!currentNode) {
      items.push({
        kind: "presence",
        id: `presence:${otherNode.id}`,
        nodeId: otherNode.id,
        nodeName: otherNode.name,
        presence: "added",
        node: structuredClone(otherNode),
        otherOrder,
      });
      return;
    }
    for (const field of DIFF_FIELDS) {
      if (!sameFieldValue(field, currentNode[field], otherNode[field])) {
        items.push({
          kind: "field",
          id: `field:${otherNode.id}:${field}`,
          nodeId: otherNode.id,
          nodeName: otherNode.name,
          field,
          currentValue: currentNode[field],
          otherValue: otherNode[field],
        });
      }
    }
  });
  for (const currentNode of current.nodes) {
    if (!otherById.has(currentNode.id))
      items.push({
        kind: "presence",
        id: `presence:${currentNode.id}`,
        nodeId: currentNode.id,
        nodeName: currentNode.name,
        presence: "removed",
        node: structuredClone(currentNode),
        otherOrder: -1,
      });
  }

  return {
    items,
    currentNodes: structuredClone(current.nodes),
    otherNodes: structuredClone(other.nodes),
    currentCompletionMs: current.completionMs,
    otherCompletionMs: other.completionMs,
    deltaMs: other.completionMs - current.completionMs,
  };
}

export type ConflictType =
  "node-missing" | "reference-missing" | "value-changed" | "would-cycle";

export type ConflictResolution =
  | "restore-node"
  | "restore-target"
  | "clear-reference"
  | "take-other"
  | "skip-item"
  | "abort";

export interface ConflictOption {
  value: ConflictResolution;
  label: string;
}

export interface DiffConflict {
  key: string;
  type: ConflictType;
  itemId: string;
  nodeId: string;
  summary: string;
  detail: string;
  options: ConflictOption[];
  defaultResolution: ConflictResolution;
}

export interface InverseRule {
  type: "restore-node" | "remove-node" | "patch-fields" | "concurrency";
  nodeId?: string;
  node?: RequestNode;
  index?: number;
  fields?: Partial<RequestNode>;
  value?: number | null;
}

export interface ApplicationPlan {
  conflicts: DiffConflict[];
  /** 默认取舍下的预计完成预算；结果不可推演时缺省。 */
  estimatedCompletionMs?: number;
}

export interface CommitResult {
  project?: LatencyProject;
  inverse: InverseRule[];
  conflicts: DiffConflict[];
  error?: string;
}

function conflictSummary(type: ConflictType, nodeName: string): string {
  switch (type) {
    case "node-missing":
      return `「${nodeName}」已从当前图删除`;
    case "reference-missing":
      return `「${nodeName}」引用了当前图不存在的节点`;
    case "value-changed":
      return `「${nodeName}」在对比之后又被修改`;
    case "would-cycle":
      return `「${nodeName}」的方案依赖会形成循环`;
  }
}

function makeConflict(
  type: ConflictType,
  key: string,
  itemId: string,
  nodeId: string,
  nodeName: string,
  detail: string,
  options: ConflictOption[],
  defaultResolution: ConflictResolution,
): DiffConflict {
  return {
    key,
    type,
    itemId,
    nodeId,
    summary: conflictSummary(type, nodeName),
    detail,
    options,
    defaultResolution,
  };
}

interface PlannerState {
  project: LatencyProject;
  diff: GraphDiff;
  selected: Set<string>;
  resolutions: Record<string, ConflictResolution>;
  conflicts: DiffConflict[];
  aborted: boolean;
  /** 工作区中的节点（可变克隆），id -> 同一对象引用。 */
  nodes: RequestNode[];
  byId: Map<string, RequestNode>;
  /** 原本在当前图存在的节点 id。 */
  liveIds: Set<string>;
  /** 方案侧节点全量（含未选择增删的）。 */
  snapshotById: Map<string, RequestNode>;
  /** 最终图里新增/恢复出来的节点 id。 */
  introducedIds: Set<string>;
  /** 被选择删除的原节点 id。 */
  removedIds: Set<string>;
  /** 已处理完悬空引用的引入节点。 */
  refsResolvedIds: Set<string>;
  inverseFields: Map<string, Partial<RequestNode>>;
  inverseConcurrency: { value: number | null } | null;
}

function resolutionOf(
  state: PlannerState,
  key: string,
  fallback: ConflictResolution,
): ConflictResolution {
  return state.resolutions[key] ?? fallback;
}

/**
 * 引入方案侧节点。可能由「新增节点」「恢复已删节点」「恢复缺失引用目标」触发；
 * 若该 id 原本在当前图被选择删除，则取消删除语义（节点以方案值回来）。
 */
function introduceNode(
  state: PlannerState,
  nodeId: string,
): RequestNode | undefined {
  const existing = state.byId.get(nodeId);
  if (existing) return existing;
  const source = state.snapshotById.get(nodeId);
  if (!source) return undefined;
  const node = structuredClone(source);
  state.nodes.push(node);
  state.byId.set(nodeId, node);
  state.introducedIds.add(nodeId);
  state.removedIds.delete(nodeId);
  return node;
}

/** 选择集合生成应用计划；冲突给默认取舍并继续，以便估算默认结果的预算。 */
export function planGraphApplication(
  project: LatencyProject,
  diff: GraphDiff,
  selectedIds: string[],
  mode: SimulationMode,
): ApplicationPlan {
  const state = createPlannerState(project, diff, selectedIds, {});
  runPlanner(state);
  const candidate: LatencyProject = {
    ...project,
    nodes: state.nodes,
    concurrencyLimit: readConcurrency(state),
  };
  const analysis = analyzeGraph(candidate);
  const simulated = simulateProject(candidate, mode);
  const clean =
    !state.aborted &&
    !analysis.validation.errors.length &&
    simulated.entries.length === candidate.nodes.length;
  return {
    conflicts: state.conflicts,
    estimatedCompletionMs: clean ? simulated.completionMs : undefined,
  };
}

function createPlannerState(
  project: LatencyProject,
  diff: GraphDiff,
  selectedIds: string[],
  resolutions: Record<string, ConflictResolution>,
): PlannerState {
  // 方案侧全量节点：差异生成后当前图若又删了节点（陈旧差异），
  // 恢复节点/引用目标时仍能拿到方案侧定义。
  const snapshotById = new Map(diff.otherNodes.map((node) => [node.id, node]));
  return {
    project,
    diff,
    selected: new Set(selectedIds),
    resolutions,
    conflicts: [],
    aborted: false,
    nodes: [],
    byId: new Map(),
    liveIds: new Set(project.nodes.map((node) => node.id)),
    snapshotById,
    introducedIds: new Set(),
    removedIds: new Set(),
    refsResolvedIds: new Set(),
    inverseFields: new Map(),
    inverseConcurrency: null,
  };
}

function remember(state: PlannerState, conflict: DiffConflict): DiffConflict {
  const existing = state.conflicts.find((item) => item.key === conflict.key);
  if (existing) return existing;
  state.conflicts.push(conflict);
  return conflict;
}

function contextNodesFor(state: PlannerState): RequestNode[] {
  // 名称解析优先取方案侧，再退回当前图。
  return [...state.snapshotById.values(), ...state.project.nodes];
}

function runPlanner(state: PlannerState): void {
  const { project, diff, selected } = state;

  // 阶段 1：结构选择 —— 删除。
  for (const item of diff.items) {
    if (
      item.kind === "presence" &&
      item.presence === "removed" &&
      selected.has(item.id)
    )
      state.removedIds.add(item.nodeId);
  }
  // 初始工作集：未被删除的当前节点。
  for (const node of project.nodes) {
    if (state.removedIds.has(node.id)) continue;
    const clone = structuredClone(node);
    state.nodes.push(clone);
    state.byId.set(clone.id, clone);
  }

  // 阶段 2：显式新增 + 字段项指向已删节点的 node-missing 冲突。
  const additions: { order: number; nodeId: string }[] = [];
  for (const item of diff.items) {
    if (
      item.kind === "presence" &&
      item.presence === "added" &&
      selected.has(item.id)
    )
      additions.push({ order: item.otherOrder, nodeId: item.nodeId });
  }
  for (const item of diff.items) {
    if (item.kind !== "field" || !selected.has(item.id)) continue;
    const presenceItem = diff.items.find(
      (candidate) =>
        candidate.kind === "presence" &&
        candidate.nodeId === item.nodeId &&
        candidate.presence === "added",
    );
    const coveredByAdd =
      presenceItem?.kind === "presence" && selected.has(presenceItem.id);
    if (state.liveIds.has(item.nodeId) || coveredByAdd) continue;
    const key = `node-missing:${item.id}`;
    remember(
      state,
      makeConflict(
        "node-missing",
        key,
        item.id,
        item.nodeId,
        item.nodeName,
        `方案里「${item.nodeName}」仍然存在并带有要应用的参数，但该节点已从当前图删除。`,
        [
          { value: "restore-node", label: "恢复该节点并应用参数" },
          { value: "skip-item", label: "不恢复，跳过这一项" },
        ],
        "restore-node",
      ),
    );
    if (resolutionOf(state, key, "restore-node") === "restore-node") {
      const presence = diff.items.find(
        (candidate) =>
          candidate.kind === "presence" && candidate.nodeId === item.nodeId,
      );
      additions.push({
        order:
          presence?.kind === "presence"
            ? presence.otherOrder
            : Number.MAX_SAFE_INTEGER,
        nodeId: item.nodeId,
      });
    }
  }
  for (const add of additions.sort((a, b) => a.order - b.order))
    introduceNode(state, add.nodeId);

  // 阶段 3：字段应用。
  for (const item of diff.items) {
    if (item.kind !== "field" || !selected.has(item.id)) continue;
    const node = state.byId.get(item.nodeId);
    if (!node) continue; // node-missing 选择跳过。
    const liveNode = state.project.nodes.find(
      (entry) => entry.id === item.nodeId,
    );

    // 两侧同一参数冲突：差异生成后当前值又变了。
    if (
      liveNode &&
      !sameFieldValue(item.field, item.currentValue, liveNode[item.field])
    ) {
      const key = `value-changed:${item.id}`;
      remember(
        state,
        makeConflict(
          "value-changed",
          key,
          item.id,
          item.nodeId,
          item.nodeName,
          `方案取值为「${formatFieldValue(item.field, item.otherValue, contextNodesFor(state))}」，生成对比后该项已被改成「${formatFieldValue(item.field, liveNode[item.field], state.project.nodes)}」。`,
          [
            { value: "take-other", label: "采用方案取值" },
            { value: "skip-item", label: "保留当前取值" },
          ],
          "take-other",
        ),
      );
      if (resolutionOf(state, key, "take-other") === "skip-item") continue;
    }

    if (item.field === "fallbackNodeId") {
      applyFallbackField(state, item, node, liveNode);
      continue;
    }
    if (item.field === "dependencyIds") {
      applyDependencyField(state, item, node, liveNode);
      if (state.aborted) return;
      continue;
    }
    if (liveNode)
      state.inverseFields.set(item.nodeId, {
        ...state.inverseFields.get(item.nodeId),
        [item.field]: liveNode[item.field as keyof RequestNode],
      });
    Object.assign(node, { [item.field]: item.otherValue });
  }

  // 阶段 4：被删节点带走保留节点上的引用。
  for (const node of state.nodes) {
    if (node.dependencyIds.some((id) => state.removedIds.has(id)))
      node.dependencyIds = node.dependencyIds.filter(
        (id) => !state.removedIds.has(id),
      );
    if (node.fallbackNodeId && state.removedIds.has(node.fallbackNodeId))
      node.fallbackNodeId = undefined;
  }

  // 阶段 5：引入节点自带的悬空引用取舍（恢复节点可能连锁带出更多节点）。
  resolveIntroducedReferences(state);

  // 阶段 6：并发上限。
  const concurrencyItem = diff.items.find(
    (candidate) =>
      candidate.kind === "concurrency" && selected.has(candidate.id),
  );
  if (concurrencyItem?.kind === "concurrency")
    state.inverseConcurrency = { value: project.concurrencyLimit };
}

function readConcurrency(state: PlannerState): number | null {
  const item = state.diff.items.find(
    (candidate) => candidate.kind === "concurrency",
  );
  if (item?.kind === "concurrency" && state.selected.has(item.id))
    return item.otherValue as number | null;
  return state.project.concurrencyLimit;
}

function applyFallbackField(
  state: PlannerState,
  item: FieldDiff,
  node: RequestNode,
  liveNode: RequestNode | undefined,
): void {
  const targetId = (item.otherValue as string | undefined) ?? undefined;
  if (targetId && !state.byId.has(targetId)) {
    const key = `reference-missing:${item.id}`;
    const referenced = state.snapshotById.get(targetId);
    remember(
      state,
      makeConflict(
        "reference-missing",
        key,
        item.id,
        item.nodeId,
        item.nodeName,
        `方案中的降级目标「${referenced?.name ?? "已删除节点"}」在当前图不存在。`,
        [
          {
            value: "restore-target",
            label: `恢复降级目标「${referenced?.name ?? "已删除节点"}」`,
          },
          { value: "clear-reference", label: "清除降级目标" },
          { value: "skip-item", label: "保留当前取值" },
        ],
        "restore-target",
      ),
    );
    const decision = resolutionOf(state, key, "restore-target");
    if (decision === "skip-item") return;
    if (decision === "restore-target") {
      introduceNode(state, targetId);
    } else {
      node.fallbackNodeId = undefined;
      if (liveNode)
        state.inverseFields.set(item.nodeId, {
          ...state.inverseFields.get(item.nodeId),
          fallbackNodeId: liveNode.fallbackNodeId,
        });
      return;
    }
  }
  if (liveNode)
    state.inverseFields.set(item.nodeId, {
      ...state.inverseFields.get(item.nodeId),
      fallbackNodeId: liveNode.fallbackNodeId,
    });
  node.fallbackNodeId = targetId;
}

function applyDependencyField(
  state: PlannerState,
  item: FieldDiff,
  node: RequestNode,
  liveNode: RequestNode | undefined,
): void {
  const wanted = [...(item.otherValue as string[])];
  let keepCurrent = false;
  const usable: string[] = [];
  for (const depId of wanted) {
    if (state.byId.has(depId)) {
      usable.push(depId);
      continue;
    }
    const key = `reference-missing:${item.id}:${depId}`;
    const referenced = state.snapshotById.get(depId);
    remember(
      state,
      makeConflict(
        "reference-missing",
        key,
        item.id,
        item.nodeId,
        item.nodeName,
        `方案中的前置节点「${referenced?.name ?? "已删除节点"}」在当前图不存在。`,
        [
          {
            value: "restore-target",
            label: `恢复前置节点「${referenced?.name ?? "已删除节点"}」`,
          },
          { value: "clear-reference", label: "忽略这条依赖" },
          { value: "skip-item", label: "保留当前依赖，整项不动" },
        ],
        "restore-target",
      ),
    );
    const decision = resolutionOf(state, key, "restore-target");
    if (decision === "skip-item") {
      keepCurrent = true;
      break;
    }
    if (decision === "restore-target") {
      introduceNode(state, depId);
      if (state.byId.has(depId)) usable.push(depId);
    }
  }
  if (keepCurrent) return;

  const previousDeps = [...node.dependencyIds];
  node.dependencyIds = usable;
  if (analyzeGraph({ ...state.project, nodes: state.nodes }).cycle.length) {
    const key = `would-cycle:${item.id}`;
    remember(
      state,
      makeConflict(
        "would-cycle",
        key,
        item.id,
        item.nodeId,
        item.nodeName,
        "采用这组前置依赖会让当前图形成循环，推演将无法运行。",
        [
          { value: "skip-item", label: "保留当前依赖，跳过这一项" },
          { value: "abort", label: "终止整组应用" },
        ],
        "skip-item",
      ),
    );
    const decision = resolutionOf(state, key, "skip-item");
    if (decision === "abort") {
      state.aborted = true;
      return;
    }
    if (liveNode) node.dependencyIds = [...liveNode.dependencyIds];
    else node.dependencyIds = previousDeps;
    return;
  }
  if (liveNode)
    state.inverseFields.set(item.nodeId, {
      ...state.inverseFields.get(item.nodeId),
      dependencyIds: [...liveNode.dependencyIds],
    });
}

function resolveIntroducedReferences(state: PlannerState): void {
  // 解算可能连锁引入新节点，循环到收敛。
  let progressed = true;
  while (progressed) {
    progressed = false;
    const pending = state.nodes.filter(
      (node) =>
        state.introducedIds.has(node.id) && !state.refsResolvedIds.has(node.id),
    );
    for (const node of pending) {
      progressed = true;
      for (const depId of [...node.dependencyIds]) {
        if (state.byId.has(depId)) continue;
        const key = `reference-missing:presence:${node.id}:dep:${depId}`;
        const referenced = state.snapshotById.get(depId);
        remember(
          state,
          makeConflict(
            "reference-missing",
            key,
            `presence:${node.id}`,
            node.id,
            node.name,
            `恢复节点「${node.name}」会带回前置节点「${referenced?.name ?? "已删除节点"}」，它在当前图不存在。`,
            [
              {
                value: "restore-target",
                label: `恢复前置节点「${referenced?.name ?? "已删除节点"}」`,
              },
              { value: "clear-reference", label: "忽略这条依赖" },
            ],
            "restore-target",
          ),
        );
        if (resolutionOf(state, key, "restore-target") === "restore-target")
          introduceNode(state, depId);
        else
          node.dependencyIds = node.dependencyIds.filter((id) => id !== depId);
      }
      if (node.fallbackNodeId && !state.byId.has(node.fallbackNodeId)) {
        const targetId = node.fallbackNodeId;
        const key = `reference-missing:presence:${node.id}:fallback`;
        const referenced = state.snapshotById.get(targetId);
        remember(
          state,
          makeConflict(
            "reference-missing",
            key,
            `presence:${node.id}`,
            node.id,
            node.name,
            `恢复节点「${node.name}」会带回降级目标「${referenced?.name ?? "已删除节点"}」，它在当前图不存在。`,
            [
              {
                value: "restore-target",
                label: `恢复降级目标「${referenced?.name ?? "已删除节点"}」`,
              },
              { value: "clear-reference", label: "清除降级目标" },
            ],
            "restore-target",
          ),
        );
        if (resolutionOf(state, key, "restore-target") === "restore-target")
          introduceNode(state, targetId);
        else node.fallbackNodeId = undefined;
      }
      state.refsResolvedIds.add(node.id);
    }
  }
}

/**
 * 带用户取舍原子提交。
 * 任一冲突未解算、选择终止、解算连锁产生新冲突或结果无法推演时，整体不生效。
 */
export function commitGraphApplication(
  project: LatencyProject,
  diff: GraphDiff,
  selectedIds: string[],
  resolutions: Record<string, ConflictResolution>,
  mode: SimulationMode,
): CommitResult {
  // 预检：默认取舍下的全部冲突闭包。
  const previewState = createPlannerState(project, diff, selectedIds, {});
  runPlanner(previewState);
  const previewKeys = new Set(previewState.conflicts.map((item) => item.key));
  for (const key of previewKeys) {
    if (!(key in resolutions))
      return {
        inverse: [],
        conflicts: previewState.conflicts,
        error: "仍有冲突未作出取舍，整组改动未生效。",
      };
  }
  if ([...previewKeys].some((key) => resolutions[key] === "abort"))
    return {
      inverse: [],
      conflicts: previewState.conflicts,
      error: "已选择终止应用，未做任何改动。",
    };

  const state = createPlannerState(project, diff, selectedIds, resolutions);
  runPlanner(state);
  if (state.aborted)
    return {
      inverse: [],
      conflicts: state.conflicts,
      error: "依赖会形成循环，整组改动未生效。",
    };
  // 「恢复缺失节点」是用户的显式取舍，连锁带出的新引用缺失按默认取舍继续，
  // 但仍在结果中列出每一项取舍结果供用户复核；只有终止级冲突会阻止提交。
  const blockingConflicts = state.conflicts.filter(
    (conflict) =>
      !previewKeys.has(conflict.key) &&
      conflict.options.some((option) => option.value === "abort"),
  );
  if (blockingConflicts.length)
    return {
      inverse: [],
      conflicts: state.conflicts,
      error: "取舍解算连锁出了需要终止级别决定的冲突，整组改动尚未生效。",
    };

  const concurrencyLimit = readConcurrency(state);
  const nextProject: LatencyProject = {
    ...project,
    nodes: state.nodes.map((node) => structuredClone(node)),
    concurrencyLimit,
    updatedAt: Date.now(),
  };
  const analysis = analyzeGraph(nextProject);
  if (analysis.validation.errors.length)
    return {
      inverse: [],
      conflicts: state.conflicts,
      error: "应用后的链路无法通过校验，整组改动未生效。",
    };
  const simulated = simulateProject(nextProject, mode);
  if (simulated.entries.length !== nextProject.nodes.length)
    return {
      inverse: [],
      conflicts: state.conflicts,
      error: "应用后的链路无法推演，整组改动未生效。",
    };

  return {
    project: nextProject,
    inverse: buildInverse(project, nextProject, state),
    conflicts: state.conflicts,
  };
}

/** 对比原始/最终图生成逆向规则，保证撤销能精确回到应用前。 */
function buildInverse(
  before: LatencyProject,
  after: LatencyProject,
  state: PlannerState,
): InverseRule[] {
  const inverse: InverseRule[] = [];
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  const afterIds = new Set(after.nodes.map((node) => node.id));

  if (state.inverseConcurrency)
    inverse.push({
      type: "concurrency",
      value: state.inverseConcurrency.value,
    });

  // 记录应用过程中真正改动过的字段（含被删除又连锁恢复的原节点）。
  for (const [nodeId, fields] of state.inverseFields) {
    if (!Object.keys(fields).length) continue;
    if (afterIds.has(nodeId))
      inverse.push({ type: "patch-fields", nodeId, fields });
  }
  for (const node of before.nodes) {
    if (!afterIds.has(node.id))
      inverse.push({
        type: "restore-node",
        nodeId: node.id,
        node: structuredClone(node),
        index: before.nodes.findIndex((item) => item.id === node.id),
      });
  }
  for (const nodeId of afterIds) {
    if (!beforeById.has(nodeId)) inverse.push({ type: "remove-node", nodeId });
  }
  return inverse;
}

/** 用一组逆向规则撤销一次应用；若期间图已被改动，仅回滚仍然安全的部分。 */
export function undoGraphApplication(
  project: LatencyProject,
  inverse: InverseRule[],
): LatencyProject {
  const nodes = project.nodes.map((node) => ({ ...node }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let concurrencyLimit = project.concurrencyLimit;

  for (const rule of inverse) {
    if (rule.type === "concurrency") {
      concurrencyLimit = rule.value ?? null;
      continue;
    }
    if (rule.type === "remove-node") {
      const index = nodes.findIndex((node) => node.id === rule.nodeId);
      if (index >= 0) nodes.splice(index, 1);
      byId.delete(rule.nodeId ?? "");
      continue;
    }
    if (rule.type === "restore-node" && rule.node) {
      if (!byId.has(rule.node.id)) {
        const restored = structuredClone(rule.node);
        const index = Math.min(rule.index ?? nodes.length, nodes.length);
        nodes.splice(index, 0, restored);
        byId.set(restored.id, restored);
      }
      continue;
    }
    if (rule.type === "patch-fields" && rule.nodeId && rule.fields) {
      const node = byId.get(rule.nodeId);
      if (node) Object.assign(node, structuredClone(rule.fields));
    }
  }

  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    node.dependencyIds = node.dependencyIds.filter((id) => ids.has(id));
    if (node.fallbackNodeId && !ids.has(node.fallbackNodeId))
      node.fallbackNodeId = undefined;
  }
  if (analyzeGraph({ ...project, nodes }).validation.errors.length)
    return project;
  return { ...project, nodes, concurrencyLimit, updatedAt: Date.now() };
}
