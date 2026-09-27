import { describe, it, expect } from 'vitest';
import {
  deriveScheduleParams,
  buildSchedule,
  scheduleSignature,
  lightHoursTable,
  adjustWcForVolume,
  ammoniaMaxFor,
  evaluateReading,
  gateBlocked,
  materializeSchedule,
  weeksToFreeze,
  currentWeekIndex,
  weekDateRange,
  formatDate,
  parseDate,
  allTaskKeys,
  taskDoneKey,
  scheduleProgress,
  DENSE_PLANTS_PER_L,
  type ScheduleParams,
} from '../src/core/schedule';
import { newPlan } from '../src/state/plans';
import type { Plan } from '../src/core/types';

function baseParams(over: Partial<ScheduleParams> = {}): ScheduleParams {
  return {
    effectiveL: 100,
    plantQty: 100,
    pace: 'fast',
    soil: true,
    style: 'dense-planted',
    fishPhRanges: [],
    targetCo2Ppm: 25,
    ...over,
  };
}

function plantItem(qty: number, growth: 'fast' | 'slow' | 'mid' = 'fast', id = 'p1'): Plan['items'][number] {
  return { id, kind: 'plant', name: '草', x: 1, y: 1, scaleCm: 5, rotDeg: 0, qty, growth };
}

describe('日程参数推导（水量 / 快慢生 / 泥 / 密植-裸缸）', () => {
  it('无植物 → 裸缸；有效水量取自 core/volume', () => {
    const plan = newPlan('裸缸');
    const p = deriveScheduleParams(plan, new Map());
    expect(p.style).toBe('bare');
    expect(p.plantQty).toBe(0);
    expect(p.soil).toBe(true); // 默认底床为 soil
  });

  it('密植：株数 / 有效水量 ≥ 0.5 株/L', () => {
    const plan = newPlan('密植');
    plan.items = Array.from({ length: 10 }, (_, i) => plantItem(10, 'fast', `p${i}`)); // 100 株，~87L
    const p = deriveScheduleParams(plan, new Map());
    expect(p.plantQty / p.effectiveL).toBeGreaterThanOrEqual(DENSE_PLANTS_PER_L);
    expect(p.style).toBe('dense-planted');
    expect(p.pace).toBe('fast');
  });

  it('疏植：有草但密度不足；慢生票过半 → slow', () => {
    const plan = newPlan('疏植');
    plan.items = [plantItem(5, 'slow'), plantItem(2, 'fast', 'p2')]; // 7 株/~87L
    const p = deriveScheduleParams(plan, new Map());
    expect(p.style).toBe('sparse-planted');
    expect(p.pace).toBe('slow');
  });

  it('砂/砾石 → soil=false；ada/soil → true', () => {
    const sand = newPlan('砂缸');
    sand.substrate.kind = 'sand';
    expect(deriveScheduleParams(sand, new Map()).soil).toBe(false);
    const ada = newPlan('ADA');
    ada.substrate.kind = 'ada';
    expect(deriveScheduleParams(ada, new Map()).soil).toBe(true);
  });
});

