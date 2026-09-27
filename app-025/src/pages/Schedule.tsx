import { useEffect, useMemo, useState } from 'react';
import type { Plan, ScheduleReading } from '../core/types';
import { FISHES } from '../data/db';
import { Link } from '../router';
import {
  deriveScheduleParams,
  buildSchedule,
  materializeSchedule,
  weeksToFreeze,
  scheduleSignature,
  currentWeekIndex,
  weekDateRange,
  formatDate,
  evaluateReading,
  gateBlocked,
  taskDoneKey,
  scheduleProgress,
  FIXED_TASK_IDS,
  STYLE_LABEL,
  SCHEDULE_WEEKS,
  type MaterializedWeek,
  type ScheduleTask,
} from '../core/schedule';
import {
  ensureSchedule,
  setScheduleStart,
  toggleScheduleTask,
  saveScheduleReading,
  freezeScheduleWeeks,
} from '../state/plans';

export default function Schedule({ plan }: { plan: Plan }) {
  const fishMap = useMemo(() => new Map(FISHES.map((f) => [f.id, f])), []);

  // 首次进入：开缸日默认今天
  useEffect(() => {
    ensureSchedule(plan.id);
  }, [plan.id]);

  const params = useMemo(() => deriveScheduleParams(plan, fishMap), [plan, fishMap]);
  const signature = useMemo(() => scheduleSignature(params), [params]);
  const generated = useMemo(() => buildSchedule(params), [params]);

  const startedOn = plan.schedule?.startedOn ?? formatDate(new Date());
  const currentIdx = currentWeekIndex(startedOn);

  // 已过去的周第一次滑过即冻结快照：之后改缸体/水草只重排当周及以后
  const frozenWeeks = plan.schedule?.frozenWeeks ?? {};
  useEffect(() => {
    if (!plan.schedule) return;
    const entries = weeksToFreeze(generated, signature, plan.schedule.frozenWeeks, currentIdx, Date.now());
    // 开缸日被改晚时，原本冻结但如今不再是历史周的快照要清掉
    const prune = Object.keys(plan.schedule.frozenWeeks)
      .map(Number)
      .filter((i) => i >= currentIdx);
    if (entries.length > 0 || prune.length > 0) freezeScheduleWeeks(plan.id, entries, prune);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.id, plan.schedule, currentIdx, signature]);

  const weeks = useMemo<MaterializedWeek[]>(
    () => materializeSchedule(generated, frozenWeeks, currentIdx),
    [generated, frozenWeeks, currentIdx],
  );
  const progress = useMemo(
    () => scheduleProgress(weeks.map((m) => m.week), plan.schedule?.done ?? {}),
    [weeks, plan.schedule?.done],
  );

  // 是否存在「按旧参数冻结」的历史周：用于提示当周及以后已重排
  const rearranged = Object.values(frozenWeeks).some((f) => f.signature !== signature);

  if (!plan.schedule) {
    return (
      <div className="page" data-testid="schedule-page">
        <ScheduleTabs plan={plan} />
        <h1>开缸日程（{plan.name}）</h1>
        <p className="muted">正在初始化日程…</p>
      </div>
    );
  }

  return (
    <div className="page" data-testid="schedule-page">
      <ScheduleTabs plan={plan} />
      <h1>开缸日程 · 前 {SCHEDULE_WEEKS} 周（{plan.name}）</h1>

      <div className="card2" data-testid="schedule-summary">
        <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <label>
            开缸日
            <input
              type="date"
              data-testid="start-date"
              value={startedOn}
              onChange={(e) => e.target.value && setScheduleStart(plan.id, e.target.value)}
            />
          </label>
          <span className="tag">{STYLE_LABEL[params.style]}</span>
          <span className="tag">{params.pace === 'fast' ? '快生草为主' : '慢生草为主'}</span>
          <span className="tag">{params.soil ? '用水草泥' : '惰性底床（砂/砾石）'}</span>
          <span className="muted small">
            有效水量 {params.effectiveL.toFixed(0)}L · 水草 {params.plantQty} 株
          </span>
        </div>
        <p className="muted small">
          节奏按「缸体水量 × 水草快慢 × 是否水草泥 × 密植/裸缸」推导；开缸日当天算第 1 周，今天是第{' '}
          <b data-testid="current-week">{currentIdx + 1}</b> 周。完成进度 {progress.done}/{progress.total}（
          {progress.pct}%）。已过去的周自动锁定，中途改缸体/水草只会重排当周及以后。
        </p>
        <p className="warnbox" data-testid="schedule-estimate">
          经验估算：{generated.note}
        </p>
        {rearranged && (
          <p className="warnbox" data-testid="rearrange-banner">
            检测到缸体尺寸/水草数量与已过去的周不同：<b>当周及以后已按新参数自动重排</b>，已过去的周保留原记录不变。
          </p>
        )}
      </div>

      <table className="table schedule-table" data-testid="schedule-table">
        <thead>
          <tr>
            <th style={{ width: 110 }}>周次 / 日期</th>
            <th>本周安排（勾掉 = 已做完）</th>
            <th style={{ width: 250 }}>当天实测 · 范围提醒</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((m) => (
            <WeekBlock
              key={m.week.index}
              materialized={m}
              currentIdx={currentIdx}
              startedOn={startedOn}
              reading={plan.schedule!.readings[m.week.index]}
              done={plan.schedule!.done}
              planId={plan.id}
            />
          ))}
        </tbody>
      </table>

      <p className="muted small" style={{ marginTop: 12 }}>
        氨氮指总氨氮 NH3-N（mg/L，淡水试剂所测）；合理范围随周次变化：养水期允许冲高回落，下生物后必须接近 0。
      </p>
    </div>
  );
}

