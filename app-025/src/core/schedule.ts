/**
 * 开缸日程：从开缸到水质稳定的按周计划。
 *
 * 输入画像（有效水量 / 种植密度 / 是否用泥 / 快慢生草构成）→
 * 每周换水量与次数、光照时长、CO₂ 阶段、下鱼与放虾螺的周次，
 * 以及每周 pH / 氨氮合理范围（供实测值校验提醒）。
 *
 * 除日期推算外全部为纯函数；经验阈值集中在常量区（可配，见开发指南 §5）。
 * 所有步骤都带「理由」与「可观察现象」，里程碑步骤（下鱼/虾螺）id 与周次解耦，
 * 中途改参数重排后勾选状态不丢。
 */
import type { Plan, ScheduleStep, StepKind, WeekPlan } from './types';
import { effectiveVolumeL } from './volume';
import { co2BubblesPerSec } from './water';

// ---- 可配经验阈值 ----
export const DENSE_PLANTS_PER_L = 0.5; // 密植阈值（株/L）：达到后水草可直接吸收相当部分氨
export const BARE_PLANTS_PER_L = 0.05; // 裸缸阈值（株/L）
export const SMALL_TANK_L = 40; // 小缸阈值（L）：水体小缓冲差，换水少量多次、下鱼缓一周
export const FAST_DENSE_RATIO = 0.5; // 快生草占比 ≥ 此值视为速生缸
export const LIGHT_START_H = 4; // 开缸首周光照（小时/天），逐周 +1h
export const LIGHT_CAP_FAST = 8; // 速生/密植缸光照上限（小时/天）
export const LIGHT_CAP_MID = 7;
export const LIGHT_CAP_SLOW = 6; // 慢生/阴性草缸上限
export const PH_RANGE_EARLY: [number, number] = [6.0, 8.0]; // 前两周波动大，放宽
export const PH_RANGE_LATE: [number, number] = [6.2, 7.8];
export const SOIL_PH_LOW_OFFSET = 0.3; // 水草泥降酸，pH 下限放宽
export const NH3_MAX_EARLY: [number, number, number] = [1.0, 0.5, 0.25]; // 第 1/2/3 周氨氮上限 mg/L
export const NH3_MAX_PRE_FISH = 0.25; // 下鱼前（第 3 周以后）
export const NH3_MAX_STOCKED = 0.05; // 下鱼后必须贴近 0

export type PlantDensity = 'bare' | 'sparse' | 'dense';

export type ScheduleProfile = {
  effectiveL: number; // 有效水量 L
  plantQty: number; // 水草总株数
  fastQty: number; // 快生草株数
  slowQty: number; // 慢生草株数
  hasSoil: boolean; // 是否用水草泥（泥开缸期释氨）
  needsCo2: boolean; // 含高光需求水草（高光草需 CO₂ 才跟得上光合）
  targetCo2Ppm: number; // 目标 CO₂ 浓度（泡/秒估算依据）
  density: PlantDensity;
  fastRatio: number; // 快生草占比 0~1
};

/** 从方案推导日程画像：水量、种植密度、是否用泥、快慢生草构成 */
export function profileFromPlan(plan: Plan): ScheduleProfile {
  const eff = effectiveVolumeL(plan.tank, plan.substrate, plan.items);
  const plants = plan.items.filter((i) => i.kind === 'plant');
  const qtyOf = (list: typeof plants) => list.reduce((s, i) => s + (i.qty ?? 1), 0);
  const plantQty = qtyOf(plants);
  const fastQty = qtyOf(plants.filter((i) => i.growth === 'fast'));
  const slowQty = qtyOf(plants.filter((i) => i.growth === 'slow'));
  const perL = eff > 0 ? plantQty / eff : 0;
  const density: PlantDensity =
    perL <= BARE_PLANTS_PER_L ? 'bare' : perL >= DENSE_PLANTS_PER_L ? 'dense' : 'sparse';
  return {
    effectiveL: eff,
    plantQty,
    fastQty,
    slowQty,
    hasSoil: plan.substrate.kind === 'soil' || plan.substrate.kind === 'ada',
    needsCo2: plants.some((i) => i.lightNeed === 'high'),
    targetCo2Ppm: plan.water.targetCo2Ppm,
    density,
    fastRatio: plantQty > 0 ? fastQty / plantQty : 0,
  };
}