describe('8 周日程生成：密植 vs 裸缸节奏不同', () => {
  it('两种风格都恰好 8 周，且每周有换水/光照固定项', () => {
    for (const style of ['dense-planted', 'sparse-planted', 'bare'] as const) {
      const s = buildSchedule(baseParams({ style, plantQty: style === 'bare' ? 0 : 10 }));
      expect(s.weeks).toHaveLength(8);
      for (const w of s.weeks) {
        expect(w.waterChange.pct).toBeGreaterThan(0);
        expect(w.waterChange.liters).toBeCloseTo((w.waterChange.pct / 100) * s.effectiveL, 6);
        expect(w.light.hoursPerDay).toBeGreaterThan(0);
        // 每条任务都有理由与可观察现象
        for (const t of w.tasks) {
          expect(t.reason.length).toBeGreaterThan(5);
          expect(t.expect.length).toBeGreaterThan(5);
        }
      }
    }
  });

  it('裸缸无 CO₂ 任务；草缸每周都有 CO₂ 任务，且先不开→半量→全量', () => {
    const bare = buildSchedule(baseParams({ style: 'bare', plantQty: 0 }));
    expect(bare.weeks.every((w) => w.co2 === null)).toBe(true);

    const denseFast = buildSchedule(baseParams({ style: 'dense-planted', pace: 'fast' }));
    expect(denseFast.weeks.every((w) => w.co2 !== null)).toBe(true);
    expect(denseFast.weeks[0].co2!.title).toContain('不开');
    expect(denseFast.weeks[1].co2!.title).toContain('半量');
    expect(denseFast.weeks[2].co2!.title).toContain('全量');

    // 慢生草节奏更晚：第 1 周不开、第 2 周半量、第 3 周全量
    const slow = buildSchedule(baseParams({ style: 'dense-planted', pace: 'slow' }));
    expect(slow.weeks[0].co2!.title).toContain('不开');
    expect(slow.weeks[1].co2!.title).toContain('不开');
    expect(slow.weeks[2].co2!.title).toContain('半量');
    expect(slow.weeks[3].co2!.title).toContain('全量');
  });

  it('首批鱼时点：密植第 4 周、疏植第 5 周、裸缸第 6 周', () => {
    const findFishWeek = (style: 'dense-planted' | 'sparse-planted' | 'bare') =>
      buildSchedule(baseParams({ style, plantQty: style === 'bare' ? 0 : 10 })).weeks.findIndex((w) =>
        w.tasks.some((t) => t.id === 'first-fish'),
      );
    expect(findFishWeek('dense-planted')).toBe(3);
    expect(findFishWeek('sparse-planted')).toBe(4);
    expect(findFishWeek('bare')).toBe(5);
  });

  it('虾先于鱼（密植第 4 周），螺先于虾（第 3 周）', () => {
    const s = buildSchedule(baseParams({ style: 'dense-planted' }));
    const snail = s.weeks.findIndex((w) => w.tasks.some((t) => t.id === 'snail'));
    const shrimp = s.weeks.findIndex((w) => w.tasks.some((t) => t.id === 'shrimp'));
    const fish = s.weeks.findIndex((w) => w.tasks.some((t) => t.id === 'first-fish'));
    expect(snail).toBe(2);
    expect(shrimp).toBe(3);
    expect(fish).toBe(3);
  });

  it('裸缸提示虾需额外躲避，且不安排常规放虾任务', () => {
    const s = buildSchedule(baseParams({ style: 'bare', plantQty: 0 }));
    expect(s.weeks.some((w) => w.tasks.some((t) => t.id === 'shrimp'))).toBe(false);
    expect(s.weeks[7].tasks.some((t) => t.id === 'shrimp-note')).toBe(true);
  });
});

describe('换水日程随水量修正', () => {
  it('小缸单次 ≤25% 且必要时分多次', () => {
    const adjusted = adjustWcForVolume({ pct: 50, timesPerWeek: 1, reason: 'x' }, 30);
    expect(adjusted.pct).toBeLessThanOrEqual(25);
    expect(adjusted.timesPerWeek).toBe(2);
  });

  it('大缸单次可低 5%', () => {
    const adjusted = adjustWcForVolume({ pct: 50, timesPerWeek: 1, reason: 'x' }, 200);
    expect(adjusted.pct).toBe(45);
  });

  it('中等缸不修正；裸缸前两周每周两次换水', () => {
    const mid = adjustWcForVolume({ pct: 40, timesPerWeek: 1, reason: 'x' }, 100);
    expect(mid.pct).toBe(40);
    const bare = buildSchedule(baseParams({ style: 'bare', plantQty: 0 }));
    expect(bare.weeks[0].waterChange.timesPerWeek).toBe(2);
  });

  it('新水草泥密植缸第 1 周每周两次抽释放物', () => {
    const s = buildSchedule(baseParams({ style: 'dense-planted', soil: true }));
    expect(s.weeks[0].waterChange.timesPerWeek).toBe(2);
    // 惰性底床密植缸首周一次
    const inert = buildSchedule(baseParams({ style: 'dense-planted', soil: false }));
    expect(inert.weeks[0].waterChange.timesPerWeek).toBe(1);
  });

  it('裸缸下首批鱼当周（第 6 周）换水量减半', () => {
    const s = buildSchedule(baseParams({ style: 'bare', plantQty: 0, effectiveL: 100 }));
    expect(s.weeks[5].waterChange.pct).toBe(30);
    expect(s.weeks[4].waterChange.pct).toBe(40);
  });
});

