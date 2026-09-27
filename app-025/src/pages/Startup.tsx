import { useEffect, useMemo } from 'react';
import type { Plan, WeekPlan } from '../core/types';
import {
  getStartup,
  updateStartup,
  toggleStartupStep,
  setStartupReading,
  lockStartupWeeks,
  resetStartup,
} from '../state/plans';
import { Link } from '../router';
import {
  profileFromPlan,
  buildSchedule,
  currentWeek,
  mergeWithLocked,
  weeksToLock,
  weekDateRange,
  checkReading,
  totalWeeks,
} from '../core/schedule';

/** CO₂ 各阶段对应目标泡/秒的比例（经验估算，配合监测液校验） */
const CO2_FACTOR = { start: 0.5, ramp: 0.75, full: 1 } as const;

const MILESTONE_LABEL: Record<string, string> = { fish: '第一批鱼', shrimp: '虾、螺' };

export default function Startup({ plan }: { plan: Plan }) {
  const startup = getStartup(plan);
  const profile = useMemo(() => profileFromPlan(plan), [plan]);
  const generated = useMemo(() => buildSchedule(profile), [profile]);
  const cur = Math.min(currentWeek(startup.startDate), generated.length);
  const weeks = useMemo(
    () => mergeWithLocked(generated, startup.lockedWeeks, cur),
    [generated, startup.lockedWeeks, cur],
  );

  // 首次进入时把默认开缸日期落盘（否则每天打开都会变成"今天"）
  useEffect(() => {
    if (!plan.startup) updateStartup(plan.id, {});
  }, [plan.id, plan.startup]);

  // 已过去的周锁定为快照：之后改缸体/水草只重排未开始的周
  useEffect(() => {
    const missing = weeksToLock(generated, startup.lockedWeeks, cur);
    if (missing.length) lockStartupWeeks(plan.id, missing);
  }, [plan.id, generated, startup.lockedWeeks, cur]);

  const densityLabel =
    profile.density === 'dense' ? '密植草缸' : profile.density === 'sparse' ? '疏植草缸' : '裸缸';
  const totalSteps = weeks.reduce((s, w) => s + w.steps.length, 0);
  const doneSteps = weeks.reduce(
    (s, w) => s + w.steps.filter((st) => startup.done[st.id]).length,
    0,
  );

  return (
    <div className="page" data-testid="startup-page">
      <nav className="row tabs">
        <Link to={`/plan/${plan.id}`} className="tab">
          ← 造景编辑
        </Link>
        <Link to={`/plan/${plan.id}/water`} className="tab">
          水质与设备
        </Link>
        <Link to={`/plan/${plan.id}/stocking`} className="tab">
          生物兼容
        </Link>
        <span className="tab active">开缸日程</span>
        <Link to={`/plan/${plan.id}/bom`} className="tab">
          物料清单 →
        </Link>
      </nav>
      <h1>开缸日程（{plan.name}）</h1>
      <p className="muted" data-testid="startup-summary">
        有效水量 {profile.effectiveL.toFixed(1)}L · {densityLabel}（{profile.plantQty} 株，快生占{' '}
        {(profile.fastRatio * 100).toFixed(0)}%）· {profile.hasSoil ? '水草泥底床' : '非泥底床'} · 共{' '}
        {totalWeeks(profile)} 周，当前第 <b data-testid="current-week">{cur}</b> 周 · 已完成{' '}
        {doneSteps}/{totalSteps} 步
      </p>

      <section className="card2">
        <div className="row">
          <label>
            开缸日期
            <input
              type="date"
              data-testid="start-date"
              value={startup.startDate}
              onChange={(e) => updateStartup(plan.id, { startDate: e.target.value })}
            />
          </label>
          <button
            className="btn ghost"
            data-testid="reset-startup"
            onClick={() => {
              if (window.confirm('重置开缸日程？将清空全部勾选、实测记录与已锁定周。')) {
                resetStartup(plan.id);
              }
            }}
          >
            重置日程
          </button>
        </div>
        <p className="muted small">
          中途修改缸体尺寸或水草数量后，未开始的周会按最新参数自动重排；第 {cur} 周之前已过去的周保持锁定不变。
          换水升数按生成该周时的有效水量折算（当前 {profile.effectiveL.toFixed(0)}L，已锁定周保持锁定时的数值）；CO₂
          泡/秒为经验估算，务必用监测液校验。
        </p>
      </section>

      <table className="table startup-table" data-testid="startup-table">
        <thead>
          <tr>
            <th>周次</th>
            <th>换水</th>
            <th>光照</th>
            <th>CO₂</th>
            <th>生物</th>
            <th>步骤（勾选完成，含理由与现象）</th>
            <th>实测记录（当天）</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <WeekRow
              key={w.week}
              plan={plan}
              week={w}
              cur={cur}
              startDate={startup.startDate}
              done={startup.done}
              reading={startup.readings[w.week] ?? {}}
              needsCo2={profile.needsCo2}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WeekRow(props: {
  plan: Plan;
  week: WeekPlan;
  cur: number;
  startDate: string;
  done: Record<string, boolean>;
  reading: { ph?: number; nh3?: number };
  needsCo2: boolean;
}) {
  const { plan, week: w, cur, done, reading } = props;
  const doneCount = w.steps.filter((s) => done[s.id]).length;
  const milestones = w.steps.filter((s) => s.milestone);
  const phCheck = reading.ph !== undefined ? checkReading(w, 'ph', reading.ph) : null;
  const nh3Check = reading.nh3 !== undefined ? checkReading(w, 'nh3', reading.nh3) : null;
  // 升数与泡/秒按周计划快照折算：已锁定的周显示锁定时的水量，不随改缸变化
  const perChangeL = (w.waterChangePct / 100) * w.effectiveL;

  return (
    <tr data-testid={`week-${w.week}`} className={w.week === cur ? 'current' : undefined}>
      <td>
        <b>第 {w.week} 周</b>
        <div className="muted small">{weekDateRange(props.startDate, w.week)}</div>
        {w.week < cur && <span className="tag">已锁定</span>}
        {w.week === cur && <span className="tag current">本周</span>}
        <div className="muted small">
          完成 {doneCount}/{w.steps.length}
        </div>
      </td>
      <td>
        <b>
          {w.waterChangePct}% × {w.waterChangeTimes} 次
        </b>
        <div className="muted small">每次约 {perChangeL.toFixed(1)} L</div>
      </td>
      <td>{w.lightHours > 0 ? `${w.lightHours} 小时/天` : '无需固定光照'}</td>
      <td>{co2Text(w, props.needsCo2)}</td>
      <td data-testid={`milestones-${w.week}`}>
        {milestones.length ? milestones.map((m) => MILESTONE_LABEL[m.kind]).join('、') : '—'}
      </td>
      <td>
        {w.steps.map((s) => (
          <div key={s.id} className="step">
            <label className="chk">
              <input
                type="checkbox"
                data-testid={`step-${s.id}`}
                checked={!!done[s.id]}
                onChange={() => toggleStartupStep(plan.id, s.id)}
              />
              <span className={done[s.id] ? 'step-done' : undefined}>{s.title}</span>
            </label>
            <div className="muted small">理由：{s.reason}</div>
            <div className="muted small">现象：{s.observe}</div>
          </div>
        ))}
      </td>
      <td data-testid={`reading-${w.week}`}>
        <div className="reading-inputs">
          <label>
            pH
            <input
              type="number"
              step="0.1"
              data-testid={`reading-ph-${w.week}`}
              value={reading.ph ?? ''}
              onChange={(e) =>
                setStartupReading(plan.id, w.week, 'ph', e.target.value === '' ? null : Number(e.target.value))
              }
            />
          </label>
          <label>
            氨氮
            <input
              type="number"
              step="0.01"
              data-testid={`reading-nh3-${w.week}`}
              value={reading.nh3 ?? ''}
              onChange={(e) =>
                setStartupReading(plan.id, w.week, 'nh3', e.target.value === '' ? null : Number(e.target.value))
              }
            />
          </label>
        </div>
        <div className="muted small">
          本周合理：pH {w.phRange[0]}~{w.phRange[1]} · 氨氮 ≤ {w.nh3Max} mg/L
        </div>
        {phCheck && (
          <div className={boxClass(phCheck.level)} data-testid={`ph-check-${w.week}`}>
            {phCheck.message}
          </div>
        )}
        {nh3Check && (
          <div className={boxClass(nh3Check.level)} data-testid={`nh3-check-${w.week}`}>
            {nh3Check.message}
          </div>
        )}
      </td>
    </tr>
  );
}

function boxClass(level: 'ok' | 'warn' | 'danger'): string {
  return level === 'ok' ? 'okbox' : level === 'warn' ? 'warnbox' : 'dangerbox';
}

function co2Text(w: WeekPlan, needsCo2: boolean): string {
  if (w.co2 === 'none') return needsCo2 ? '暂不开' : '无需 CO₂';
  const v = Math.round(w.co2Bps * CO2_FACTOR[w.co2] * 10) / 10;
  const label = w.co2 === 'start' ? '本周开始：低量' : w.co2 === 'ramp' ? '加量' : '满量';
  return `${label} ≈${v} 泡/秒（估算）`;
}
