import { describe, expect, it } from "vitest";
import {
  applyLiveDiff,
  computeLiveDiff,
  type LiveDiffItem,
} from "../src/features/scenarios/liveDiff";
import { saveScenario } from "../src/features/scenarios/scenarioViewModel";
import { simulateProject } from "../src/shared/domain/simulation";
import type {
  LatencyProject,
  ScenarioSnapshot,
} from "../src/shared/domain/types";
import { EXAMPLE_PROJECT } from "../src/shared/domain/types";

function makeScenario(
  project: LatencyProject,
  name = "基准",
): ScenarioSnapshot {
  const snapshot = saveScenario(project, simulateProject(project), name)
    .scenarios[0];
  if (!snapshot) throw new Error("Scenario fixture should be saved");
  return snapshot;
}

function itemIds(items: LiveDiffItem[], ...kinds: string[]): string[] {
  return items
    .filter((item) => kinds.includes(item.kind))
    .map((item) => item.id);
}

describe("live diff between current graph and a scenario", () => {
  it("reports per-item differences and the budget gap without a snapshot", () => {
    const scenario = makeScenario(EXAMPLE_PROJECT);
    const edited: LatencyProject = {
      ...EXAMPLE_PROJECT,
      concurrencyLimit: 2,
      nodes: EXAMPLE_PROJECT.nodes.map((node, index) =>
        index === 0
          ? { ...node, durationMs: 500, dependencyIds: ["flags"] }
          : node,
      ),
    };
    const report = computeLiveDiff(
      edited,
      scenario,
      simulateProject(edited).completionMs,
    );
    const kinds = report.items.map((item) => item.kind);
    expect(kinds).toContain("concurrency");
    expect(kinds).toContain("durationMs");
    expect(kinds).toContain("dependencies");
    expect(report.budgetDeltaMs).toBe(
      report.currentCompletionMs - scenario.completionMs,
    );
    expect(
      report.items.find((item) => item.kind === "durationMs")?.label,
    ).toContain("会话校验");
  });

  it("flags nodes added or removed relative to the scenario", () => {
    const scenario = makeScenario(EXAMPLE_PROJECT);
    const edited: LatencyProject = {
      ...EXAMPLE_PROJECT,
      nodes: [
        ...EXAMPLE_PROJECT.nodes.filter((node) => node.id !== "flags"),
        {
          id: "extra",
          name: "临时探测",
          durationMs: 100,
          jitterMs: 0,
          dependencyIds: [],
          timeoutMs: 500,
          retryCount: 0,
          failureRate: 0,
        },
      ],
    };
    const report = computeLiveDiff(edited, scenario, 0);
    const removed = report.items.find((item) => item.kind === "node-removed");
    const added = report.items.find((item) => item.kind === "node-added");
    expect(removed?.nodeId).toBe("flags");
    expect(added?.nodeId).toBe("extra");
  });

  it("applies only the selected items to the current graph", () => {
    const scenario = makeScenario(EXAMPLE_PROJECT);
    const edited: LatencyProject = {
      ...EXAMPLE_PROJECT,
      concurrencyLimit: 1,
      nodes: EXAMPLE_PROJECT.nodes.map((node) =>
        node.id === "session" ? { ...node, durationMs: 999 } : node,
      ),
    };
    const diff = computeLiveDiff(edited, scenario, 0).items;
    const outcome = applyLiveDiff(
      edited,
      scenario,
      itemIds(diff, "durationMs"),
      diff,
    );
    expect(outcome.error).toBeUndefined();
    const next = outcome.project;
    expect(next?.nodes.find((node) => node.id === "session")?.durationMs).toBe(
      280,
    );
    expect(next?.concurrencyLimit).toBe(1);
    expect(
      outcome.entries.every((entry) => entry.resolution === "applied"),
    ).toBe(true);
  });

  it("reverts an added node and cleans its references", () => {
    const scenario = makeScenario(EXAMPLE_PROJECT);
    const edited: LatencyProject = {
      ...EXAMPLE_PROJECT,
      nodes: [
        ...EXAMPLE_PROJECT.nodes.map((node) =>
          node.id === "session"
            ? { ...node, dependencyIds: ["extra"], fallbackNodeId: "extra" }
            : node,
        ),
        {
          id: "extra",
          name: "临时探测",
          durationMs: 100,
          jitterMs: 0,
          dependencyIds: [],
          timeoutMs: 500,
          retryCount: 0,
          failureRate: 0,
        },
      ],
    };
    const diff = computeLiveDiff(edited, scenario, 0).items;
    const outcome = applyLiveDiff(
      edited,
      scenario,
      itemIds(diff, "node-added"),
      diff,
    );
    const next = outcome.project;
    expect(next?.nodes.some((node) => node.id === "extra")).toBe(false);
    const session = next?.nodes.find((node) => node.id === "session");
    expect(session?.dependencyIds).toEqual([]);
    expect(session?.fallbackNodeId).toBeUndefined();
    expect(outcome.entries[0]?.resolution).toBe("removed");
  });

  it("recreates a node that was deleted from the current graph", () => {
    const scenario = makeScenario(EXAMPLE_PROJECT);
    const edited: LatencyProject = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes
        .filter((node) => node.id !== "profile")
        .map((node) => ({
          ...node,
          dependencyIds: node.dependencyIds.filter((id) => id !== "profile"),
        })),
    };
    const diff = computeLiveDiff(edited, scenario, 0).items;
    const outcome = applyLiveDiff(
      edited,
      scenario,
      itemIds(diff, "node-removed"),
      diff,
    );
    const recreated = outcome.project?.nodes.find(
      (node) => node.id === "profile",
    );
    expect(recreated?.durationMs).toBe(460);
    expect(recreated?.dependencyIds).toEqual(["session"]);
    expect(outcome.entries[0]?.resolution).toBe("recreated");
  });

  it("skips items whose node was deleted after the diff was computed", () => {
    const scenario = makeScenario(EXAMPLE_PROJECT);
    const edited: LatencyProject = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.map((node) =>
        node.id === "session" || node.id === "flags"
          ? { ...node, durationMs: 999 }
          : node,
      ),
    };
    const diff = computeLiveDiff(edited, scenario, 0).items;
    const sessionGone: LatencyProject = {
      ...edited,
      nodes: edited.nodes
        .filter((node) => node.id !== "session")
        .map((node) => ({
          ...node,
          dependencyIds: node.dependencyIds.filter((id) => id !== "session"),
        })),
    };
    const outcome = applyLiveDiff(
      sessionGone,
      scenario,
      itemIds(diff, "durationMs"),
      diff,
    );
    const skipped = outcome.entries.find((entry) =>
      entry.itemId.startsWith("session:"),
    );
    const kept = outcome.entries.find((entry) =>
      entry.itemId.startsWith("flags:"),
    );
    expect(skipped?.resolution).toBe("skipped-missing");
    expect(kept?.resolution).toBe("applied");
    expect(
      outcome.project?.nodes.find((node) => node.id === "flags")?.durationMs,
    ).toBe(210);
  });

  it("resolves same-parameter conflicts in favor of the scenario and reports them", () => {
    const scenario = makeScenario(EXAMPLE_PROJECT);
    const edited: LatencyProject = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.map((node) =>
        node.id === "session" ? { ...node, durationMs: 500 } : node,
      ),
    };
    const diff = computeLiveDiff(edited, scenario, 0).items;
    const changedAgain: LatencyProject = {
      ...edited,
      nodes: edited.nodes.map((node) =>
        node.id === "session" ? { ...node, durationMs: 640 } : node,
      ),
    };
    const outcome = applyLiveDiff(
      changedAgain,
      scenario,
      itemIds(diff, "durationMs"),
      diff,
    );
    expect(outcome.entries[0]?.resolution).toBe("conflict-overwritten");
    expect(
      outcome.project?.nodes.find((node) => node.id === "session")?.durationMs,
    ).toBe(280);
  });

  it("aborts the whole batch when the result would break the graph", () => {
    const scenario: ScenarioSnapshot = {
      id: "scenario-cyclic",
      name: "手工方案",
      createdAt: 1,
      concurrencyLimit: null,
      nodes: EXAMPLE_PROJECT.nodes.map((node) =>
        node.id === "session"
          ? { ...node, dependencyIds: ["profile"] }
          : { ...node },
      ),
      completionMs: 1000,
      criticalPath: [],
    };
    const edited: LatencyProject = {
      ...EXAMPLE_PROJECT,
      concurrencyLimit: 3,
    };
    const diff = computeLiveDiff(edited, scenario, 0).items;
    const selected = itemIds(diff, "dependencies", "concurrency");
    expect(selected).toHaveLength(2);
    const outcome = applyLiveDiff(edited, scenario, selected, diff);
    expect(outcome.project).toBeNull();
    expect(outcome.error).toContain("整体放弃");
    expect(edited.concurrencyLimit).toBe(3);
    expect(
      edited.nodes.find((node) => node.id === "session")?.dependencyIds,
    ).toEqual([]);
  });

  it("keeps the applied graph simulatable so derived state stays in sync", () => {
    const scenario = makeScenario(EXAMPLE_PROJECT);
    const edited: LatencyProject = {
      ...EXAMPLE_PROJECT,
      concurrencyLimit: 2,
      nodes: EXAMPLE_PROJECT.nodes.map((node) =>
        node.id === "catalog" ? { ...node, timeoutMs: 900 } : node,
      ),
    };
    const diff = computeLiveDiff(edited, scenario, 0).items;
    const outcome = applyLiveDiff(
      edited,
      scenario,
      diff.map((item) => item.id),
      diff,
    );
    const next = outcome.project;
    expect(next).not.toBeNull();
    if (!next) return;
    const result = simulateProject(next);
    expect(result.entries).toHaveLength(next.nodes.length);
    expect(
      computeLiveDiff(next, scenario, result.completionMs).items,
    ).toHaveLength(0);
  });
});
