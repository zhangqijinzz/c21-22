import { describe, expect, it, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import ScenarioPanel from "../src/features/scenarios/ScenarioPanel";
import { EXAMPLE_PROJECT } from "../src/shared/domain/types";
import { saveScenario } from "../src/features/scenarios/scenarioViewModel";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  buildGraphDiff,
  createLiveView,
  createSnapshotView,
  planGraphApplication,
  type ApplicationPlan,
  type ConflictResolution,
} from "../src/shared/domain/liveDiff";
import React from "react";

let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

const saved = saveScenario(
  structuredClone(EXAMPLE_PROJECT),
  simulateProject(structuredClone(EXAMPLE_PROJECT)),
  "基线方案",
);
const scenario = saved.scenarios[0]!;

function makeLive() {
  return {
    ...structuredClone(EXAMPLE_PROJECT),
    concurrencyLimit: 2,
    nodes: structuredClone(EXAMPLE_PROJECT).nodes.map((n) =>
      n.id === "session" ? { ...n, durationMs: 900 } : n,
    ),
  };
}

async function render(props: Record<string, unknown>) {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ScenarioPanel, props as never));
  });
}

describe("ScenarioPanel interactions", () => {
  it("selects rows and applies them as one group through onApply", async () => {
    let applied:
      | { ids: string[]; resolutions: Record<string, ConflictResolution> }
      | undefined;
    const live = makeLive();
    const project = { ...live, scenarios: saved.scenarios };
    const diff = buildGraphDiff(
      createLiveView(live, "expected"),
      createSnapshotView(scenario),
    );
    await render({
      project,
      onSave: () => true,
      onRemove: () => {},
      onRestore: () => {},
      onSelectBaseline: () => {},
      onSelectComparison: () => {},
      baseline: scenario,
      baselineId: scenario.id,
      comparisonId: "__live__",
      baselineIsLive: false,
      comparisonIsLive: true,
      liveDiff: diff,
      liveDiffScenarioName: "基线方案",
      canUndoApply: false,
      undoLabel: "",
      onPlan: (ids: string[]) =>
        planGraphApplication(live, diff, ids, "expected"),
      onApply: (
        ids: string[],
        resolutions: Record<string, ConflictResolution>,
      ) => {
        applied = { ids, resolutions };
        return { ok: true as const };
      },
      onUndo: () => {},
    });

    // 全选（label 点击会触发内部 checkbox）。
    act(() => {
      container
        .querySelector(".diff-select-all")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const applyButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("应用所选"),
    )!;
    expect(applyButton.hasAttribute("disabled")).toBe(false);
    act(() => {
      applyButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(applied).toBeDefined();
    expect(applied!.ids.length).toBeGreaterThan(1);
    expect(applied!.ids).toContain("concurrency");
  });

  it("opens a conflict dialog, blocks apply until resolved, and honors the choice", async () => {
    const live: typeof EXAMPLE_PROJECT = {
      ...structuredClone(EXAMPLE_PROJECT),
      nodes: EXAMPLE_PROJECT.nodes
        .filter((n) => n.id !== "catalog")
        .map((n) =>
          n.id === "recommend" ? { ...n, fallbackNodeId: undefined } : n,
        ),
    };
    const project = { ...live, scenarios: saved.scenarios };
    const diff = buildGraphDiff(
      createLiveView(live, "expected"),
      createSnapshotView(scenario),
    );
    let lastOutcome:
      | {
          ok: boolean;
          ids: string[];
          resolutions: Record<string, ConflictResolution>;
        }
      | undefined;
    const renderProps = {
      project,
      onSave: () => true,
      onRemove: () => {},
      onRestore: () => {},
      onSelectBaseline: () => {},
      onSelectComparison: () => {},
      baseline: scenario,
      baselineId: scenario.id,
      comparisonId: "__live__",
      baselineIsLive: false,
      comparisonIsLive: true,
      liveDiff: diff,
      liveDiffScenarioName: "基线方案",
      canUndoApply: false,
      undoLabel: "",
      onPlan: (ids: string[]): ApplicationPlan =>
        planGraphApplication(live, diff, ids, "expected"),
      onApply: (
        ids: string[],
        resolutions: Record<string, ConflictResolution>,
      ) => {
        lastOutcome = { ok: true, ids, resolutions };
        return { ok: true as const };
      },
      onUndo: () => {},
    };
    await render(renderProps);

    // 只勾 fallback 字段项。
    const rows = container.querySelectorAll<HTMLLabelElement>("label.diff-row");
    const fallbackRow = Array.from(rows).find((r) =>
      r.textContent?.includes("降级目标"),
    )!;
    act(() => {
      fallbackRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const applyButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("应用所选"),
    )!;
    act(() => {
      applyButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 冲突弹窗出现。
    expect(container.querySelector(".conflict-dialog")).toBeTruthy();
    expect(lastOutcome).toBeUndefined();

    // 选择「清除降级目标」并确认。
    const radios = container.querySelectorAll<HTMLInputElement>(
      ".conflict-options input[type=radio]",
    );
    const clearRadio = Array.from(radios).find((r) => {
      const label = r.parentElement?.textContent ?? "";
      return label.includes("清除降级目标");
    })!;
    act(() => {
      clearRadio.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const confirmButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("整体应用"),
    )!;
    act(() => {
      confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(lastOutcome?.ok).toBe(true);
    // 选择的「清除降级目标」取舍必须随整组提交传给 onApply。
    const chosen = Object.values(lastOutcome!.resolutions);
    expect(chosen).toContain("clear-reference");
    expect(container.querySelector(".conflict-dialog")).toBeFalsy();
  });
});
