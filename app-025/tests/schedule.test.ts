import { describe, it, expect } from 'vitest';
import {
  profileFromPlan,
  buildSchedule,
  totalWeeks,
  fishWeek,
  shrimpWeek,
  co2StartWeek,
  co2StageOf,
  lightHoursOf,
  waterChangeOf,
  nh3MaxOf,
  phRangeOf,
  currentWeek,
  weekDateRange,
  mergeWithLocked,
  weeksToLock,
  checkReading,
} from '../src/core/schedule';
import { newPlan } from '../src/state/plans';
import type { Item, Plan, Substrate } from '../src/core/types';

/**
 * 开缸日程核心逻辑单测。
 * 默认缸 60×45×45 水面 390mm + 泥 50+60mm：毛水量 105.3L，底砂 21.6L，有效水量 83.7L。
 * 密度阈值：裸缸 ≤0.05 株/L（≈4 株），密植 ≥0.5 株/L（≈42 株）。
 */

function plant(qty: number, growth: 'slow' | 'mid' | 'fast', lightNeed: 'low' | 'mid' | 'high' = 'mid'): Item {
  return {
    id: `i-${growth}-${lightNeed}-${qty}`,
    kind: 'plant',
    name: '测试草',
    x: 10,
    y: 10,
    scaleCm: 10,
    rotDeg: 0,
    layer: 'mid',
    lightNeed,
    growth,
    qty,
  };
}

function mkPlan(opts: { items?: Item[]; kind?: Substrate['kind']; tank?: Partial<Plan['tank']> } = {}): Plan {
  const p = newPlan('日程测试');
  return {
    ...p,
    items: opts.items ?? [],
    substrate: { ...p.substrate, kind: opts.kind ?? 'soil' },
    tank: { ...p.tank, ...(opts.tank ?? {}) },
  };
}

const SMALL_TANK = { l: 40, w: 30, h: 30, waterLevelMm: 250 }; // 有效水量约 26.4L

describe('profileFromPlan：从方案推导日程画像', () => {
  it('泥（soil/ada）→ hasSoil；沙/砾 → 非泥', () => {
    expect(profileFromPlan(mkPlan({ kind: 'soil' })).hasSoil).toBe(true);
    expect(profileFromPlan(mkPlan({ kind: 'ada' })).hasSoil).toBe(true);
    expect(profileFromPlan(mkPlan({ kind: 'sand' })).hasSoil).toBe(false);
    expect(profileFromPlan(mkPlan({ kind: 'gravel' })).hasSoil).toBe(false);
  });

  it('种植密度三档：0 株裸缸 / 10 株疏植 / 50 株密植（83.7L 缸）', () => {
    expect(profileFromPlan(mkPlan()).density).toBe('bare');
    expect(profileFromPlan(mkPlan({ items: [plant(10, 'mid')] })).density).toBe('sparse');
    expect(profileFromPlan(mkPlan({ items: [plant(50, 'mid')] })).density).toBe('dense');
  });

  it('高光草 → needsCo2；快慢生草株数与占比统计', () => {
    const p = profileFromPlan(mkPlan({ items: [plant(30, 'fast', 'high'), plant(30, 'slow', 'low')] }));
    expect(p.needsCo2).toBe(true);
    expect(p.fastQty).toBe(30);
    expect(p.slowQty).toBe(30);
    expect(p.fastRatio).toBeCloseTo(0.5, 5);
    expect(profileFromPlan(mkPlan({ items: [plant(20, 'slow', 'low')] })).needsCo2).toBe(false);
  });
});