describe('光照爬升', () => {
  it('密植快生起步高、逐周爬到 10h；疏植起步低', () => {
    const dense = lightHoursTable('dense-planted', 'fast');
    expect(dense[0]).toBe(6);
    expect(dense[7]).toBe(10);
    for (let i = 1; i < 8; i++) expect(dense[i]).toBeGreaterThanOrEqual(dense[i - 1]);
    const sparse = lightHoursTable('sparse-planted', 'fast');
    expect(sparse[0]).toBe(4);
    expect(sparse[sparse.length - 1]).toBe(8);
  });

  it('裸缸只保留观赏照明（≤6h）', () => {
    expect(Math.max(...lightHoursTable('bare', 'fast'))).toBeLessThanOrEqual(6);
  });
});

describe('合理范围与实测提醒（evaluateReading）', () => {
  it('氨氮上限：裸缸养水期宽（2→1→0.25），密植始终低', () => {
    expect(ammoniaMaxFor('bare', 0)).toBe(2);
    expect(ammoniaMaxFor('bare', 2)).toBe(1);
    expect(ammoniaMaxFor('bare', 4)).toBe(0.25);
    expect(ammoniaMaxFor('dense-planted', 0)).toBe(0.5);
    expect(ammoniaMaxFor('dense-planted', 3)).toBe(0.25);
    expect(ammoniaMaxFor('sparse-planted', 1)).toBe(1);
  });

  it('pH 超出本周范围 → 警告；范围内不警告', () => {
    const s = buildSchedule(baseParams({ style: 'dense-planted', soil: true }));
    const w0 = s.weeks[0]; // pH 5.8~7.2
    expect(evaluateReading(w0, 'ph', 5.6).some((a) => a.level === 'warn')).toBe(true);
    expect(evaluateReading(w0, 'ph', 7.6).some((a) => a.level === 'warn')).toBe(true);
    expect(evaluateReading(w0, 'ph', 6.6).some((a) => a.level === 'warn')).toBe(false);
  });

  it('氨氮超本周上限 → 警告', () => {
    const s = buildSchedule(baseParams({ style: 'dense-planted' }));
    expect(evaluateReading(s.weeks[3], 'ammonia', 0.5).some((a) => a.level === 'warn')).toBe(true);
    expect(evaluateReading(s.weeks[3], 'ammonia', 0.1).some((a) => a.level === 'warn')).toBe(false);
  });

  it('下鱼周氨超标额外提示「先别下鱼」', () => {
    const s = buildSchedule(baseParams({ style: 'dense-planted' }));
    const alerts = evaluateReading(s.weeks[3], 'ammonia', 0.6);
    expect(alerts.some((a) => a.message.includes('先别下鱼'))).toBe(true);
  });

  it('pH ≥7.5 给出非离子氨信息提醒（info，不阻断）', () => {
    const s = buildSchedule(baseParams({ style: 'bare', plantQty: 0 }));
    expect(evaluateReading(s.weeks[0], 'ph', 7.6).some((a) => a.level === 'info')).toBe(true);
  });

  it('下鱼周起 pH 范围与已选鱼种耐受取交集', () => {
    // 金鱼 7~8.5；密植泥缸 5.8~7.2，交集 7~7.2
    const s = buildSchedule(baseParams({ style: 'dense-planted', soil: true, fishPhRanges: [[7, 8.5]] }));
    expect(s.weeks[3].ranges.ph.min).toBe(7);
    expect(s.weeks[3].ranges.ph.max).toBe(7.2);
    // 下鱼周之前不收紧
    expect(s.weeks[0].ranges.ph.min).toBe(5.8);
  });
});

describe('里程碑前置条件 gateBlocked', () => {
  it('未测值不阻断（由 UI 按当周提示）；超标 → 未满足；合格 → 放行', () => {
    const s = buildSchedule(baseParams({ style: 'dense-planted' }));
    const fish = s.weeks[3].tasks.find((t) => t.id === 'first-fish')!;
    expect(gateBlocked(fish, undefined)).toBeNull();
    expect(gateBlocked(fish, {})).toBeNull();
    expect(gateBlocked(fish, { ammonia: 0.5 })).toContain('未满足');
    expect(gateBlocked(fish, { ammonia: 0.2 })).toBeNull();
  });
});

