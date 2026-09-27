import type { Plan, Tank, Substrate, WaterConfig, StartupState, WeekPlan } from '../core/types';
import { EMPTY_WATER } from '../core/types';

const KEY = 'aquaplans.v1';

export function defaultSubstrate(): Substrate {
  return { kind: 'soil', densityKgPerL: 1.05, thicknessMm: 50, slopeMm: 60 };
}

export function defaultTank(name = '我的草缸'): Tank {
  return { id: 't1', name, l: 60, w: 45, h: 45, glassMm: 8, waterLevelMm: 390, openTop: true };
}

export function newPlan(name = '我的草缸'): Plan {
  return {
    id: `p${Date.now()}${Math.floor(Math.random() * 1e4)}`,
    name,
    tank: defaultTank(name),
    substrate: defaultSubstrate(),
    items: [],
    fishes: [],
    water: { ...EMPTY_WATER },
    updatedAt: Date.now(),
  };
}

function load(): Plan[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch {
    return [];
  }
}

function save(plans: Plan[]) {
  localStorage.setItem(KEY, JSON.stringify(plans));
}

// ---- 集中式 store（React 组件只做展示与用户动作，见项目约定）----
type Listener = () => void;
const listeners = new Set<Listener>();
let plans: Plan[] = load();

function emit() {
  save(plans);
  listeners.forEach((l) => l());
}

export function getPlans(): Plan[] {
  return plans;
}

export function subscribePlans(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getPlan(id: string): Plan | undefined {
  return plans.find((p) => p.id === id);
}

export function upsertPlan(plan: Plan) {
  const idx = plans.findIndex((p) => p.id === plan.id);
  const next = { ...plan, updatedAt: Date.now() };
  if (idx >= 0) plans = plans.map((p) => (p.id === plan.id ? next : p));
  else plans = [next, ...plans];
  emit();
}

export function deletePlan(id: string) {
  plans = plans.filter((p) => p.id !== id);
  emit();
}

export function renamePlan(id: string, name: string) {
  plans = plans.map((p) => (p.id === id ? { ...p, name, updatedAt: Date.now() } : p));
  emit();
}

/** 更新某个 plan 的局部字段并持久化 */
export function updatePlan(id: string, patch: Partial<Plan>) {
  plans = plans.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p));
  emit();
}

export function updateWater(id: string, patch: Partial<WaterConfig>) {
  const plan = getPlan(id);
  if (!plan) return;
  updatePlan(id, { water: { ...plan.water, ...patch } });
}

// ---- 开缸日程状态（Plan.startup）----

/** 本地日期 YYYY-MM-DD（与 schedule.currentWeek 的本地时区推算对齐） */
export function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function defaultStartup(): StartupState {
  return { startDate: todayStr(), lockedWeeks: [], done: {}, readings: {} };
}

/** 读取开缸日程状态；旧方案没有该字段时返回默认（不落盘，首次写入时才持久化） */
export function getStartup(plan: Plan): StartupState {
  return plan.startup ?? defaultStartup();
}

export function updateStartup(id: string, patch: Partial<StartupState>) {
  const plan = getPlan(id);
  if (!plan) return;
  updatePlan(id, { startup: { ...getStartup(plan), ...patch } });
}

/** 勾选/取消某一步。stepId 稳定（里程碑与周次解耦），重排后勾选不丢 */
export function toggleStartupStep(id: string, stepId: string) {
  const plan = getPlan(id);
  if (!plan) return;
  const s = getStartup(plan);
  updatePlan(id, { startup: { ...s, done: { ...s.done, [stepId]: !s.done[stepId] } } });
}

/** 记录某周当天实测（pH / 氨氮 mg/L）；value 传 null 表示清除 */
export function setStartupReading(id: string, week: number, kind: 'ph' | 'nh3', value: number | null) {
  const plan = getPlan(id);
  if (!plan) return;
  const s = getStartup(plan);
  const entry = { ...(s.readings[week] ?? {}) };
  if (value === null || Number.isNaN(value)) delete entry[kind];
  else entry[kind] = value;
  updatePlan(id, { startup: { ...s, readings: { ...s.readings, [week]: entry } } });
}

/** 把已过去的周锁定为快照（只补不覆盖，幂等）：之后改参数重排不影响这些周 */
export function lockStartupWeeks(id: string, weeks: WeekPlan[]) {
  const plan = getPlan(id);
  if (!plan) return;
  const s = getStartup(plan);
  const missing = weeks.filter((w) => !s.lockedWeeks.some((l) => l.week === w.week));
  if (!missing.length) return;
  updatePlan(id, { startup: { ...s, lockedWeeks: [...s.lockedWeeks, ...missing] } });
}

/** 重置开缸日程（换缸/重开时用）：清空勾选、实测与锁定快照，开缸日期回到今天 */
export function resetStartup(id: string) {
  const plan = getPlan(id);
  if (!plan) return;
  updatePlan(id, { startup: defaultStartup() });
}