/** 日程总周数：裸缸/泥缸 6 周，密植速生 4 周，其余 5 周 */
export function totalWeeks(p: ScheduleProfile): number {
  if (p.density === 'bare') return 6; // 裸缸无草吸氨，走完整养水循环
  if (p.hasSoil) return 6; // 泥前两周持续释氨，多一周大量换水
  if (p.density === 'dense' && p.fastRatio >= FAST_DENSE_RATIO) return 4; // 密植速生建立快
  return 5;
}

/** 第一批鱼下缸周次 */
export function fishWeek(p: ScheduleProfile): number {
  let w = 4;
  if (p.density === 'bare') w = 5; // 无草吸氨，等硝化系统完全建立
  else if (p.density === 'dense' && p.fastRatio >= FAST_DENSE_RATIO) w = 3; // 密植速生可直接吸收氨
  if (p.effectiveL > 0 && p.effectiveL < SMALL_TANK_L) w += 1; // 小水体波动大，缓一周
  return Math.min(w, totalWeeks(p) - 1); // 至少留一周给虾螺
}

/** 放工具虾与螺的周次（在鱼之后，泥缸不早于第 5 周） */
export function shrimpWeek(p: ScheduleProfile): number {
  const min = p.hasSoil ? 5 : 4; // 虾螺对氨氮更敏感且需藻膜，泥缸再缓
  return Math.min(totalWeeks(p), Math.max(fishWeek(p) + 1, min));
}

/** CO₂ 开始周（null = 无需 CO₂）：密植缸第 1 周低量起步，其余第 2 周 */
export function co2StartWeek(p: ScheduleProfile): number | null {
  if (!p.needsCo2) return null;
  return p.density === 'dense' ? 1 : 2;
}

export type Co2Stage = WeekPlan['co2'];

export function co2StageOf(week: number, p: ScheduleProfile): Co2Stage {
  const start = co2StartWeek(p);
  if (start === null || week < start) return 'none';
  if (week === start) return 'start';
  if (week === start + 1) return 'ramp';
  return 'full';
}

/** 光照上限：速生密植 8h，慢生为主 6h，其余 7h */
export function lightCapHours(p: ScheduleProfile): number {
  if (p.density === 'dense' && p.fastRatio >= FAST_DENSE_RATIO) return LIGHT_CAP_FAST;
  if (p.slowQty > p.fastQty) return LIGHT_CAP_SLOW;
  return LIGHT_CAP_MID;
}

/** 第 week 周光照时长：首周 4h 逐周 +1h，到上限为止；裸缸 0（无需固定光照） */
export function lightHoursOf(week: number, p: ScheduleProfile): number {
  if (p.density === 'bare') return 0;
  return Math.min(lightCapHours(p), LIGHT_START_H + week - 1);
}

/** 第 week 周换水：每次 % 与次数。泥缸前两周大量换水，小缸少量多次 */
export function waterChangeOf(week: number, p: ScheduleProfile): { pct: number; times: number } {
  let pct: number;
  let times: number;
  if (p.hasSoil) {
    if (week === 1) [pct, times] = [50, 3];
    else if (week === 2) [pct, times] = [50, 2];
    else if (week === 3) [pct, times] = [30, 2];
    else [pct, times] = [30, 1];
  } else if (p.density === 'bare') {
    [pct, times] = week <= 2 ? [25, 1] : [30, 1];
  } else {
    if (week === 1) [pct, times] = [30, 2];
    else if (week === 2) [pct, times] = [30, 2];
    else if (week === 3) [pct, times] = [30, 1];
    else [pct, times] = [25, 1];
  }
  if (p.effectiveL > 0 && p.effectiveL < SMALL_TANK_L && week <= 2) times += 1; // 小缸少量多次
  return { pct, times };
}

/** 第 week 周氨氮上限 mg/L：下鱼后必须 ≤ 0.05 */
export function nh3MaxOf(week: number, p: ScheduleProfile): number {
  if (week >= fishWeek(p)) return NH3_MAX_STOCKED;
  if (week <= NH3_MAX_EARLY.length) return NH3_MAX_EARLY[week - 1];
  return NH3_MAX_PRE_FISH;
}

/** 第 week 周 pH 合理范围：前两周放宽，泥缸下限再放宽 */
export function phRangeOf(week: number, p: ScheduleProfile): [number, number] {
  const base = week <= 2 ? PH_RANGE_EARLY : PH_RANGE_LATE;
  const lo = p.hasSoil ? base[0] - SOIL_PH_LOW_OFFSET : base[0];
  return [Math.round(lo * 10) / 10, base[1]];
}