describe('日程节奏：按水量/密度/泥/快慢生草分档', () => {
  it('总周数：裸缸 6、泥缸 6、密植速生无泥 4、疏植无泥 5', () => {
    expect(totalWeeks(profileFromPlan(mkPlan()))).toBe(6); // 裸缸+泥
    expect(totalWeeks(profileFromPlan(mkPlan({ items: [plant(10, 'mid')] })))).toBe(6); // 泥+疏植
    expect(totalWeeks(profileFromPlan(mkPlan({ items: [plant(50, 'fast')], kind: 'sand' })))).toBe(4); // 密植速生无泥
    expect(totalWeeks(profileFromPlan(mkPlan({ items: [plant(10, 'mid')], kind: 'sand' })))).toBe(5); // 疏植无泥
  });

  it('换水：泥缸前两周大量（50%×3 → 50%×2），非泥草缸 30%×2 起步，裸缸 25%×1', () => {
    const soil = profileFromPlan(mkPlan({ items: [plant(10, 'mid')] }));
    expect(waterChangeOf(1, soil)).toEqual({ pct: 50, times: 3 });
    expect(waterChangeOf(2, soil)).toEqual({ pct: 50, times: 2 });
    expect(waterChangeOf(4, soil)).toEqual({ pct: 30, times: 1 });
    const noSoil = profileFromPlan(mkPlan({ items: [plant(10, 'mid')], kind: 'sand' }));
    expect(waterChangeOf(1, noSoil)).toEqual({ pct: 30, times: 2 });
    const bare = profileFromPlan(mkPlan({ kind: 'sand' }));
    expect(waterChangeOf(1, bare)).toEqual({ pct: 25, times: 1 });
  });

  it('小缸（<40L）前两周换水次数 +1（少量多次）', () => {
    const small = profileFromPlan(mkPlan({ items: [plant(5, 'mid')], tank: SMALL_TANK }));
    expect(small.effectiveL).toBeLessThan(40);
    expect(waterChangeOf(1, small).times).toBe(4); // 泥缸 3 + 1
    expect(waterChangeOf(3, small).times).toBe(2); // 第三周起不再加
  });

  it('光照：裸缸 0；草缸首周 4h 逐周 +1h；慢生为主上限 6h，密植速生上限 8h', () => {
    const bare = profileFromPlan(mkPlan());
    expect(lightHoursOf(1, bare)).toBe(0);
    const slow = profileFromPlan(mkPlan({ items: [plant(20, 'slow'), plant(5, 'fast')] }));
    expect(lightHoursOf(1, slow)).toBe(4);
    expect(lightHoursOf(2, slow)).toBe(5);
    expect(lightHoursOf(3, slow)).toBe(6);
    expect(lightHoursOf(6, slow)).toBe(6); // 到上限
    const fastDense = profileFromPlan(mkPlan({ items: [plant(50, 'fast')], kind: 'sand' }));
    expect(lightHoursOf(4, fastDense)).toBe(7); // 4 周日程内 4→7
    expect(lightHoursOf(5, fastDense)).toBe(8); // 上限 8
  });

  it('CO₂：密植+高光第 1 周起步，疏植+高光第 2 周，无高光草全程不开', () => {
    const dense = profileFromPlan(mkPlan({ items: [plant(50, 'fast', 'high')] }));
    expect(co2StartWeek(dense)).toBe(1);
    expect(co2StageOf(1, dense)).toBe('start');
    expect(co2StageOf(2, dense)).toBe('ramp');
    expect(co2StageOf(4, dense)).toBe('full');
    const sparse = profileFromPlan(mkPlan({ items: [plant(10, 'mid', 'high')] }));
    expect(co2StartWeek(sparse)).toBe(2);
    expect(co2StageOf(1, sparse)).toBe('none');
    const noNeed = profileFromPlan(mkPlan({ items: [plant(10, 'slow', 'low')] }));
    expect(co2StartWeek(noNeed)).toBeNull();
    expect(co2StageOf(3, noNeed)).toBe('none');
  });

  it('下鱼周：密植速生第 3 周、常规第 4 周、裸缸第 5 周、小缸缓一周', () => {
    expect(fishWeek(profileFromPlan(mkPlan({ items: [plant(50, 'fast')], kind: 'sand' })))).toBe(3);
    expect(fishWeek(profileFromPlan(mkPlan({ items: [plant(10, 'mid')] })))).toBe(4);
    expect(fishWeek(profileFromPlan(mkPlan()))).toBe(5);
    expect(fishWeek(profileFromPlan(mkPlan({ items: [plant(5, 'mid')], tank: SMALL_TANK })))).toBe(5);
  });

  it('虾螺周：在鱼之后，且泥缸不早于第 5 周', () => {
    const soil = profileFromPlan(mkPlan({ items: [plant(10, 'mid')] }));
    expect(shrimpWeek(soil)).toBe(5);
    expect(shrimpWeek(soil)).toBeGreaterThan(fishWeek(soil));
    const fastDense = profileFromPlan(mkPlan({ items: [plant(50, 'fast')], kind: 'sand' }));
    expect(shrimpWeek(fastDense)).toBe(4); // 鱼第 3 周 → 虾螺第 4 周
    const bare = profileFromPlan(mkPlan());
    expect(shrimpWeek(bare)).toBe(6);
  });

  it('氨氮上限：第 1 周 1.0、第 2 周 0.5，下鱼后 0.05', () => {
    const p = profileFromPlan(mkPlan({ items: [plant(10, 'mid')] })); // 鱼第 4 周
    expect(nh3MaxOf(1, p)).toBe(1.0);
    expect(nh3MaxOf(2, p)).toBe(0.5);
    expect(nh3MaxOf(3, p)).toBe(0.25);
    expect(nh3MaxOf(4, p)).toBe(0.05);
  });

  it('pH 范围：前两周放宽，泥缸下限更低', () => {
    const soil = profileFromPlan(mkPlan({ items: [plant(10, 'mid')] }));
    const sand = profileFromPlan(mkPlan({ items: [plant(10, 'mid')], kind: 'sand' }));
    expect(phRangeOf(1, soil)[0]).toBeLessThan(phRangeOf(1, sand)[0]);
    expect(phRangeOf(1, sand)).toEqual([6.0, 8.0]);
    expect(phRangeOf(4, sand)).toEqual([6.2, 7.8]);
  });
});

