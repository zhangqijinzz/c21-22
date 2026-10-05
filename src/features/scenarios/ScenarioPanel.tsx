import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  GitCompareArrows,
  Plus,
  RotateCcw,
  ShieldAlert,
  Trash2,
  Undo2,
} from "lucide-react";
import type {
  LatencyProject,
  ScenarioSnapshot,
} from "../../shared/domain/types";
import type { ScenarioComparison } from "./scenarioViewModel";
import {
  FIELD_META,
  formatFieldValue,
  LIVE_VIEW_ID,
  type ApplicationPlan,
  type ConflictResolution,
  type DiffConflict,
  type DiffItem,
  type GraphDiff,
} from "../../shared/domain/liveDiff";

interface Props {
  project: LatencyProject;
  onSave: (name: string) => boolean;
  onRemove: (id: string) => void;
  onRestore: (id: string) => void;
  baseline?: ScenarioSnapshot;
  comparison?: ScenarioSnapshot;
  comparisonResult?: ScenarioComparison;
  onSelectBaseline: (id: string) => void;
  onSelectComparison: (id: string) => void;
  baselineId: string;
  comparisonId: string;
  baselineIsLive: boolean;
  comparisonIsLive: boolean;
  liveDiff?: GraphDiff;
  liveDiffScenarioName: string;
  canUndoApply: boolean;
  undoLabel: string;
  onPlan: (selectedIds: string[]) => ApplicationPlan | undefined;
  onApply: (
    selectedIds: string[],
    resolutions: Record<string, ConflictResolution>,
  ) => { ok: boolean; error?: string };
  onUndo: () => void;
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "不可推演";
  return value < 1000
    ? `${Math.round(value)} ms`
    : `${(value / 1000).toFixed(2)} s`;
}

const liveOption = { id: LIVE_VIEW_ID, name: "正在编辑的链路（未保存）" };

interface SideSelectorProps {
  label: string;
  liveSide: boolean;
  selectedId: string;
  scenarios: ScenarioSnapshot[];
  onSelect: (id: string) => void;
}

function SideSelector({
  label,
  liveSide,
  selectedId,
  scenarios,
  onSelect,
}: SideSelectorProps) {
  return (
    <div>
      <span className="compare-label">{label}</span>
      <select
        value={selectedId || ""}
        onChange={(event) => onSelect(event.target.value)}
      >
        <option value={LIVE_VIEW_ID}>{liveOption.name}</option>
        {scenarios.map((scenario) => (
          <option key={scenario.id} value={scenario.id}>
            {scenario.name}
          </option>
        ))}
      </select>
      {liveSide && <small className="side-live-hint">随编辑实时更新</small>}
    </div>
  );
}

function DeltaBadge({ deltaMs }: { deltaMs: number }) {
  if (deltaMs === 0) return <strong className="delta-flat">预算持平</strong>;
  const faster = deltaMs < 0;
  return (
    <strong className={faster ? "delta-good" : "delta-bad"}>
      {faster ? <ArrowDownRight size={17} /> : <ArrowUpRight size={17} />}
      {formatDuration(Math.abs(deltaMs))}
      <small>{faster ? "方案更省" : "方案更贵"}</small>
    </strong>
  );
}

function valueContext(
  diff: GraphDiff,
  side: "current" | "other",
): import("../../shared/domain/types").RequestNode[] {
  return side === "current" ? diff.currentNodes : diff.otherNodes;
}

function DiffRow({
  item,
  diff,
  checked,
  onToggle,
}: {
  item: DiffItem;
  diff: GraphDiff;
  checked: boolean;
  onToggle: (id: string) => void;
}) {
  const currentNodes = valueContext(diff, "current");
  const otherNodes = valueContext(diff, "other");
  if (item.kind === "concurrency") {
    const fmt = (value: number | null) =>
      value ? `${value} 路并发` : "不限并发";
    return (
      <label className="diff-row">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(item.id)}
        />
        <span className="checkmark" />
        <span className="diff-node">并发上限</span>
        <span className="diff-field">全局策略</span>
        <span className="diff-values">
          <em className="diff-current">{fmt(item.currentValue)}</em>
          <ArrowLeftRight size={12} />
          <em className="diff-other">{fmt(item.otherValue)}</em>
        </span>
      </label>
    );
  }
  if (item.kind === "presence") {
    return (
      <label className="diff-row">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(item.id)}
        />
        <span className="checkmark" />
        <span className="diff-node">{item.nodeName}</span>
        <span className={`diff-field diff-presence ${item.presence}`}>
          {item.presence === "added" ? "方案中存在" : "当前图独有"}
        </span>
        <span className="diff-values">
          <em
            className={
              item.presence === "added" ? "diff-other" : "diff-current"
            }
          >
            {item.presence === "added"
              ? "应用后恢复该节点"
              : "应用后删除该节点"}
          </em>
        </span>
      </label>
    );
  }
  return (
    <label className="diff-row">
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(item.id)}
      />
      <span className="checkmark" />
      <span className="diff-node">{item.nodeName}</span>
      <span className="diff-field">{FIELD_META[item.field].label}</span>
      <span className="diff-values">
        <em className="diff-current">
          {formatFieldValue(item.field, item.currentValue, currentNodes)}
        </em>
        <ArrowLeftRight size={12} />
        <em className="diff-other">
          {formatFieldValue(item.field, item.otherValue, otherNodes)}
        </em>
      </span>
    </label>
  );
}