function step(
  id: string,
  kind: StepKind,
  title: string,
  reason: string,
  observe: string,
  milestone = false,
): ScheduleStep {
  return { id, kind, title, reason, observe, milestone };
}

function waterReason(week: number, p: ScheduleProfile): string {
  const small = p.effectiveL > 0 && p.effectiveL < SMALL_TANK_L;
  const smallNote = small ? '；小水体波动快，少量多次更稳' : '';
  if (p.hasSoil && week <= 2)
    return `水草泥开缸前两周持续释放氨与有机酸，大量换水防烧根、防爆藻${smallNote}`;
  if (p.hasSoil) return '泥的释氨高峰已过，换回常规节奏，继续稀释残余有机物';
  if (p.density === 'bare')
    return week <= 2
      ? `裸缸无水草吸收氨氮，靠换水控制累积、同时养水养菌${smallNote}`
      : '维持低氨氮水平，让硝化系统继续成熟';
  return week <= 2
    ? `稀释残饵与释出的氨，给硝化系统留出建立时间${smallNote}`
    : '硝化系统渐稳，转入常规维护换水';
}

/** 生成完整日程（按周）。每个步骤都带理由与可观察现象。 */
export function buildSchedule(p: ScheduleProfile): WeekPlan[] {
  const n = totalWeeks(p);
  const fw = fishWeek(p);
  const sw = shrimpWeek(p);
  const weeks: WeekPlan[] = [];

  for (let w = 1; w <= n; w++) {
    const wc = waterChangeOf(w, p);
    const light = lightHoursOf(w, p);
    const co2 = co2StageOf(w, p);
    const steps: ScheduleStep[] = [];

    steps.push(
      step(
        `w${w}-water`,
        'water',
        `换水 ${wc.pct}% × ${wc.times} 次`,
        waterReason(w, p),
        '换水后水体转清、水面油膜减少；泥缸水色由黄浊逐渐转清',
      ),
    );

    if (light > 0) {
      steps.push(
        step(
          `w${w}-light`,
          'light',
          `光照 ${light} 小时/天`,
          w <= 2
            ? '开缸期水草未扎根、光合弱，光照过长会让藻类抢占先机，从短光照起步逐周加长'
            : '随水草扎根生长逐周加长光照，让水草长势压过藻类',
          '水草拔新芽、叶片冒泡（光合作用）为正常；出现褐藻（硅藻）属开缸常见，绿斑藻提示光照过长',
        ),
      );
    }

    if (co2 !== 'none') {
      steps.push(
        step(
          `w${w}-co2`,
          'co2',
          co2 === 'start'
            ? '开始 CO₂：低量起步（目标量的 1/2）'
            : co2 === 'ramp'
              ? 'CO₂ 加量（目标量的 3/4）'
              : 'CO₂ 满量运行',
          co2 === 'start'
            ? 'CO₂ 帮助水草扎根并压制藻类；但硝化细菌耗氧，开缸期从低量起步防缺氧'
            : '水草进入生长期，逐步加到目标量，与光照时长同步',
          '监测液由蓝转绿（约 30ppm）为合适；鱼浮头、贴水面即过量，立即关小并增氧',
        ),
      );
    }

    if (w === 1) {
      steps.push(
        step(
          'w1-filter',
          'maintain',
          '过滤 24 小时连续运行（全程不关）',
          '硝化系统建立在滤材上，持续水流与增氧是菌群定植的前提',
          '出水口水流稳定、水面有轻微波动；滤材逐渐挂膜（触感微黏）',
        ),
      );
    }

    steps.push(
      step(
        `w${w}-measure`,
        'maintain',
        '测 pH 与氨氮并记录到实测栏',
        '开缸期参数每天都在变，记录趋势才能判断硝化系统是否建立',
        w <= 2 ? '氨氮先升高（泥释氨/残饵分解）属正常过程' : '氨氮回落至 0 附近即硝化系统初步建立',
      ),
    );

    if (w === fw) {
      steps.push(
        step(
          'milestone-fish',
          'fish',
          '下第一批鱼（少量、皮实品种）',
          '此时氨氮应已检出归零，硝化系统初步建立；先下少量皮实鱼，排泄物继续喂养硝化菌，避免一次性加鱼过多冲垮系统',
          '入缸 1 小时内开始游动觅食为正常；浮头、扎堆出水口是缺氧或氨超标信号，立即换水',
          true,
        ),
      );
    }

    if (w === sw) {
      steps.push(
        step(
          'milestone-shrimp',
          'shrimp',
          '放工具虾与螺',
          '虾螺对氨氮/亚硝酸盐比鱼敏感一个量级，且需要缸壁长出藻膜、生物膜作为食物，等系统更成熟再放',
          '虾活跃刮食缸壁、正常蜕壳为合适；躲藏不动或死亡说明水质未稳，回退到上一周节奏',
          true,
        ),
      );
    }

    weeks.push({
      week: w,
      waterChangePct: wc.pct,
      waterChangeTimes: wc.times,
      lightHours: light,
      co2,
      effectiveL: p.effectiveL,
      co2Bps: co2BubblesPerSec(p.targetCo2Ppm, p.effectiveL).value,
      steps,
      phRange: phRangeOf(w, p),
      nh3Max: nh3MaxOf(w, p),
    });
  }
  return weeks;
}