describe('buildSchedule：整表结构', () => {
  it('每个步骤都带理由与可观察现象，id 全表唯一', () => {
    const weeks = buildSchedule(profileFromPlan(mkPlan({ items: [plant(10, 'mid')] })));
    const ids = new Set<string>();
    for (const w of weeks) {
      expect(w.steps.length).toBeGreaterThanOrEqual(2); // 至少有换水+测水
      for (const s of w.steps) {
        expect(s.reason.length).toBeGreaterThan(0);
        expect(s.observe.length).toBeGreaterThan(0);
        expect(ids.has(s.id)).toBe(false);
        ids.add(s.id);
      }
    }
  });

  it('里程碑：下鱼、虾螺各恰好一次，出现在对应周', () => {
    const p = profileFromPlan(mkPlan({ items: [plant(10, 'mid')] })); // 鱼 4 / 虾螺 5
    const weeks = buildSchedule(p);
    const fishSteps = weeks.flatMap((w) => w.steps.filter((s) => s.id === 'milestone-fish').map((s) => w.week));
    const shrimpSteps = weeks.flatMap((w) => w.steps.filter((s) => s.id === 'milestone-shrimp').map((s) => w.week));
    expect(fishSteps).toEqual([4]);
    expect(shrimpSteps).toEqual([5]);
    // 里程碑 id 与周次解耦（重排跨周移动时勾选状态不丢）
    expect(weeks[3].steps.find((s) => s.id === 'milestone-fish')!.milestone).toBe(true);
  });

  it('裸缸无光照/CO₂ 步骤，密植高光缸第 1 周有 CO₂ 步骤', () => {
    const bare = buildSchedule(profileFromPlan(mkPlan({ kind: 'sand' })));
    expect(bare.flatMap((w) => w.steps).some((s) => s.kind === 'light')).toBe(false);
    expect(bare.flatMap((w) => w.steps).some((s) => s.kind === 'co2')).toBe(false);
    const dense = buildSchedule(profileFromPlan(mkPlan({ items: [plant(50, 'fast', 'high')] })));
    expect(dense[0].steps.some((s) => s.kind === 'co2')).toBe(true);
    expect(dense[0].steps.some((s) => s.kind === 'light')).toBe(true);
  });
});