function ScheduleTabs({ plan }: { plan: Plan }) {
  return (
    <nav className="row tabs">
      <Link to={`/plan/${plan.id}`} className="tab">
        ← 造景编辑
      </Link>
      <Link to={`/plan/${plan.id}/water`} className="tab">
        水质与设备
      </Link>
      <span className="tab active">开缸日程</span>
      <Link to={`/plan/${plan.id}/stocking`} className="tab">
        生物兼容 →
      </Link>
    </nav>
  );
}

function WeekBlock({
  materialized,
  currentIdx,
  startedOn,
  reading,
  done,
  planId,
}: {
  materialized: MaterializedWeek;
  currentIdx: number;
  startedOn: string;
  reading?: ScheduleReading;
  done: Record<string, boolean>;
  planId: string;
}) {
  const { week, frozen } = materialized;
  const w = week.index;

  const status =
    w < currentIdx ? (frozen ? '已过 · 已冻结' : '已过') : w === currentIdx ? '本周进行中' : '未开始';

  // 固定行（换水/灯/CO₂）+ 里程碑行
  const rows: { id: string; node: React.ReactNode }[] = [];
  const wc = week.waterChange;
  rows.push({
    id: FIXED_TASK_IDS.waterChange,
    node: (
      <Line
        title={`换水：${wc.pct}% × 每周${wc.timesPerWeek}次（每次约 ${wc.liters.toFixed(1)}L）`}
        reason={wc.reason}
        expect={wc.expect}
        estimated
      />
    ),
  });
  rows.push({
    id: FIXED_TASK_IDS.light,
    node: (
      <Line
        title={`照明：每天 ${week.light.hoursPerDay} 小时`}
        reason={week.light.reason}
        expect={week.light.expect}
        estimated
      />
    ),
  });
  if (week.co2) {
    rows.push({
      id: FIXED_TASK_IDS.co2,
      node: (
        <Line title={week.co2.title} reason={week.co2.reason} expect={week.co2.expect} estimated />
      ),
    });
  }
  for (const task of week.tasks) {
    rows.push({ id: task.id, node: <TaskLine task={task} reading={reading} active={w <= currentIdx} /> });
  }

  const phAlerts = reading?.ph !== undefined ? evaluateReading(week, 'ph', reading.ph) : [];
  const nh3Alerts = reading?.ammonia !== undefined ? evaluateReading(week, 'ammonia', reading.ammonia) : [];

  return (
    <>
      <tr className={`week-head ${w === currentIdx ? 'is-current' : ''}`} data-testid={`week-${w}`}>
        <td>
          <b>{week.title}</b>
          <div className="muted small">
            <WeekDates weekIndex={w} startedOn={startedOn} />
          </div>
          <span className={`tag ${w === currentIdx ? 'tag-hot' : ''}`} data-testid={`week-status-${w}`}>
            {status}
          </span>
        </td>
        <td className="muted small">
          换水 {wc.pct}%×{wc.timesPerWeek}｜灯 {week.light.hoursPerDay}h
          {week.co2 ? `｜${week.co2.title.split('：')[0]}` : '｜无 CO₂'}
          {week.tasks.some((x) => x.id === 'first-fish') && '｜🐟 首批鱼'}
          {week.tasks.some((x) => x.id === 'shrimp') && '｜🦐 虾'}
          {week.tasks.some((x) => x.id === 'snail') && '｜🐌 螺'}
        </td>
        <td rowSpan={rows.length + 1} className="reading-cell">
          <ReadingInputs planId={planId} weekIndex={w} reading={reading} />
          <div className="muted small" data-testid={`ranges-${w}`}>
            本周合理 pH {fmtRange(week.ranges.ph)}
            <br />
            氨氮 ≤ {week.ranges.ammonia.max ?? '—'} mg/L
          </div>
          {[...phAlerts, ...nh3Alerts].map((a, i) => (
            <div
              key={i}
              className={`issue ${a.level === 'warn' ? 'issue-warning' : 'issue-info'}`}
              data-testid={`reading-alert-${w}`}
            >
              {a.level === 'warn' ? '⚠' : 'ℹ'} {a.message}
            </div>
          ))}
        </td>
      </tr>
      {rows.map((row) => (
        <tr key={row.id} className={w === currentIdx ? 'is-current' : ''} data-testid={`task-row-${w}-${row.id}`}>
          <td className="check-cell">
            <Check planId={planId} weekIndex={w} taskId={row.id} checked={!!done[taskDoneKey(w, row.id)]} />
          </td>
          <td>{row.node}</td>
        </tr>
      ))}
    </>
  );
}

