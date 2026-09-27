import type { Plan, Tank, Substrate, WaterConfig, ScheduleState, ScheduleReading, FrozenWeek } from '../core/types';
import { EMPTY_WATER } from '../core/types';
import { formatDate } from '../core/schedule';

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

// ---- 开缸日程（勾选/实测值持久化；周表生成是 core/ 纯函数）----

/** 首次进入日程页时初始化（开缸日默认今天） */
export function ensureSchedule(id: string, startedOn: string = formatDate(new Date())) {
  const plan = getPlan(id);
  if (!plan || plan.schedule) return;
  const schedule: ScheduleState = { startedOn, done: {}, readings: {}, frozenWeeks: {} };
  updatePlan(id, { schedule });
}

/** 修改开缸日（周次整体平移；已冻结的历史周保留） */
export function setScheduleStart(id: string, startedOn: string) {
  const plan = getPlan(id);
  if (!plan?.schedule || !startedOn) return;
  updateSchedule(id, { startedOn });
}

/** 勾选/取消勾选某周任务，key = `${weekIndex}:${taskId}` */
export function toggleScheduleTask(id: string, key: string) {
  const plan = getPlan(id);
  if (!plan?.schedule) return;
  const done = { ...plan.schedule.done, [key]: !plan.schedule.done[key] };
  if (!done[key]) delete done[key];
  updateSchedule(id, { done });
}

/** 保存/更新某周实测 pH、氨氮（空输入视为清空该项） */
export function saveScheduleReading(id: string, weekIndex: number, patch: Partial<ScheduleReading>) {
  const plan = getPlan(id);
  if (!plan?.schedule) return;
  const prev = plan.schedule.readings[weekIndex] ?? {};
  const next: ScheduleReading = { ...prev, ...patch };
  if (next.ph === undefined) delete next.ph;
  if (next.ammonia === undefined) delete next.ammonia;
  next.recordedOn = formatDate(new Date());
  const readings = { ...plan.schedule.readings };
  if (next.ph === undefined && next.ammonia === undefined) {
    delete readings[weekIndex];
  } else {
    readings[weekIndex] = next;
  }
  updateSchedule(id, { readings });
}

/**
 * 冻结已滑过的历史周快照（由页面用 core/weeksToFreeze 算出后调用）。
 * 中途改缸体尺寸/水草数量只影响当周及以后，历史周不再重排。
 * 同时清理「开缸日改晚后不再是历史周」的陈旧快照，避免其日后被误用。
 */
export function freezeScheduleWeeks(id: string, entries: { index: number; entry: FrozenWeek }[], prune: number[] = []) {
  const plan = getPlan(id);
  if (!plan?.schedule) return;
  if (entries.length === 0 && prune.length === 0) return;
  const frozenWeeks = { ...plan.schedule.frozenWeeks };
  for (const { index, entry } of entries) frozenWeeks[index] = entry;
  for (const index of prune) delete frozenWeeks[index];
  updateSchedule(id, { frozenWeeks });
}

function updateSchedule(id: string, patch: Partial<ScheduleState>) {
  const plan = getPlan(id);
  if (!plan?.schedule) return;
  updatePlan(id, { schedule: { ...plan.schedule, ...patch } });
}