describe('日期推算', () => {
  const now = new Date(2026, 8, 26); // 2026-09-26 本地

  it('currentWeek：当天第 1 周，满 7 天进第 2 周，未来日期与非法值兜底第 1 周', () => {
    expect(currentWeek('2026-09-26', now)).toBe(1);
    expect(currentWeek('2026-09-20', now)).toBe(1); // 6 天
    expect(currentWeek('2026-09-19', now)).toBe(2); // 7 天
    expect(currentWeek('2026-09-12', now)).toBe(3); // 14 天
    expect(currentWeek('2026-10-01', now)).toBe(1); // 未来
    expect(currentWeek('not-a-date', now)).toBe(1);
  });

  it('weekDateRange：第 1 周 09-26 ~ 10-02，第 2 周 10-03 ~ 10-09', () => {
    expect(weekDateRange('2026-09-26', 1)).toBe('09-26 ~ 10-02');
    expect(weekDateRange('2026-09-26', 2)).toBe('10-03 ~ 10-09');
    expect(weekDateRange('bad', 1)).toBe('');
  });
});

describe('重排：已过去的周锁定不动', () => {
  it('mergeWithLocked：过去周用快照（即使参数已变），未来周用最新生成', () => {
    const generated = buildSchedule(profileFromPlan(mkPlan({ items: [plant(10, 'mid')] })));
    const lockedSnap = { ...generated[0], waterChangePct: 99 }; // 模拟锁定时的旧参数
    const merged = mergeWithLocked(generated, [lockedSnap], 2);
    expect(merged[0].waterChangePct).toBe(99); // 第 1 周已过去 → 快照
    expect(merged[1].waterChangePct).toBe(generated[1].waterChangePct); // 第 2 周起用新参数
  });

  it('weeksToLock：只返回已过去且未锁定的周', () => {
    const generated = buildSchedule(profileFromPlan(mkPlan({ items: [plant(10, 'mid')] })));
    expect(weeksToLock(generated, [], 3).map((w) => w.week)).toEqual([1, 2]);
    expect(weeksToLock(generated, [generated[0]], 3).map((w) => w.week)).toEqual([2]);
    expect(weeksToLock(generated, generated.slice(0, 2), 3)).toEqual([]);
    expect(weeksToLock(generated, [], 1)).toEqual([]); // 第 1 周不算过去
  });
});

describe('checkReading：实测值超范围提醒', () => {
  const week = buildSchedule(profileFromPlan(mkPlan({ items: [plant(10, 'mid')] })))[0];
  // 第 1 周（泥缸）：pH 5.7~8.0，氨氮 ≤ 1.0

  it('pH：范围内 ok，越界 warn 并给出处置建议', () => {
    expect(checkReading(week, 'ph', 6.8).level).toBe('ok');
    const low = checkReading(week, 'ph', 5.0);
    expect(low.level).toBe('warn');
    expect(low.message).toContain('低于');
    const high = checkReading(week, 'ph', 8.5);
    expect(high.level).toBe('warn');
    expect(high.message).toContain('高于');
  });

  it('氨氮：≤上限 ok，超上限 warn 提示换水，超 2 倍 danger 提示立即换水 50%', () => {
    expect(checkReading(week, 'nh3', 0.5).level).toBe('ok');
    const over = checkReading(week, 'nh3', 1.5);
    expect(over.level).toBe('warn');
    expect(over.message).toContain('换水');
    const danger = checkReading(week, 'nh3', 2.5);
    expect(danger.level).toBe('danger');
    expect(danger.message).toContain('立即换水 50%');
  });
});
