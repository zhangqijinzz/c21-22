import { describe, expect, it } from "vitest";
import {
  EXAMPLE_PROJECT,
  type LatencyProject,
} from "../src/shared/domain/types";
import {
  buildGraphDiff,
  commitGraphApplication,
  createLiveView,
  createSnapshotView,
  formatFieldValue,
  planGraphApplication,
  undoGraphApplication,
  type ConflictResolution,
} from "../src/shared/domain/liveDiff";
import { saveScenario } from "../src/features/scenarios/scenarioViewModel";
import { simulateProject } from "../src/shared/domain/simulation";

function snapshotOf(project: LatencyProject, name: string) {
  const snapshot = saveScenario(
    project,
    simulateProject(project, "expected"),
    name,
  ).scenarios[0];
  if (!snapshot) throw new Error("snapshot should exist");
  return snapshot;
}

function diffFrom(live: LatencyProject, scenarioProject: LatencyProject) {
  const snapshot = snapshotOf(scenarioProject, "基准");
  return {
    diff: buildGraphDiff(
      createLiveView(live, "expected"),
      createSnapshotView(snapshot),
    ),
    snapshot,
  };
}

describe("live graph vs scenario diff", () => {
  it("lists per-node field and concurrency differences without saving a snapshot", () => {
    const scenarioProject = structuredClone(EXAMPLE_PROJECT);
    const live: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      concurrencyLimit: 2,
      nodes: structuredClone(EXAMPLE_PROJECT).nodes.map((node) =>
        node.id === "session" ? { ...node, durationMs: 999 } : node,
      ),
    };
    const { diff } = diffFrom(live, scenarioProject);
    expect(diff.items.some((item) => item.kind === "concurrency")).toBe(true);
    const durationItem = diff.items.find(
      (item) =>
        item.kind === "field" &&
        item.nodeId === "session" &&
        item.field === "durationMs",
    );
    expect(durationItem).toMatchObject({ currentValue: 999, otherValue: 280 });
    expect(diff.deltaMs).not.toBe(0);
    expect(
      formatFieldValue("dependencyIds", ["session"], diff.currentNodes),
    ).toContain("会话校验");
  });

  it("flags nodes only present on one side", () => {
    const scenarioProject = structuredClone(EXAMPLE_PROJECT);
    const live: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      nodes: [
        ...EXAMPLE_PROJECT.nodes.slice(0, 3),
        {
          ...EXAMPLE_PROJECT.nodes[3]!,
          id: "brand-new",
          name: "临时新增",
          dependencyIds: [],
          fallbackNodeId: undefined,
        },
      ],
    };
    const { diff } = diffFrom(live, scenarioProject);
    const presence = diff.items.filter((item) => item.kind === "presence");
    expect(
      presence.some(
        (item) =>
          item.kind === "presence" &&
          item.nodeId === "recommend" &&
          item.presence === "added",
      ),
    ).toBe(true);
    expect(
      presence.some(
        (item) =>
          item.kind === "presence" &&
          item.nodeId === "brand-new" &&
          item.presence === "removed",
      ),
    ).toBe(true);
  });

  it("applies a selected field group atomically and keeps simulation in sync", () => {
    const scenarioProject = structuredClone(EXAMPLE_PROJECT);
    const live: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      nodes: structuredClone(EXAMPLE_PROJECT).nodes.map((node) =>
        node.id === "session"
          ? { ...node, durationMs: 999, timeoutMs: 2000 }
          : node,
      ),
    };
    const { diff } = diffFrom(live, scenarioProject);
    const selected = diff.items
      .filter(
        (item) =>
          item.kind === "field" &&
          item.nodeId === "session" &&
          item.field === "durationMs",
      )
      .map((item) => item.id);
    const result = commitGraphApplication(live, diff, selected, {}, "expected");
    expect(result.error).toBeUndefined();
    expect(
      result.project?.nodes.find((node) => node.id === "session")?.durationMs,
    ).toBe(280);
    // 未选中的 timeout 保持当前值。
    expect(
      result.project?.nodes.find((node) => node.id === "session")?.timeoutMs,
    ).toBe(2000);
    expect(simulateProject(result.project!, "expected").entries.length).toBe(
      result.project!.nodes.length,
    );
  });

  it("restores a node deleted from the live graph when requested, or skips the item", () => {
    const scenarioProject = structuredClone(EXAMPLE_PROJECT);
    // 当前图删掉 flags；方案里 flags 仍在（recommend 依赖它）。
    const live: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      nodes: EXAMPLE_PROJECT.nodes.filter((node) => node.id !== "flags"),
    };
    const { diff } = diffFrom(live, scenarioProject);
    const addFlags = diff.items.find(
      (item) => item.kind === "presence" && item.nodeId === "flags",
    );
    expect(addFlags).toMatchObject({ presence: "added" });
    const result = commitGraphApplication(
      live,
      diff,
      [addFlags!.id],
      {},
      "expected",
    );
    expect(result.error).toBeUndefined();
    expect(result.project?.nodes.some((node) => node.id === "flags")).toBe(
      true,
    );
    expect(
      result.project?.nodes.find((node) => node.id === "recommend")
        ?.dependencyIds,
    ).toContain("flags");
  });

  it("restores a node deleted after the diff was built when the field choice requires it", () => {
    const scenarioProject = structuredClone(EXAMPLE_PROJECT);
    // 差异生成时：两边都有 session，仅耗时不同，因此 diff 中没有 session 的 presence 项。
    const diffLive: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      nodes: structuredClone(EXAMPLE_PROJECT).nodes.map((node) =>
        node.id === "session" ? { ...node, durationMs: 999 } : node,
      ),
    };
    const built = diffFrom(diffLive, scenarioProject);
    const sessionField = built.diff.items.find(
      (item) =>
        item.kind === "field" &&
        item.nodeId === "session" &&
        item.field === "durationMs",
    )!;
    expect(
      built.diff.items.some(
        (item) => item.kind === "presence" && item.nodeId === "session",
      ),
    ).toBe(false);

    // 用户在应用前删掉了 session（并清掉 profile 对它的依赖），保留图可推演。
    const liveAfterDelete: LatencyProject = {
      ...diffLive,
      nodes: diffLive.nodes
        .filter((node) => node.id !== "session")
        .map((node) => ({
          ...node,
          dependencyIds: node.dependencyIds.filter((id) => id !== "session"),
        })),
    };
    const plan = planGraphApplication(
      liveAfterDelete,
      built.diff,
      [sessionField.id],
      "expected",
    );
    const missing = plan.conflicts.find(
      (conflict) => conflict.type === "node-missing",
    );
    expect(missing).toBeDefined();

    // 未取舍 -> 拒绝提交。
    expect(
      commitGraphApplication(
        liveAfterDelete,
        built.diff,
        [sessionField.id],
        {},
        "expected",
      ).project,
    ).toBeUndefined();

    // 恢复 -> 即使 diff 里没有 presence 项，也能从方案全量节点还原并采用字段。
    const restored = commitGraphApplication(
      liveAfterDelete,
      built.diff,
      [sessionField.id],
      { [missing!.key]: "restore-node" },
      "expected",
    );
    const session = restored.project?.nodes.find(
      (node) => node.id === "session",
    );
    expect(session?.durationMs).toBe(280);
    expect(simulateProject(restored.project!, "expected").entries.length).toBe(
      restored.project!.nodes.length,
    );
  });

  it("requires a decision for reference-missing conflicts and never partially applies", () => {
    const scenarioProject = structuredClone(EXAMPLE_PROJECT);
    // 当前图删掉 catalog；方案中 recommend 的降级目标仍指向它。
    const liveWithoutCatalog: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      nodes: EXAMPLE_PROJECT.nodes
        .filter((node) => node.id !== "catalog")
        .map((node) => ({
          ...node,
          fallbackNodeId:
            node.fallbackNodeId === "catalog" ? undefined : node.fallbackNodeId,
        })),
    };
    const built = diffFrom(liveWithoutCatalog, scenarioProject);
    const fallbackItem = built.diff.items.find(
      (item) =>
        item.kind === "field" &&
        item.nodeId === "recommend" &&
        item.field === "fallbackNodeId",
    );
    expect(fallbackItem).toBeDefined();
    const plan = planGraphApplication(
      liveWithoutCatalog,
      built.diff,
      [fallbackItem!.id],
      "expected",
    );
    const refConflict = plan.conflicts.find(
      (conflict) => conflict.type === "reference-missing",
    );
    expect(refConflict).toBeDefined();

    // 未给取舍 -> 整体不生效。
    const blocked = commitGraphApplication(
      liveWithoutCatalog,
      built.diff,
      [fallbackItem!.id],
      {},
      "expected",
    );
    expect(blocked.project).toBeUndefined();
    expect(blocked.error).toContain("未作出取舍");

    // 选择清除引用 -> 原子生效，catalog 仍不回来。
    const cleared = commitGraphApplication(
      liveWithoutCatalog,
      built.diff,
      [fallbackItem!.id],
      { [refConflict!.key]: "clear-reference" } satisfies Record<
        string,
        ConflictResolution
      >,
      "expected",
    );
    expect(cleared.project).toBeDefined();
    expect(cleared.project?.nodes.some((node) => node.id === "catalog")).toBe(
      false,
    );
    expect(
      cleared.project?.nodes.find((node) => node.id === "recommend")
        ?.fallbackNodeId,
    ).toBeUndefined();

    // 选择恢复目标 -> catalog 被连带恢复。
    const restored = commitGraphApplication(
      liveWithoutCatalog,
      built.diff,
      [fallbackItem!.id],
      { [refConflict!.key]: "restore-target" } satisfies Record<
        string,
        ConflictResolution
      >,
      "expected",
    );
    expect(restored.project?.nodes.some((node) => node.id === "catalog")).toBe(
      true,
    );
    expect(
      restored.project?.nodes.find((node) => node.id === "recommend")
        ?.fallbackNodeId,
    ).toBe("catalog");
  });

  it("detects a parameter changed after the diff was built", () => {
    const scenarioProject = structuredClone(EXAMPLE_PROJECT);
    const live: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      nodes: structuredClone(EXAMPLE_PROJECT).nodes.map((node) =>
        node.id === "session" ? { ...node, durationMs: 999 } : node,
      ),
    };
    const { diff } = diffFrom(live, scenarioProject);
    const item = diff.items.find(
      (candidate) =>
        candidate.kind === "field" &&
        candidate.nodeId === "session" &&
        candidate.field === "durationMs",
    )!;
    // 用户在对比之后又改了一次参数。
    const changedLive: LatencyProject = {
      ...live,
      nodes: live.nodes.map((node) =>
        node.id === "session" ? { ...node, durationMs: 1234 } : node,
      ),
    };
    const plan = planGraphApplication(changedLive, diff, [item.id], "expected");
    const conflict = plan.conflicts.find(
      (candidate) => candidate.type === "value-changed",
    );
    expect(conflict).toBeDefined();
    const skipped = commitGraphApplication(
      changedLive,
      diff,
      [item.id],
      { [conflict!.key]: "skip-item" },
      "expected",
    );
    expect(
      skipped.project?.nodes.find((node) => node.id === "session")?.durationMs,
    ).toBe(1234);
    const taken = commitGraphApplication(
      changedLive,
      diff,
      [item.id],
      { [conflict!.key]: "take-other" },
      "expected",
    );
    expect(
      taken.project?.nodes.find((node) => node.id === "session")?.durationMs,
    ).toBe(280);
  });

  it("blocks or skips dependency changes that would introduce a cycle", () => {
    // 方案：flags 依赖 session（当前图里两者都是入口）。
    const scenarioProject: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      nodes: EXAMPLE_PROJECT.nodes.map((node) =>
        node.id === "flags" ? { ...node, dependencyIds: ["session"] } : node,
      ),
    };
    // 当前图：session 反而依赖 flags。
    const live: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      nodes: EXAMPLE_PROJECT.nodes.map((node) =>
        node.id === "session" ? { ...node, dependencyIds: ["flags"] } : node,
      ),
    };
    const { diff } = diffFrom(live, scenarioProject);
    const item = diff.items.find(
      (candidate) =>
        candidate.kind === "field" &&
        candidate.nodeId === "flags" &&
        candidate.field === "dependencyIds",
    )!;
    const plan = planGraphApplication(live, diff, [item.id], "expected");
    const conflict = plan.conflicts.find(
      (candidate) => candidate.type === "would-cycle",
    );
    expect(conflict).toBeDefined();

    const aborted = commitGraphApplication(
      live,
      diff,
      [item.id],
      { [conflict!.key]: "abort" },
      "expected",
    );
    expect(aborted.project).toBeUndefined();

    const skipped = commitGraphApplication(
      live,
      diff,
      [item.id],
      { [conflict!.key]: "skip-item" },
      "expected",
    );
    expect(
      skipped.project?.nodes.find((node) => node.id === "flags")?.dependencyIds,
    ).toEqual([]);
  });

  it("undoes an application back to the pre-apply graph", () => {
    const scenarioProject = structuredClone(EXAMPLE_PROJECT);
    const live: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      concurrencyLimit: 3,
      nodes: structuredClone(EXAMPLE_PROJECT).nodes.map((node) =>
        node.id === "session"
          ? { ...node, durationMs: 999, timeoutMs: 2000 }
          : node,
      ),
    };
    const { diff } = diffFrom(live, scenarioProject);
    const selected = diff.items.map((item) => item.id);
    const applied = commitGraphApplication(
      live,
      diff,
      selected,
      {},
      "expected",
    );
    expect(applied.project).toBeDefined();
    expect(applied.project?.concurrencyLimit).toBeNull();
    const undone = undoGraphApplication(applied.project!, applied.inverse);
    expect(undone.concurrencyLimit).toBe(3);
    expect(undone.nodes.find((node) => node.id === "session")?.durationMs).toBe(
      999,
    );
    expect(undone.nodes.find((node) => node.id === "session")?.timeoutMs).toBe(
      2000,
    );
  });

  it("undoes node deletions and restorations including references", () => {
    const scenarioProject = structuredClone(EXAMPLE_PROJECT);
    // 当前图新增一个节点，应用「删除该节点」后撤销。
    const newNode = {
      id: "extra",
      name: "临时节点",
      durationMs: 100,
      jitterMs: 0,
      dependencyIds: ["session"],
      timeoutMs: 500,
      retryCount: 0,
      failureRate: 0,
    };
    const live: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      nodes: [...EXAMPLE_PROJECT.nodes, newNode],
    };
    const { diff } = diffFrom(live, scenarioProject);
    const removeItem = diff.items.find(
      (item) => item.kind === "presence" && item.nodeId === "extra",
    )!;
    const applied = commitGraphApplication(
      live,
      diff,
      [removeItem.id],
      {},
      "expected",
    );
    expect(applied.project?.nodes.some((node) => node.id === "extra")).toBe(
      false,
    );
    const undone = undoGraphApplication(applied.project!, applied.inverse);
    const restored = undone.nodes.find((node) => node.id === "extra");
    expect(restored?.dependencyIds).toEqual(["session"]);
    expect(undone.nodes.findIndex((node) => node.id === "extra")).toBe(
      live.nodes.findIndex((node) => node.id === "extra"),
    );
  });
});
