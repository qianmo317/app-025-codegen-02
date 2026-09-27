import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App';
import {
  upsertPlan,
  newPlan,
  deletePlan,
  getPlans,
  getPlan,
  updatePlan,
  updateStartup,
} from '../src/state/plans';
import type { Item } from '../src/core/types';

/** 开缸日程页组件测试：表格渲染、勾选持久化、实测提醒、改参数重排不打乱过去周 */

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function plant(qty: number, growth: 'slow' | 'mid' | 'fast', lightNeed: 'low' | 'mid' | 'high' = 'mid'): Item {
  return {
    id: `i-${growth}-${lightNeed}-${qty}`,
    kind: 'plant',
    name: '红宫廷',
    x: 10,
    y: 10,
    scaleCm: 20,
    rotDeg: 0,
    layer: 'back',
    lightNeed,
    growth,
    qty,
  };
}

async function openStartup(planId: string) {
  window.location.hash = `/plan/${planId}/startup`;
  const r = render(<App />);
  await screen.findByTestId('startup-page');
  return r;
}

describe('开缸日程页', () => {
  beforeEach(() => {
    window.location.hash = '/';
    localStorage.clear();
    getPlans().forEach((p) => deletePlan(p.id));
  });

  it('默认方案（泥+无草）渲染 6 周表格：每周换水/光照/CO₂/生物列与步骤（含理由与现象）', async () => {
    const plan = newPlan('日程缸');
    upsertPlan(plan);
    await openStartup(plan.id);

    expect(screen.getByTestId('startup-summary').textContent).toContain('裸缸');
    expect(screen.getByTestId('current-week').textContent).toBe('1');
    for (let w = 1; w <= 6; w++) {
      expect(screen.getByTestId(`week-${w}`)).toBeInTheDocument();
    }
    const w1 = screen.getByTestId('week-1');
    expect(w1.textContent).toContain('换水 50% × 3 次'); // 泥缸首周大量换水
    expect(w1.textContent).toContain('每次约'); // 按有效水量折算升数
    expect(w1.textContent).toContain('无需固定光照'); // 裸缸
    expect(w1.textContent).toContain('无需 CO₂');
    expect(w1.textContent).toContain('理由：');
    expect(w1.textContent).toContain('现象：');
    expect(w1.textContent).toContain('本周'); // 当前周标记
    // 下鱼里程碑出现在第 5 周（裸缸）
    expect(screen.getByTestId('milestones-5').textContent).toContain('第一批鱼');
    expect(screen.getByTestId('milestones-6').textContent).toContain('虾、螺');
  });

  it('勾选步骤后持久化：重挂载仍保持勾选', async () => {
    const plan = newPlan('勾选缸');
    upsertPlan(plan);
    const first = await openStartup(plan.id);

    const box = screen.getByTestId('step-w1-water') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await userEvent.click(box);
    expect((screen.getByTestId('step-w1-water') as HTMLInputElement).checked).toBe(true);
    expect(getPlan(plan.id)!.startup!.done['w1-water']).toBe(true);

    // 卸载重挂（模拟刷新），勾选仍在
    first.unmount();
    await openStartup(plan.id);
    expect((screen.getByTestId('step-w1-water') as HTMLInputElement).checked).toBe(true);
  });

  it('实测栏：氨氮超 2 倍上限出危险提醒，pH 超范围出提醒，范围内显示正常', async () => {
    const plan = newPlan('实测缸');
    upsertPlan(plan);
    await openStartup(plan.id);

    // 第 1 周（泥缸）：氨氮上限 1.0，pH 5.7~8.0
    await userEvent.type(screen.getByTestId('reading-nh3-1'), '2.5');
    expect(screen.getByTestId('nh3-check-1').textContent).toContain('严重超标');
    expect(screen.getByTestId('nh3-check-1').textContent).toContain('立即换水 50%');

    await userEvent.type(screen.getByTestId('reading-ph-1'), '8.5');
    expect(screen.getByTestId('ph-check-1').textContent).toContain('高于');

    // 改回范围内 → 正常提示
    await userEvent.clear(screen.getByTestId('reading-ph-1'));
    await userEvent.type(screen.getByTestId('reading-ph-1'), '6.5');
    expect(screen.getByTestId('ph-check-1').textContent).toContain('在本周合理范围');

    // 实测值持久化
    expect(getPlan(plan.id)!.startup!.readings[1].nh3).toBe(2.5);
    expect(getPlan(plan.id)!.startup!.readings[1].ph).toBe(6.5);
  });

  it('中途改缸体尺寸：未开始的周重排，已过去的周保持锁定不变', async () => {
    const plan = newPlan('重排缸');
    upsertPlan(plan);
    updateStartup(plan.id, { startDate: daysAgo(8) }); // 当前第 2 周
    await openStartup(plan.id);

    expect(screen.getByTestId('current-week').textContent).toBe('2');
    expect(screen.getByTestId('week-1').textContent).toContain('已锁定');
    const w1Before = screen.getByTestId('week-1').textContent;
    const w2Before = screen.getByTestId('week-2').textContent;
    expect(w2Before).toContain('41.8 L'); // 60cm 缸有效水量 83.7L × 50%

    // 缸长 60 → 120（有效水量翻倍，换水升数应变）
    const fresh = getPlan(plan.id)!;
    act(() => updatePlan(plan.id, { tank: { ...fresh.tank, l: 120 } }));

    const w1After = screen.getByTestId('week-1').textContent;
    const w2After = screen.getByTestId('week-2').textContent;
    expect(w1After).toBe(w1Before); // 已过去的周不动
    expect(w2After).not.toBe(w2Before); // 未开始的周重排
    expect(w2After).toContain('83.7 L'); // 120cm 缸有效水量 167.4L × 50%
    expect(w1After).not.toContain('83.7 L');
  });

  it('里程碑步骤跨重排保留勾选；改底床类型后周数随之变化', async () => {
    const plan = newPlan('密植缸');
    upsertPlan({ ...plan, items: [plant(50, 'fast', 'high')] }); // 密植速生+泥 → 6 周
    await openStartup(plan.id);

    expect(screen.getByTestId('startup-summary').textContent).toContain('密植草缸');
    expect(screen.getByTestId('milestones-3').textContent).toContain('第一批鱼'); // 第 3 周下鱼
    expect(screen.getByTestId('milestones-5').textContent).toContain('虾、螺');
    expect(screen.getByTestId('week-1').textContent).toContain('本周开始'); // 密植第 1 周起 CO₂

    await userEvent.click(screen.getByTestId('step-milestone-fish'));
    expect((screen.getByTestId('step-milestone-fish') as HTMLInputElement).checked).toBe(true);

    // 泥 → 沙：密植速生无泥 → 4 周日程
    const fresh = getPlan(plan.id)!;
    act(() => updatePlan(plan.id, { substrate: { ...fresh.substrate, kind: 'sand' } }));
    expect(screen.getByTestId('week-4')).toBeInTheDocument();
    expect(screen.queryByTestId('week-5')).toBeNull();
    // 里程碑勾选跨重排保留
    expect((screen.getByTestId('step-milestone-fish') as HTMLInputElement).checked).toBe(true);
  });

  it('修改开缸日期会推进当前周（过去的周出现锁定标记）', async () => {
    const plan = newPlan('日期缸');
    upsertPlan(plan);
    await openStartup(plan.id);
    expect(screen.getByTestId('current-week').textContent).toBe('1');

    act(() => updateStartup(plan.id, { startDate: daysAgo(16) })); // 第 3 周
    expect(screen.getByTestId('current-week').textContent).toBe('3');
    expect(screen.getByTestId('week-1').textContent).toContain('已锁定');
    expect(screen.getByTestId('week-2').textContent).toContain('已锁定');
    expect(screen.getByTestId('week-3').textContent).toContain('本周');
  });
});