interface ConflictDialogProps {
  conflicts: DiffConflict[];
  values: Record<string, ConflictResolution>;
  onChange: (key: string, value: ConflictResolution) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConflictDialog({
  conflicts,
  values,
  onChange,
  onCancel,
  onConfirm,
}: ConflictDialogProps) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        className="confirm-dialog conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
      >
        <span className="dialog-icon conflict-icon">
          <ShieldAlert size={18} />
        </span>
        <h2 id="conflict-title">应用前需要先做取舍</h2>
        <p>
          这组改动里有 {conflicts.length}{" "}
          处无法自动决定，确认后将整体应用；未确认则不会部分生效。
        </p>
        <div className="conflict-list">
          {conflicts.map((conflict) => (
            <fieldset className="conflict-item" key={conflict.key}>
              <legend>{conflict.summary}</legend>
              <p>{conflict.detail}</p>
              <div className="conflict-options">
                {conflict.options.map((option) => (
                  <label key={option.value}>
                    <input
                      type="radio"
                      name={conflict.key}
                      checked={
                        (values[conflict.key] ?? conflict.defaultResolution) ===
                        option.value
                      }
                      onChange={() => onChange(conflict.key, option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <div>
          <button className="button button-neutral" onClick={onCancel}>
            取消
          </button>
          <button className="button button-primary" onClick={onConfirm}>
            <Check size={14} /> 按取舍整体应用
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ScenarioPanel({
  project,
  onSave,
  onRemove,
  onRestore,
  baseline,
  comparison,
  comparisonResult,
  onSelectBaseline,
  onSelectComparison,
  baselineId,
  comparisonId,
  baselineIsLive,
  comparisonIsLive,
  liveDiff,
  liveDiffScenarioName,
  canUndoApply,
  undoLabel,
  onPlan,
  onApply,
  onUndo,
}: Props) {
  const [name, setName] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [conflicts, setConflicts] = useState<DiffConflict[]>([]);
  const [resolutions, setResolutions] = useState<
    Record<string, ConflictResolution>
  >({});
  const [applyError, setApplyError] = useState("");
  const [lastEstimate, setLastEstimate] = useState<number | undefined>();

  const isLiveComparison = baselineIsLive !== comparisonIsLive;
  const liveSide = baselineIsLive ? "baseline" : "comparison";
  const diffSignature = useMemo(
    () =>
      liveDiff
        ? `${liveSide}:${liveDiff.items.map((item) => item.id).join("|")}`
        : "",
    [liveDiff, liveSide],
  );

  // 切换对比方后清空勾选与冲突状态。
  useEffect(() => {
    setSelectedIds(new Set());
    setConflicts([]);
    setResolutions({});
    setApplyError("");
    setLastEstimate(undefined);
  }, [diffSignature]);

  const delta = comparisonResult?.deltaMs ?? 0;
  const outcome = comparisonResult?.outcome ?? "equal";
  const changes = comparisonResult?.changes ?? [];

  const toggle = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setApplyError("");
  };
  const allSelected = Boolean(
    liveDiff &&
    liveDiff.items.length > 0 &&
    liveDiff.items.every((item) => selectedIds.has(item.id)),
  );
  const toggleAll = () => {
    setSelectedIds(
      allSelected ? new Set() : new Set(liveDiff?.items.map((item) => item.id)),
    );
    setApplyError("");
  };

  const requestApply = () => {
    if (!liveDiff || !selectedIds.size) return;
    const plan = onPlan([...selectedIds]);
    if (!plan) return;
    setLastEstimate(plan.estimatedCompletionMs);
    if (!plan.conflicts.length) {
      const result = onApply([...selectedIds], {});
      if (!result.ok) setApplyError(result.error ?? "应用失败，未做任何改动。");
      else {
        setSelectedIds(new Set());
        setConflicts([]);
      }
      return;
    }
    setConflicts(plan.conflicts);
    const defaults: Record<string, ConflictResolution> = {};
    for (const conflict of plan.conflicts)
      defaults[conflict.key] = conflict.defaultResolution;
    setResolutions(defaults);
  };

  const confirmApply = () => {
    const result = onApply([...selectedIds], resolutions);
    if (!result.ok) {
      setApplyError(result.error ?? "应用失败，未做任何改动。");
      setConflicts([]);
      return;
    }
    setConflicts([]);
    setSelectedIds(new Set());
    setApplyError("");
  };

  const renderBudgetCards = () => {
    if (isLiveComparison && liveDiff) {
      const leftCompletion =
        liveSide === "baseline"
          ? liveDiff.currentCompletionMs
          : liveDiff.otherCompletionMs;
      const rightCompletion =
        liveSide === "baseline"
          ? liveDiff.otherCompletionMs
          : liveDiff.currentCompletionMs;
      const leftName =
        liveSide === "baseline" ? "正在编辑的链路" : liveDiffScenarioName;
      const rightName =
        liveSide === "baseline" ? liveDiffScenarioName : "正在编辑的链路";
      const estimated = lastEstimate;
      return (
        <div className="comparison-result live-comparison">
          <article
            className={`compare-card ${liveSide === "baseline" ? "compare-card-accent" : ""}`}
          >
            <span>{leftName} · 完成预算</span>
            <strong>{formatDuration(leftCompletion)}</strong>
            <small>
              {liveSide === "baseline"
                ? "未保存的编辑"
                : `${baseline?.nodes.length ?? 0} 节点快照`}
            </small>
          </article>
          <div className="delta-card">
            <span>方案预算差距</span>
            <DeltaBadge deltaMs={liveDiff.deltaMs} />
            <small>
              {estimated === undefined
                ? "勾选差异后预测应用结果"
                : `按当前勾选应用后 ≈ ${formatDuration(estimated)}`}
            </small>
          </div>
          <article
            className={`compare-card ${liveSide === "comparison" ? "compare-card-accent" : ""}`}
          >
            <span>{rightName} · 方案完成预算</span>
            <strong>{formatDuration(rightCompletion)}</strong>
            <small>
              {liveSide === "comparison"
                ? "未保存的编辑"
                : `${comparison?.nodes.length ?? 0} 节点快照`}
            </small>
          </article>
        </div>
      );
    }
    if (baseline && comparison)
      return (
        <div className="comparison-result">
          <article className="compare-card">
            <span>基准完成时间</span>
            <strong>{formatDuration(baseline.completionMs)}</strong>
            <small>
              {baseline.name} · {baseline.nodes.length} 节点
            </small>
          </article>
          <div className="delta-card">
            <span>方案差异</span>
            <strong
              className={outcome === "slower" ? "delta-bad" : "delta-good"}
            >
              {outcome === "equal" ? null : outcome === "faster" ? (
                <ArrowDownRight size={17} />
              ) : (
                <ArrowUpRight size={17} />
              )}
              {formatDuration(Math.abs(delta))}
            </strong>
            <small>
              {outcome === "equal"
                ? "两方案预算持平"
                : outcome === "faster"
                  ? "对照方案更快"
                  : "对照方案更慢"}
            </small>
          </div>
          <article className="compare-card compare-card-accent">
            <span>对照完成时间</span>
            <strong>{formatDuration(comparison.completionMs)}</strong>
            <small>
              {comparison.name} · {comparison.nodes.length} 节点
            </small>
          </article>
        </div>
      );
    return null;
  };

  return (
    <section className="module-page scenarios-page">
      <div className="module-heading">
        <div>
          <span className="eyebrow">04 / SCENARIOS</span>
          <h1>方案对比</h1>
          <p>正在编辑的链路也能直接参与对比，逐项采用方案取值或退回当前图。</p>
        </div>
      </div>
      <div className="save-scenario-bar">
        <div className="save-icon">
          <GitCompareArrows size={18} />
        </div>
        <div className="save-prompt">
          <strong>将当前推演保存为方案</strong>
          <small>保留节点、依赖、并发策略与完成预算。</small>
        </div>
        <input
          className="scenario-name-input"
          placeholder={`例如：${project.title} · 并发优化`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          className="button button-primary"
          onClick={() => {
            if (onSave(name)) setName("");
          }}
        >
          <Plus size={15} /> 保存快照
        </button>
      </div>
      {!project.scenarios.length ? (
        <div className="scenario-empty">
          <div className="empty-mark">A/B</div>
          <h3>还没有保存的方案</h3>
          <p>
            先在时序推演里调整并发或节点参数，再保存快照。之后可以在这里把当前编辑与任一方案逐项对比、按需应用。
          </p>
        </div>
      ) : (
        <>
          <div className="compare-selectors">
            <SideSelector
              label="基准方案"
              liveSide={baselineIsLive}
              selectedId={baselineId}
              scenarios={project.scenarios}
              onSelect={onSelectBaseline}
            />
            <span className="compare-vs">VS</span>
            <SideSelector
              label="对照方案"
              liveSide={comparisonIsLive}
              selectedId={comparisonId}
              scenarios={project.scenarios}
              onSelect={onSelectComparison}
            />
          </div>
          {baselineIsLive && comparisonIsLive && (
            <div className="scenario-empty same-side-note">
              <p>
                两侧都是当前编辑的链路，没有差异可比。请把其中一侧切换为已保存方案。
              </p>
            </div>
          )}
          {renderBudgetCards()}

          {isLiveComparison && liveDiff && (
            <div className="live-diff-section">
              <div className="snapshot-heading diff-toolbar">
                <label className="diff-select-all">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                  />
                  <span className="checkmark" />
                  <span className="section-label">逐项差异</span>
                  <span>
                    {selectedIds.size} / {liveDiff.items.length} 项待应用
                  </span>
                </label>
                <div className="diff-actions">
                  {canUndoApply && (
                    <button className="button button-neutral" onClick={onUndo}>
                      <Undo2 size={13} /> 撤销应用
                      {undoLabel ? `（${undoLabel}）` : ""}
                    </button>
                  )}
                  <button
                    className="button button-primary"
                    disabled={!selectedIds.size}
                    onClick={requestApply}
                  >
                    <Check size={14} /> 应用所选到当前图
                  </button>
                </div>
              </div>
              {applyError && (
                <div className="inline-error apply-error">{applyError}</div>
              )}
              {liveDiff.items.length === 0 ? (
                <div className="diff-empty">
                  当前图与「{liveDiffScenarioName}
                  」参数完全一致，仅保存状态不同。
                </div>
              ) : (
                <div className="diff-list">
                  <div className="diff-row diff-row-head">
                    <span />
                    <span className="diff-node">节点 / 策略</span>
                    <span className="diff-field">项目</span>
                    <span className="diff-values">
                      <em>
                        当前图 <ArrowLeftRight size={11} /> 方案
                      </em>
                    </span>
                  </div>
                  {liveDiff.items.map((item) => (
                    <DiffRow
                      key={item.id}
                      item={item}
                      diff={liveDiff}
                      checked={selectedIds.has(item.id)}
                      onToggle={toggle}
                    />
                  ))}
                </div>
              )}
              <p className="diff-footnote">
                应用是一组整体改动：节点已删除、方案对象在当前图不存在、同一参数两侧不一致时会先弹出取舍；任一环节失败都不会部分生效。
              </p>
            </div>
          )}

          <div className="snapshot-list">
            <div className="snapshot-heading">
              <span className="section-label">已保存快照</span>
              <span>{project.scenarios.length} 个方案</span>
            </div>
            {project.scenarios.map((scenario) => (
              <div className="snapshot-row" key={scenario.id}>
                <span className="snapshot-badge">S</span>
                <div className="snapshot-info">
                  <strong>{scenario.name}</strong>
                  <small>
                    {new Date(scenario.createdAt).toLocaleString("zh-CN", {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    ·{" "}
                    {scenario.concurrencyLimit
                      ? `${scenario.concurrencyLimit} 路并发`
                      : "不限并发"}
                  </small>
                </div>
                <b className="snapshot-time">
                  {formatDuration(scenario.completionMs)}
                </b>
                <button
                  className="icon-button"
                  title="恢复此方案"
                  aria-label={`恢复方案 ${scenario.name}`}
                  onClick={() => onRestore(scenario.id)}
                >
                  <RotateCcw size={14} />
                </button>
                <button
                  className="icon-button danger-button"
                  title="删除方案"
                  aria-label={`删除方案 ${scenario.name}`}
                  onClick={() => onRemove(scenario.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          {!isLiveComparison && changes.length > 0 && (
            <div className="change-summary">
              <strong>参数变化</strong>
              {changes.map((change) => (
                <span key={change}>{change}</span>
              ))}
            </div>
          )}
        </>
      )}
      {conflicts.length > 0 && (
        <ConflictDialog
          conflicts={conflicts}
          values={resolutions}
          onChange={(key, value) =>
            setResolutions((current) => ({ ...current, [key]: value }))
          }
          onCancel={() => setConflicts([])}
          onConfirm={confirmApply}
        />
      )}
    </section>
  );
}