// ---- 日期推算（本地时区，按天对齐）----

function dayNum(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function parseDate(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}

/** 当前处于开缸第几周（按开缸日期推算，最小 1，未来日期也算第 1 周） */
export function currentWeek(startDate: string, now = new Date()): number {
  const s = parseDate(startDate);
  if (!s) return 1;
  const start = dayNum(s.y, s.m, s.d);
  const today = dayNum(now.getFullYear(), now.getMonth() + 1, now.getDate());
  return Math.max(1, Math.floor((today - start) / 7) + 1);
}

/** 第 week 周的日期范围，如 "09-26 ~ 10-02" */
export function weekDateRange(startDate: string, week: number): string {
  const s = parseDate(startDate);
  if (!s) return '';
  const start = dayNum(s.y, s.m, s.d) + (week - 1) * 7;
  const fmt = (dn: number) => {
    const d = new Date(dn * 86400000);
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${mm}-${dd}`;
  };
  return `${fmt(start)} ~ ${fmt(start + 6)}`;
}

// ---- 重排：已过去的周锁定不动，未开始的周按最新参数生成 ----

/** 合并生成日程与锁定快照：week < cur 的周用快照，其余用最新生成 */
export function mergeWithLocked(generated: WeekPlan[], locked: WeekPlan[], cur: number): WeekPlan[] {
  return generated.map((g) => {
    const snap = locked.find((l) => l.week === g.week);
    return g.week < cur && snap ? snap : g;
  });
}

/** 已过去但尚未锁定的周（页面负责幂等写入，只补不覆盖） */
export function weeksToLock(generated: WeekPlan[], locked: WeekPlan[], cur: number): WeekPlan[] {
  return generated.filter((g) => g.week < cur && !locked.some((l) => l.week === g.week));
}

// ---- 实测值校验 ----

export type ReadingCheck = { level: 'ok' | 'warn' | 'danger'; message: string };

/** 实测值校验：超出本周合理范围给出提醒与处置建议 */
export function checkReading(week: WeekPlan, kind: 'ph' | 'nh3', value: number): ReadingCheck {
  if (kind === 'ph') {
    const [lo, hi] = week.phRange;
    if (value < lo)
      return {
        level: 'warn',
        message: `pH ${value} 低于本周合理范围 ${lo}~${hi}：可能 CO₂ 过量或泥降酸过快，建议减小 CO₂ 并换水 ${week.waterChangePct}%`,
      };
    if (value > hi)
      return {
        level: 'warn',
        message: `pH ${value} 高于本周合理范围 ${lo}~${hi}：检查换水是否不足、自来水 KH 是否偏高`,
      };
    return { level: 'ok', message: `pH 在本周合理范围 ${lo}~${hi} 内` };
  }
  const max = week.nh3Max;
  if (value > max * 2)
    return {
      level: 'danger',
      message: `氨氮 ${value} mg/L 严重超标（本周应 ≤ ${max}）：立即换水 50%、停喂、检查过滤是否正常运行`,
    };
  if (value > max)
    return {
      level: 'warn',
      message: `氨氮 ${value} mg/L 超出本周上限 ${max}：换水 ${week.waterChangePct}%、减少或停喂，硝化系统尚未跟上`,
    };
  return { level: 'ok', message: `氨氮在本周上限 ${max} mg/L 以内` };
}