function WeekDates({ weekIndex, startedOn }: { weekIndex: number; startedOn: string }) {
  const { start, end } = weekDateRange(startedOn, weekIndex);
  return (
    <>
      {formatDate(start)} ~ {formatDate(end)}
    </>
  );
}

function fmtRange(r: { min: number | null; max: number | null }): string {
  return `${r.min ?? '—'}~${r.max ?? '—'}`;
}

function Check({
  planId,
  weekIndex,
  taskId,
  checked,
}: {
  planId: string;
  weekIndex: number;
  taskId: string;
  checked: boolean;
}) {
  return (
    <input
      type="checkbox"
      className="task-check"
      data-testid={`check-${weekIndex}-${taskId}`}
      checked={checked}
      onChange={() => toggleScheduleTask(planId, taskDoneKey(weekIndex, taskId))}
    />
  );
}

function Line({
  title,
  reason,
  expect,
  estimated,
}: {
  title: string;
  reason: string;
  expect: string;
  estimated?: boolean;
}) {
  return (
    <div>
      <b>{title}</b> {estimated && <span className="muted small">（经验估算）</span>}
      <div className="muted small">理由：{reason}</div>
      <div className="muted small">应观察到：{expect}</div>
    </div>
  );
}

function TaskLine({ task, reading, active }: { task: ScheduleTask; reading?: ScheduleReading; active: boolean }) {
  const block = task.gate ? gateBlocked(task, reading) : null;
  const measured = task.gate
    ? task.gate.kind === 'ammonia'
      ? reading?.ammonia !== undefined
      : reading?.ph !== undefined
    : false;
  return (
    <div>
      <Line title={task.title} reason={task.reason} expect={task.expect} />
      {task.gate &&
        (block ? (
          <div className="gate-warn" data-testid={`gate-${task.id}`}>
            ⛓ {block}
          </div>
        ) : measured ? (
          <div className="gate-ok" data-testid={`gate-${task.id}`}>
            ✓ 前置条件已满足：{task.gate.label}
          </div>
        ) : active ? (
          <div className="muted small gate-wait" data-testid={`gate-${task.id}`}>
            ⛓ 前置条件：{task.gate.label}（本周做之前先测）
          </div>
        ) : (
          <div className="muted small" data-testid={`gate-${task.id}`}>
            前置条件：{task.gate.label}
          </div>
        ))}
    </div>
  );
}

function ReadingInputs({
  planId,
  weekIndex,
  reading,
}: {
  planId: string;
  weekIndex: number;
  reading?: ScheduleReading;
}) {
  const [phDraft, setPhDraft] = useState(reading?.ph !== undefined ? String(reading.ph) : '');
  const [nh3Draft, setNh3Draft] = useState(reading?.ammonia !== undefined ? String(reading.ammonia) : '');

  function commit(metric: 'ph' | 'ammonia', raw: string) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      saveScheduleReading(planId, weekIndex, { [metric]: undefined });
      return;
    }
    const v = Number(trimmed);
    if (Number.isFinite(v)) saveScheduleReading(planId, weekIndex, { [metric]: v });
  }

  return (
    <div className="reading-inputs">
      <label>
        pH
        <input
          type="number"
          step="0.1"
          inputMode="decimal"
          placeholder="如 6.8"
          data-testid={`ph-input-${weekIndex}`}
          value={phDraft}
          onChange={(e) => setPhDraft(e.target.value)}
          onBlur={(e) => commit('ph', e.target.value)}
        />
      </label>
      <label>
        氨氮 mg/L
        <input
          type="number"
          step="0.05"
          inputMode="decimal"
          placeholder="如 0.2"
          data-testid={`ammonia-input-${weekIndex}`}
          value={nh3Draft}
          onChange={(e) => setNh3Draft(e.target.value)}
          onBlur={(e) => commit('ammonia', e.target.value)}
        />
      </label>
      {reading?.recordedOn && <div className="muted small">记录于 {reading.recordedOn}</div>}
    </div>
  );
}