describe('改缸体/水草后只重排当周及以后（冻结快照）', () => {
  it('历史周用冻结快照，当周及以后用新参数', () => {
    const oldParams = baseParams({ effectiveL: 100, plantQty: 100 });
    const old = buildSchedule(oldParams);
    const current = 3;
    const toFreeze = weeksToFreeze(old, scheduleSignature(oldParams), {}, current, 123);
    expect(toFreeze.map((x) => x.index)).toEqual([0, 1, 2]);

    const frozen: Record<number, { signature: string; week: (typeof old.weeks)[number] }> = {};
    for (const { index, entry } of toFreeze) frozen[index] = entry;

    // 用户把缸改大 → 重新生成
    const newParams = baseParams({ effectiveL: 200, plantQty: 100 });
    const next = buildSchedule(newParams);
    const mat = materializeSchedule(next, frozen, current);

    // 历史周保留旧水量 100L 算出的换水量
    expect(mat[0].frozen).toBe(true);
    expect(mat[0].week.waterChange.liters).toBeCloseTo((old.weeks[0].waterChange.pct / 100) * 100, 5);
    // 当周起使用新参数
    expect(mat[3].frozen).toBe(false);
    expect(mat[3].week.waterChange.liters).toBeCloseTo((next.weeks[3].waterChange.pct / 100) * 200, 5);
  });

  it('从密植改为裸缸：历史周不动，未来周 CO₂ 消失、下鱼周后移', () => {
    const dense = baseParams({ style: 'dense-planted' });
    const denseSched = buildSchedule(dense);
    const frozen: Record<number, { signature: string; week: (typeof denseSched.weeks)[number] }> = {};
    for (const { index, entry } of weeksToFreeze(denseSched, scheduleSignature(dense), {}, 4, 1)) {
      frozen[index] = entry;
    }
    const bare = buildSchedule(baseParams({ style: 'bare', plantQty: 0 }));
    const mat = materializeSchedule(bare, frozen, 4);
    // 历史第 4 周（index 3）保留密植安排：首批鱼仍在该周、有 CO₂
    expect(mat[3].frozen).toBe(true);
    expect(mat[3].week.co2).not.toBeNull();
    expect(mat[3].week.tasks.some((t) => t.id === 'first-fish')).toBe(true);
    // 未来第 5 周（index 4）按裸缸重排：无 CO₂、还在养水不下鱼
    expect(mat[4].frozen).toBe(false);
    expect(mat[4].week.co2).toBeNull();
    expect(mat[4].week.tasks.some((t) => t.id === 'first-fish')).toBe(false);
    // 裸缸首批鱼在第 6 周（index 5）
    expect(mat[5].week.co2).toBeNull();
    expect(mat[5].week.tasks.some((t) => t.id === 'first-fish')).toBe(true);
  });
});

describe('周次与日期', () => {
  it('开缸日为第 0 周；7 天后（第 8 天）为第 1 周', () => {
    const start = '2026-09-01';
    expect(currentWeekIndex(start, parseDate('2026-09-01'))).toBe(0);
    expect(currentWeekIndex(start, parseDate('2026-09-07'))).toBe(0); // 第 7 天仍在第 1 周
    expect(currentWeekIndex(start, parseDate('2026-09-08'))).toBe(1);
    expect(currentWeekIndex(start, parseDate('2026-09-14'))).toBe(1);
    expect(currentWeekIndex(start, parseDate('2026-09-15'))).toBe(2);
  });

  it('超过 8 周钳制在最后一周；开缸日前按第 0 周处理', () => {
    const start = '2026-01-01';
    expect(currentWeekIndex(start, parseDate('2026-06-01'))).toBe(7);
    expect(currentWeekIndex(start, parseDate('2025-12-31'))).toBe(0);
  });

  it('周区间：第 n 周从开缸日 +7n 起共 7 天', () => {
    const { start, end } = weekDateRange('2026-09-01', 2);
    expect(formatDate(start)).toBe('2026-09-15');
    expect(formatDate(end)).toBe('2026-09-21');
  });
});

describe('勾选与进度', () => {
  it('task key 稳定：同风格两次生成 id 一致', () => {
    const a = buildSchedule(baseParams());
    const b = buildSchedule(baseParams());
    expect(a.weeks.map((w) => allTaskKeys(w).join(','))).toEqual(b.weeks.map((w) => allTaskKeys(w).join(',')));
  });

  it('勾选后进度正确统计（换水/灯/CO₂/里程碑都算任务）', () => {
    const s = buildSchedule(baseParams());
    const done: Record<string, boolean> = {};
    const total = s.weeks.reduce((n, w) => n + allTaskKeys(w).length, 0);
    expect(scheduleProgress(s.weeks, done).total).toBe(total);
    for (const key of allTaskKeys(s.weeks[0])) done[taskDoneKey(0, key)] = true;
    const prog = scheduleProgress(s.weeks, done);
    expect(prog.done).toBe(allTaskKeys(s.weeks[0]).length);
    expect(prog.pct).toBe(Math.round((prog.done / total) * 100));
  });
});
