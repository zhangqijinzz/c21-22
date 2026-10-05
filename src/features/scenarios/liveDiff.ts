import { analyzeGraph } from "../../shared/domain/graph";
import type {
  LatencyProject,
  RequestNode,
  ScenarioSnapshot,
} from "../../shared/domain/types";

export type LiveDiffKind =
  | "name"
  | "durationMs"
  | "jitterMs"
  | "timeoutMs"
  | "retryCount"
  | "failureRate"
  | "dependencies"
  | "fallback"
  | "node-added"
  | "node-removed"
  | "concurrency";

export interface LiveDiffItem {
  id: string;
  kind: LiveDiffKind;
  nodeId: string | null;
  nodeName: string;
  label: string;
  currentLabel: string;
  scenarioLabel: string;
  currentValue: unknown;
  scenarioValue: unknown;
}

export interface LiveDiffReport {
  scenarioId: string;
  scenarioName: string;
  items: LiveDiffItem[];
  currentCompletionMs: number;
  scenarioCompletionMs: number;
  budgetDeltaMs: number;
}

interface ScalarFieldDef {
  kind: LiveDiffKind;
  label: string;
  read: (node: RequestNode) => string | number;
  format: (value: string | number) => string;
}

const SCALAR_FIELDS: ScalarFieldDef[] = [
  { kind: "name", label: "名称", read: (node) => node.name, format: String },
  {
    kind: "durationMs",
    label: "耗时",
    read: (node) => node.durationMs,
    format: (value) => `${value} ms`,
  },
  {
    kind: "jitterMs",
    label: "波动",
    read: (node) => node.jitterMs,
    format: (value) => `±${value} ms`,
  },
  {
    kind: "timeoutMs",
    label: "超时",
    read: (node) => node.timeoutMs,
    format: (value) => `${value} ms`,
  },
  {
    kind: "retryCount",
    label: "重试",
    read: (node) => node.retryCount,
    format: (value) => `${value} 次`,
  },
  {
    kind: "failureRate",
    label: "失败率",
    read: (node) => node.failureRate,
    format: (value) => `${value}%`,
  },
];

function concurrencyLabel(limit: number | null): string {
  return limit ? `${limit} 路并发` : "不限并发";
}

export function computeLiveDiff(
  project: LatencyProject,
  scenario: ScenarioSnapshot,
  currentCompletionMs: number,
): LiveDiffReport {
  const nameOf = (id: string): string =>
    project.nodes.find((node) => node.id === id)?.name ??
    scenario.nodes.find((node) => node.id === id)?.name ??
    "已删除节点";
  const dependencyText = (ids: string[]): string =>
    ids.length ? ids.map(nameOf).join("、") : "无前置";
  const fallbackText = (id: string | undefined): string =>
    id ? nameOf(id) : "无降级";

  const items: LiveDiffItem[] = [];
  if (project.concurrencyLimit !== scenario.concurrencyLimit) {
    items.push({
      id: "concurrency",
      kind: "concurrency",
      nodeId: null,
      nodeName: "",
      label: "并发上限",
      currentLabel: concurrencyLabel(project.concurrencyLimit),
      scenarioLabel: concurrencyLabel(scenario.concurrencyLimit),
      currentValue: project.concurrencyLimit,
      scenarioValue: scenario.concurrencyLimit,
    });
  }

  const currentById = new Map(project.nodes.map((node) => [node.id, node]));
  const scenarioById = new Map(scenario.nodes.map((node) => [node.id, node]));
  for (const scenarioNode of scenario.nodes) {
    const current = currentById.get(scenarioNode.id);
    if (!current) {
      items.push({
        id: `${scenarioNode.id}:node-removed`,
        kind: "node-removed",
        nodeId: scenarioNode.id,
        nodeName: scenarioNode.name,
        label: `${scenarioNode.name} · 节点`,
        currentLabel: "当前图已删除",
        scenarioLabel: "方案中存在 · 应用后恢复",
        currentValue: null,
        scenarioValue: scenarioNode.id,
      });
      continue;
    }
    for (const field of SCALAR_FIELDS) {
      const currentValue = field.read(current);
      const scenarioValue = field.read(scenarioNode);
      if (currentValue !== scenarioValue) {
        items.push({
          id: `${current.id}:${field.kind}`,
          kind: field.kind,
          nodeId: current.id,
          nodeName: current.name,
          label: `${current.name} · ${field.label}`,
          currentLabel: field.format(currentValue),
          scenarioLabel: field.format(scenarioValue),
          currentValue,
          scenarioValue,
        });
      }
    }
    if (
      current.dependencyIds.join("|") !== scenarioNode.dependencyIds.join("|")
    ) {
      items.push({
        id: `${current.id}:dependencies`,
        kind: "dependencies",
        nodeId: current.id,
        nodeName: current.name,
        label: `${current.name} · 前置依赖`,
        currentLabel: dependencyText(current.dependencyIds),
        scenarioLabel: dependencyText(scenarioNode.dependencyIds),
        currentValue: [...current.dependencyIds],
        scenarioValue: [...scenarioNode.dependencyIds],
      });
    }
    if (current.fallbackNodeId !== scenarioNode.fallbackNodeId) {
      items.push({
        id: `${current.id}:fallback`,
        kind: "fallback",
        nodeId: current.id,
        nodeName: current.name,
        label: `${current.name} · 降级目标`,
        currentLabel: fallbackText(current.fallbackNodeId),
        scenarioLabel: fallbackText(scenarioNode.fallbackNodeId),
        currentValue: current.fallbackNodeId ?? null,
        scenarioValue: scenarioNode.fallbackNodeId ?? null,
      });
    }
  }
  for (const currentNode of project.nodes) {
    if (!scenarioById.has(currentNode.id)) {
      items.push({
        id: `${currentNode.id}:node-added`,
        kind: "node-added",
        nodeId: currentNode.id,
        nodeName: currentNode.name,
        label: `${currentNode.name} · 节点`,
        currentLabel: "当前图新增",
        scenarioLabel: "方案中不存在 · 应用后移除",
        currentValue: currentNode.id,
        scenarioValue: null,
      });
    }
  }

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    items,
    currentCompletionMs,
    scenarioCompletionMs: scenario.completionMs,
    budgetDeltaMs: currentCompletionMs - scenario.completionMs,
  };
}

