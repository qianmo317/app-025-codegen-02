// 数据模型（与需求文档 §7 对齐）
export type Tank = {
  id: string;
  name: string;
  l: number; // 长 cm
  w: number; // 宽 cm
  h: number; // 高 cm
  glassMm: number; // 玻璃厚度 mm
  waterLevelMm: number; // 水面高度（自缸底起算，mm）
  openTop: boolean; // 是否开放缸
};

export type Substrate = {
  kind: 'sand' | 'gravel' | 'soil' | 'ada';
  densityKgPerL: number; // 密度 kg/L（可配）
  thicknessMm: number; // 基础厚度 mm
  slopeMm: number; // 坡度（前后落差 mm）
};

export type Item = {
  id: string;
  kind: 'hardscape' | 'plant';
  name: string;
  x: number; // 平面坐标 cm（左上原点）
  y: number; // cm
  scaleCm: number; // 实际尺寸 cm（最大维度）
  rotDeg: number;
  layer?: 'front' | 'mid' | 'back'; // 水草层次
  lightNeed?: 'low' | 'mid' | 'high';
  growth?: 'slow' | 'mid' | 'fast';
  qty?: number; // 水草株数
  displacement?: number; // 硬景观排水系数（0~1，可配）
  shape?: 'rock' | 'wood';
};

export type Fish = {
  id: string;
  name: string;
  adultCm: number;
  minTankL: number;
  tempRange: [number, number];
  ghRange: [number, number];
  phRange: [number, number];
  temperament: 'peaceful' | 'semi' | 'aggressive';
  plantNip: boolean;
  schooling: boolean;
  minSchool?: number;
  singleMale?: boolean;
};

export type WaterConfig = {
  tapGh: number;
  tapKh: number;
  targetGh: number;
  targetCo2Ppm: number;
  roomTempC: number;
  targetTempC: number;
};

// ---- 开缸日程（开缸 → 水质稳定 的按周计划）----

export type StepKind = 'water' | 'light' | 'co2' | 'fish' | 'shrimp' | 'maintain';

export type ScheduleStep = {
  /** 稳定 id：常规步骤 w{周}-{kind}；里程碑 milestone-{kind}（重排跨周移动时勾选状态不丢） */
  id: string;
  kind: StepKind;
  title: string; // 这一步做什么（含量）
  reason: string; // 理由
  observe: string; // 能观察到的现象
  milestone: boolean; // 一次性步骤（下鱼 / 放虾螺）
};

export type WeekPlan = {
  week: number; // 第几周（1 起）
  waterChangePct: number; // 每次换水 %
  waterChangeTimes: number; // 本周换水次数
  lightHours: number; // 每天光照小时（0 = 无需固定光照）
  co2: 'none' | 'start' | 'ramp' | 'full'; // CO₂ 阶段：不开 / 起步低量 / 加量 / 满量
  effectiveL: number; // 生成该周时的有效水量 L（换水升数折算依据，锁定后随快照冻结）
  co2Bps: number; // 生成该周时的目标泡/秒（经验估算，锁定后随快照冻结）
  steps: ScheduleStep[];
  phRange: [number, number]; // 本周 pH 合理范围（实测校验用）
  nh3Max: number; // 本周氨氮上限 mg/L（实测校验用）
};

/** 开缸日程的执行状态（挂在 Plan 上持久化） */
export type StartupState = {
  startDate: string; // 开缸日期 YYYY-MM-DD
  lockedWeeks: WeekPlan[]; // 已过去周的快照：中途改参数重排时不动这些周
  done: Record<string, boolean>; // stepId -> 已完成
  readings: Record<number, { ph?: number; nh3?: number }>; // 周 -> 当天实测（pH / 氨氮 mg/L）
};

export type Plan = {
  id: string;
  name: string;
  tank: Tank;
  substrate: Substrate;
  items: Item[];
  fishes: { fishId: string; count: number }[];
  water: WaterConfig;
  startup?: StartupState; // 开缸日程（首次进入日程页时初始化，旧数据可缺省）
  updatedAt: number;
};

export const EMPTY_WATER: WaterConfig = {
  tapGh: 12,
  tapKh: 6,
  targetGh: 8,
  targetCo2Ppm: 25,
  roomTempC: 24,
  targetTempC: 26,
};