export type ApplyResolution =
  | "applied"
  | "conflict-overwritten"
  | "skipped-missing"
  | "recreated"
  | "removed";

export interface ApplyEntry {
  itemId: string;
  label: string;
  resolution: ApplyResolution;
  detail?: string;
}

export interface ApplyOutcome {
  project: LatencyProject | null;
  entries: ApplyEntry[];
  error?: string;
}

const KIND_ORDER: Record<LiveDiffKind, number> = {
  "node-removed": 0,
  name: 1,
  durationMs: 1,
  jitterMs: 1,
  timeoutMs: 1,
  retryCount: 1,
  failureRate: 1,
  fallback: 2,
  dependencies: 3,
  "node-added": 4,
  concurrency: 5,
};

export function applyLiveDiff(
  project: LatencyProject,
  scenario: ScenarioSnapshot,
  itemIds: string[],
  diffItems: LiveDiffItem[],
): ApplyOutcome {
  const selected = diffItems
    .filter((item) => itemIds.includes(item.id))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  if (!selected.length)
    return { project: null, entries: [], error: "没有选中要应用的差异项。" };

  const scenarioById = new Map(scenario.nodes.map((node) => [node.id, node]));
  let nodes = structuredClone(project.nodes);
  let concurrencyLimit = project.concurrencyLimit;
  const entries: ApplyEntry[] = [];
  const findNode = (id: string) => nodes.find((node) => node.id === id);
  const nodeExists = (id: string) => nodes.some((node) => node.id === id);
  const conflicted = (item: LiveDiffItem, liveValue: unknown): boolean =>
    Array.isArray(item.currentValue) && Array.isArray(liveValue)
      ? (item.currentValue as unknown[]).join("|") !==
        (liveValue as unknown[]).join("|")
      : item.currentValue !== liveValue;

  for (const item of selected) {
    if (item.kind === "concurrency") {
      const liveLimit = concurrencyLimit;
      const conflict = conflicted(item, liveLimit);
      concurrencyLimit = (item.scenarioValue as number | null) ?? null;
      entries.push({
        itemId: item.id,
        label: item.label,
        resolution: conflict ? "conflict-overwritten" : "applied",
        ...(conflict
          ? {
              detail: `当前值已变为 ${concurrencyLabel(liveLimit)}，按方案值覆盖`,
            }
          : {}),
      });
      continue;
    }

    const nodeId = item.nodeId ?? "";
    if (item.kind === "node-removed") {
      const scenarioNode = scenarioById.get(nodeId);
      if (!scenarioNode) {
        entries.push({
          itemId: item.id,
          label: item.label,
          resolution: "skipped-missing",
          detail: "方案中已不存在该节点",
        });
        continue;
      }
      if (findNode(nodeId)) {
        entries.push({
          itemId: item.id,
          label: item.label,
          resolution: "applied",
          detail: "节点已存在，无需恢复",
        });
        continue;
      }
      const dependencyIds = scenarioNode.dependencyIds.filter(nodeExists);
      const dropped =
        scenarioNode.dependencyIds.length -
        dependencyIds.length +
        (scenarioNode.fallbackNodeId && !nodeExists(scenarioNode.fallbackNodeId)
          ? 1
          : 0);
      nodes.push({
        ...structuredClone(scenarioNode),
        dependencyIds,
        ...(scenarioNode.fallbackNodeId &&
        nodeExists(scenarioNode.fallbackNodeId)
          ? { fallbackNodeId: scenarioNode.fallbackNodeId }
          : { fallbackNodeId: undefined }),
      });
      entries.push({
        itemId: item.id,
        label: item.label,
        resolution: "recreated",
        ...(dropped ? { detail: `丢弃 ${dropped} 条失效引用` } : {}),
      });
      continue;
    }

    if (item.kind === "node-added") {
      if (!findNode(nodeId)) {
        entries.push({
          itemId: item.id,
          label: item.label,
          resolution: "skipped-missing",
          detail: "节点已不在当前图中",
        });
        continue;
      }
      nodes = nodes
        .filter((node) => node.id !== nodeId)
        .map((node) => ({
          ...node,
          dependencyIds: node.dependencyIds.filter((id) => id !== nodeId),
          fallbackNodeId:
            node.fallbackNodeId === nodeId ? undefined : node.fallbackNodeId,
        }));
      entries.push({
        itemId: item.id,
        label: item.label,
        resolution: "removed",
        detail: "已移除节点及其引用",
      });
      continue;
    }

    const node = findNode(nodeId);
    if (!node) {
      entries.push({
        itemId: item.id,
        label: item.label,
        resolution: "skipped-missing",
        detail: "节点已被删除，跳过此项",
      });
      continue;
    }
    const scenarioNode = scenarioById.get(nodeId);
    if (!scenarioNode) {
      entries.push({
        itemId: item.id,
        label: item.label,
        resolution: "skipped-missing",
        detail: "方案中已不存在该节点",
      });
      continue;
    }

    if (item.kind === "dependencies") {
      const liveValue = [...node.dependencyIds];
      const conflict = conflicted(item, liveValue);
      const dependencyIds = scenarioNode.dependencyIds.filter(nodeExists);
      const dropped = scenarioNode.dependencyIds.length - dependencyIds.length;
      node.dependencyIds = dependencyIds;
      const detail = [
        conflict ? "当前依赖已被改动，按方案值覆盖" : "",
        dropped ? `丢弃 ${dropped} 条失效依赖` : "",
      ]
        .filter(Boolean)
        .join("；");
      entries.push({
        itemId: item.id,
        label: item.label,
        resolution: conflict ? "conflict-overwritten" : "applied",
        ...(detail ? { detail } : {}),
      });
      continue;
    }
    if (item.kind === "fallback") {
      const liveValue = node.fallbackNodeId ?? null;
      const conflict = conflicted(item, liveValue);
      const target = scenarioNode.fallbackNodeId;
      if (target && !nodeExists(target)) {
        node.fallbackNodeId = undefined;
        entries.push({
          itemId: item.id,
          label: item.label,
          resolution: conflict ? "conflict-overwritten" : "applied",
          detail: "方案降级目标在当前图不存在，已清空降级",
        });
        continue;
      }
      node.fallbackNodeId = target;
      entries.push({
        itemId: item.id,
        label: item.label,
        resolution: conflict ? "conflict-overwritten" : "applied",
        ...(conflict ? { detail: "当前降级目标已被改动，按方案值覆盖" } : {}),
      });
      continue;
    }

    const field = SCALAR_FIELDS.find((def) => def.kind === item.kind);
    if (!field) continue;
    const liveValue = field.read(node);
    const conflict = conflicted(item, liveValue);
    const scenarioValue = field.read(scenarioNode);
    Object.assign(node, { [field.kind]: scenarioValue });
    entries.push({
      itemId: item.id,
      label: item.label,
      resolution: conflict ? "conflict-overwritten" : "applied",
      ...(conflict
        ? {
            detail: `当前值已变为 ${field.format(liveValue)}，按方案值覆盖`,
          }
        : {}),
    });
  }

  const candidate: LatencyProject = {
    ...project,
    nodes,
    concurrencyLimit,
    updatedAt: Date.now(),
  };
  const errors = analyzeGraph(candidate).validation.errors;
  if (errors.length) {
    return {
      project: null,
      entries,
      error: `应用结果未通过链路校验（${errors[0]}），本次应用已整体放弃，当前图未改动。`,
    };
  }
  return { project: candidate, entries };
}
