/**
 * 开缸日程（前 8 周：开缸 → 稳定期）。
 *
 * 设计约定（见 docs/ARCHITECTURE.md）：
 * - 本模块全部为纯函数，页面不写业务规则；经验性结论（日程节奏/合理范围）
 *   统一带 `estimated: true` 与说明，实测数据优先。
 * - 日程节奏由四个输入决定：有效水量、水草生长速度（快生/慢生）、
 *   是否水草泥、密植/裸缸（由种植密度推导）。
 * - 周表按「当前参数」生成；已经过去的周由调用方冻结快照，
 *   参数变更只重排当周及以后（materializeSchedule）。
 */
import type { Fish, Plan } from './types';
import { effectiveVolumeL } from './volume';
import { co2BubblesPerSec } from './water';

export const SCHEDULE_WEEKS = 8;

export type TankStyle = 'dense-planted' | 'sparse-planted' | 'bare';
export type PlantPace = 'fast' | 'slow';

/** 日程生成输入（由方案数据推导，也可在测试中手工构造） */
export type ScheduleParams = {
  effectiveL: number;
  plantQty: number;
  /** 快生/慢生：多数快生草 → fast，多数慢生草 → slow */
  pace: PlantPace;
  /** 是否水草泥（soil/ada），砂/砾石为惰性底床 */
  soil: boolean;
  style: TankStyle;
  /** 已选鱼种 pH 耐受区间（用于从下鱼周起收紧合理 pH 范围） */
  fishPhRanges: [number, number][];
  targetCo2Ppm: number;
};

export type MetricRange = {
  /** 合理下限（含）；null 表示不设下限 */
  min: number | null;
  /** 合理上限（含）；null 表示不设上限 */
  max: number | null;
  /** 范围说明（为什么是这个范围） */
  note: string;
};

export type TaskGate =
  | { kind: 'ammonia'; max: number; label: string }
  | { kind: 'ph'; min: number; max: number; label: string };

export type ScheduleTask = {
  /** 周内稳定 id（不含周号），用于勾选持久化 */
  id: string;
  title: string;
  reason: string;
  expect: string;
  /** 前置条件（如「氨氮连续两次 ≤ 0.25」），不满足时给出提醒 */
  gate?: TaskGate;
};

export type ScheduleWeek = {
  index: number; // 0 起
  title: string;
  waterChange: {
    pct: number;
    timesPerWeek: number;
    liters: number;
    reason: string;
    expect: string;
    estimated: true;
  };
  light: {
    hoursPerDay: number;
    reason: string;
    expect: string;
    estimated: true;
  };
  /** 草缸每周 CO₂ 任务；裸缸为 null */
  co2: {
    title: string;
    reason: string;
    expect: string;
    estimated: true;
  } | null;
  /** 本周里程碑（下鱼/放虾螺等），可无 */
  tasks: ScheduleTask[];
  ranges: {
    ph: MetricRange;
    ammonia: MetricRange;
  };
};

export type Schedule = {
  weeks: ScheduleWeek[];
  style: TankStyle;
  pace: PlantPace;
  soil: boolean;
  effectiveL: number;
  plantQty: number;
  estimated: true;
  note: string;
};

// ---- 经验阈值（集中可配）----------------------------------------------------

/** 密植/疏植分界：株 / 有效水量(L)，与 water.ts 换水分档同源 */
export const DENSE_PLANTS_PER_L = 0.5;
/** 小缸分界（L）：小缸水质震荡快，换水要少量多次 */
export const SMALL_TANK_L = 40;
/** 大缸分界（L）：水体大、缓冲强，换水下限可略低 */
export const LARGE_TANK_L = 150;

/** 风格中文标签 */
export const STYLE_LABEL: Record<TankStyle, string> = {
  'dense-planted': '密植草缸',
  'sparse-planted': '疏植草缸',
  'bare': '裸缸（无/极少水草）',
};

// ---- 参数推导 --------------------------------------------------------------

/**
 * 由方案推导日程输入。
 * 快生/慢生：水草按株数计票，快生（fast）过半 → fast，否则 slow；
 * 密植/裸缸：有效水量每升 ≥ DENSE_PLANTS_PER_L 株 → 密植；
 * 无植物 → 裸缸；其余 → 疏植。
 */
export function deriveScheduleParams(plan: Plan, fishMap: Map<string, Fish>): ScheduleParams {
  const effectiveL = effectiveVolumeL(plan.tank, plan.substrate, plan.items);
  const plantItems = plan.items.filter((i) => i.kind === 'plant');
  const plantQty = plantItems.reduce((s, i) => s + (i.qty ?? 1), 0);

  const fastVotes = plantItems
    .filter((i) => i.growth === 'fast')
    .reduce((s, i) => s + (i.qty ?? 1), 0);
  const pace: PlantPace = plantQty > 0 && fastVotes * 2 > plantQty ? 'fast' : 'slow';
  const soil = plan.substrate.kind === 'soil' || plan.substrate.kind === 'ada';

  let style: TankStyle;
  if (plantQty === 0) style = 'bare';
  else if (effectiveL > 0 && plantQty / effectiveL >= DENSE_PLANTS_PER_L) style = 'dense-planted';
  else style = 'sparse-planted';

  const fishPhRanges = plan.fishes
    .map((f) => fishMap.get(f.fishId)?.phRange)
    .filter((r): r is [number, number] => Array.isArray(r) && r.length === 2);

  return {
    effectiveL,
    plantQty,
    pace,
    soil,
    style,
    fishPhRanges,
    targetCo2Ppm: plan.water.targetCo2Ppm,
  };
}

/** 参数签名：签名相同则生成的周表相同（用于判断未来周是否需重排） */
export function scheduleSignature(p: ScheduleParams): string {
  return [
    p.style,
    p.pace,
    p.soil ? 'soil' : 'inert',
    Math.round(p.effectiveL),
    p.plantQty,
    p.targetCo2Ppm,
    p.fishPhRanges
      .map((r) => `${r[0]}-${r[1]}`)
      .sort()
      .join(','),
  ].join('|');
}

// ---- 光照日程（小时/天）----------------------------------------------------

/** 每日光照时长爬升表（小时）：裸缸只有观赏照明，草缸按风格/快慢爬升 */
export function lightHoursTable(style: TankStyle, pace: PlantPace): number[] {
  if (style === 'bare') return [2, 2, 3, 4, 4, 5, 6, 6];
  if (style === 'dense-planted') {
    return pace === 'fast' ? [6, 7, 8, 8, 9, 9, 10, 10] : [5, 6, 7, 8, 8, 9, 9, 10];
  }
  // 疏植：空位多，开长灯等于给藻光照，必须更慢地爬
  return pace === 'fast' ? [4, 5, 6, 7, 8, 8, 8, 8] : [3, 4, 5, 6, 6, 7, 8, 8];
}

function lightReason(style: TankStyle, hours: number): string {
  if (style === 'bare') return '无植物不抢养分，开灯只会催藻，仅保留观赏照明';
  return hours >= 8
    ? '水草已成活、对氮磷的吸收跟得上，光照可维持在成景时长'
    : '新草未扎根、吸肥能力弱，强光长时间=给藻供能，时长逐周爬升';
}

const LIGHT_EXPECT: Record<TankStyle, string> = {
  'dense-planted': '草叶挺直、有追光新芽（正常生长）；缸壁无黄褐色膜、无绿水',
  'sparse-planted': '空地处出现褐/绿斑即提示光照跑在水草前面，停止加时并擦缸',
  'bare': '缸壁有轻微褐膜属正常；水变绿说明开灯过长或营养盐过剩',
};

// ---- 换水日程 --------------------------------------------------------------

type WcBase = { pct: number; timesPerWeek: number; reason: string };

function wcBase(style: TankStyle, soil: boolean, pace: PlantPace, w: number): WcBase {
  // w: 周序号 0~7
  if (style === 'dense-planted') {
    if (soil) {
      // 新泥头两周持续释放腐殖酸/氨，密植 + 少量多次抽走释放物
      if (w <= 1) return { pct: 30, timesPerWeek: 2, reason: '新水草泥持续释放腐殖酸与少量氨，每周两次各 30% 抽走释放物，密植草耗肥快、少抽勤换最稳' };
      if (w === 2) return { pct: 30, timesPerWeek: 1, reason: '泥的释放开始收敛，恢复每周一次，稳定供应微量元素' };
      if (w <= 4) return { pct: 35, timesPerWeek: 1, reason: '下生物前后换水略加量，稀释残饵与代谢物，密植常规维护量 30~40%' };
      return { pct: 30, timesPerWeek: 1, reason: '进入稳定维护，密植缸每周 30% 即可保持水质' };
    }
    // 密植 + 惰性底床
    if (w === 0) return { pct: 40, timesPerWeek: 1, reason: '惰性底床无泥释放，但新水/新材料有杂质，首周一次 40% 换新' };
    if (w <= 2) return { pct: 40, timesPerWeek: 1, reason: '密植草吸收快，每周 40% 补水补肥、限制藻类营养盐累积' };
    if (w <= 4) return { pct: 40, timesPerWeek: 1, reason: '下生物前后保持 40% 换水稀释代谢物' };
    return { pct: 35, timesPerWeek: 1, reason: '稳定期密植常规维护 30~40%' };
  }

  if (style === 'sparse-planted') {
    if (soil) {
      if (w === 0) return { pct: 40, timesPerWeek: 1, reason: '新泥释放 + 草少吸收不完，每周 40% 压低氨与腐殖酸浓度' };
      if (w === 1) return { pct: 50, timesPerWeek: 1, reason: '疏植吸肥不足，加量到 50%，替水草分担营养盐压力以防爆藻' };
      if (w <= 4) return { pct: 40, timesPerWeek: 1, reason: '下生物前后维持 40%，稀释残饵代谢物' };
      return { pct: 40, timesPerWeek: 1, reason: '稳定期疏植缸仍建议每周 40%（经验范围 30~50%，密植偏低、疏植偏高）' };
    }
    if (w <= 2) return { pct: 50, timesPerWeek: 1, reason: '惰性底床 + 疏植，营养盐无处消耗，每周 50% 大换水是防藻主力' };
    if (w <= 4) return { pct: 40, timesPerWeek: 1, reason: '下生物前后保持勤换水以稀释代谢物' };
    return { pct: 40, timesPerWeek: 1, reason: '稳定期疏植缸维持每周 40~50%' };
  }

  // 裸缸：纯靠换水养菌/控氨，频率最高
  if (w <= 1) return { pct: 30, timesPerWeek: 2, reason: '无植物吸氨，初期少量多次避免水质震荡，帮助硝化菌着床' };
  if (w <= 3) return { pct: 30, timesPerWeek: 2, reason: '氨/亚硝酸盐正处于冲高回落期，每周两次稳定稀释' };
  if (w <= 4) return { pct: 40, timesPerWeek: 1, reason: '毒素回落后改为每周一次、加量，准备下鱼' };
  if (w === 5) return { pct: 30, timesPerWeek: 1, reason: '下首批鱼当周减半换水，避免新鱼同时面对新水与新环境双重压力' };
  return { pct: 40, timesPerWeek: 1, reason: '有鱼负荷后裸缸全靠换水，稳定期每周 40~50%' };
}

/** 水量修正：小缸单次换水更保守（震荡快），大缸缓冲强可略低 */
export function adjustWcForVolume(base: WcBase, effectiveL: number): WcBase {
  if (effectiveL > 0 && effectiveL < SMALL_TANK_L) {
    const pct = Math.min(base.pct, 25);
    const times = Math.max(base.timesPerWeek, base.pct > 25 ? 2 : 1);
    return { ...base, pct, timesPerWeek: times, reason: `${base.reason}；${effectiveL.toFixed(0)}L 属小缸（<${SMALL_TANK_L}L），单次≤25% 防水质震荡，量不够就分多次` };
  }
  if (effectiveL >= LARGE_TANK_L && base.pct >= 40) {
    return { ...base, pct: base.pct - 5, reason: `${base.reason}；${effectiveL.toFixed(0)}L 大缸缓冲强（≥${LARGE_TANK_L}L），单次可低 5%` };
  }
  return base;
}

// ---- CO₂ 日程 --------------------------------------------------------------

function co2Task(
  params: ScheduleParams,
  w: number,
): ScheduleWeek['co2'] {
  if (params.style === 'bare') return null;
  const half = params.pace === 'fast' ? 1 : 2; // 快生草一周后半量，慢生草第 3 周才半量
  const full = params.pace === 'fast' ? 2 : 3; // 快生草第 3 周全量，慢生草第 4 周全量
  const bubbles = co2BubblesPerSec(params.targetCo2Ppm, params.effectiveL);

  if (w < half) {
    return {
      title: '不开 CO₂（仅过滤曝气）',
      reason: '新草在转水适应、气孔未张开，此时加 CO₂ 利用率低还可能跌酸伤鱼；裸缸不需要',
      expect: '水面有正常水波溶氧即可，草叶无缩头溶叶',
      estimated: true,
    };
  }
  if (w < full) {
    return {
      title: `半量 CO₂：约 ${(bubbles.value / 2).toFixed(1)} 泡/秒（灯亮 1 小时后开）`,
      reason: `${params.pace === 'fast' ? '快生草约 1 周' : '慢生草约 2 周'}开始发新根，可以给半量碳帮助生长；随灯开停避免夜间跌氧`,
      expect: '新叶展开更快、无浮头；CO₂ 监测液颜色开始变化',
      estimated: true,
    };
  }
  return {
    title: `全量 CO₂：约 ${bubbles.value.toFixed(1)} 泡/秒（随灯开关）`,
    reason: '水草进入旺长期需要足量碳源，与光照时长匹配，光强碳不足必然爆藻',
    expect: '草叶冒泡（光合作用旺盛）、监测液维持目标色；鱼虾无浮头',
    estimated: true,
  };
}

// ---- 合理范围：pH / 氨氮 ----------------------------------------------------

function phRangeFor(style: TankStyle, soil: boolean, w: number, fish: [number, number][]): MetricRange {
  let min = soil ? 5.8 : 6.5;
  let max = soil ? 7.2 : 7.8;
  let note = soil
    ? '水草泥降酸软水，5.8~7.2 为其常见缓冲区间'
    : '惰性底床（砂/砾石）pH 多接近当地自来水，6.5~7.8 为常见淡水区间';

  // 下鱼周起与已选鱼种耐受区间求交，保证下的水鱼能活
  const fishWeek = style === 'dense-planted' ? 3 : style === 'sparse-planted' ? 4 : 5;
  if (w >= fishWeek && fish.length > 0) {
    const lo = Math.max(...fish.map((r) => r[0]));
    const hi = Math.min(...fish.map((r) => r[1]));
    if (hi >= lo) {
      min = Math.max(min, round1(lo));
      max = Math.min(max, round1(hi));
      note = `与已选鱼种耐受（${round1(lo)}~${round1(hi)}）取交集后的安全区间；新鱼入缸 pH 波动应 <0.3`;
    } else {
      note = '已选鱼种之间 pH 耐受无交集——请回「生物兼容」页核对；此周先按底床区间参考';
    }
  }
  return { min, max, note };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * 总氨氮 NH3-N 合理上限（mg/L，经验值）。
 * 裸缸养水期允许冲高（硝化系统建立中），草缸始终要求很低；
 * 下鱼/虾后阈值进一步收紧。
 */
export function ammoniaMaxFor(style: TankStyle, w: number): number {
  if (style === 'dense-planted') {
    // 密植草 + 泥能直接吸收铵：w3 放螺、w4 下鱼虾
    return w <= 1 ? 0.5 : 0.25;
  }
  if (style === 'sparse-planted') {
    return w <= 2 ? 1.0 : 0.25; // w4 放螺/下鱼
  }
  // 裸缸养水：允许冲高后回落；w5 下首批鱼
  if (w <= 1) return 2.0;
  if (w <= 3) return 1.0;
  return 0.25;
}

function ammoniaRangeFor(style: TankStyle, w: number): MetricRange {
  const max = ammoniaMaxFor(style, w);
  if (style === 'bare' && w <= 3) {
    return {
      min: null,
      max,
      note: `裸缸无植物吸氨，养水期氨呈「先冲高（可到 1~2）后回落」曲线，本周高于 ${max} 说明硝化系统尚未建立，继续养水不要下鱼`,
    };
  }
  if (style === 'bare') {
    return { min: null, max, note: `已/将下鱼，总氨氮必须 ≤ ${max} mg/L，超量即换水停食` };
  }
  if (style === 'dense-planted') {
    return {
      min: null,
      max,
      note: w <= 1
        ? '水草与新泥可吸收/释放少量氨，≤0.5 为可接受起点；超标多为新泥大量翻浆或密度不够'
        : '水草进入吸收状态，氨应接近 0；超标说明翻泥/过喂或过滤未成熟，先别下生物',
    };
  }
  return {
    min: null,
    max,
    note: w <= 2
      ? '疏植草吸收有限，养水前期 ≤1.0 尚可接受但应逐周下降'
      : '下生物前氨必须接近 0；超标继续养水、加大换水',
  };
}

// ---- 里程碑文案（每种风格 8 周）--------------------------------------------

type Milestone = { tasks: ScheduleTask[] };

function t(id: string, title: string, reason: string, expect: string, gate?: TaskGate): ScheduleTask {
  return { id, title, reason, expect, gate };
}

const GATE_AMMONIA_DENSE: TaskGate = { kind: 'ammonia', max: 0.25, label: '氨氮连续两次 ≤0.25' };
const GATE_AMMONIA_BARE_FISH: TaskGate = { kind: 'ammonia', max: 0.25, label: '氨氮与亚硝酸盐连续两次接近 0' };

function denseMilestones(w: number): Milestone {
  switch (w) {
    case 0:
      return {
        tasks: [
          t('setup', '种草后立刻密植填满、开过滤 24h', '草越多越抢在藻前面占据养分；过滤器从第一天就开始养菌', '水先白浊半天到一天后转清；草叶有少量透明溶叶属转水正常'),
          t('no-fish', '不放任何鱼虾', '硝化系统为零，氨无处转化，下鱼必伤', '还没有鱼便，水质清亮、无明显腥味'),
        ],
      };
    case 1:
      return {
        tasks: [
          t('root', '观察扎根、剪掉融化叶', '溶叶会释放有机物催藻，及时剪除；新根白而短是成活信号', '拔轻拉有阻力、长出白色新根；新叶比老叶小但颜色正常'),
        ],
      };
    case 2:
      return {
        tasks: [
          t('snail', '可先放 1~2 只工具螺（蜜蜂角螺/斑马螺）', '螺对氨极敏感，是最便宜的「水质探针」；此时密植缸氨已近 0',
            '螺积极爬缸壁、腹足紧吸；若缩角不动或上浮，说明氨仍偏高，捞回暂养', GATE_AMMONIA_DENSE),
        ],
      };
    case 3:
      return {
        tasks: [
          t('shrimp', '放 5~10 只黑壳虾（先于鱼）', '虾对氨/药物比鱼敏感，先过虾这一关；虾还会替后面的鱼吃掉杂藻与残饵',
            '虾四处觅食、蜕壳正常；死虾多于 1~2 只说明水还没好，暂缓下鱼', GATE_AMMONIA_DENSE),
          t('first-fish', '下第一批鱼：2~3 条闯缸鱼（灯鱼/鼠鱼等耐操小型鱼）', '密植缸第 4 周硝化系统初成，先用少量鱼验证，生物负载要一点点加',
            '鱼四处游动不扎堆、呼吸平稳、次日正常开口；夹尾/浮头立即测氨并换水 1/3', GATE_AMMONIA_DENSE),
          t('feed', '次日起极少量喂食（2 分钟吃完）', '硝化菌按负载增长，喂多了氨瞬间超过刚建立的菌群处理能力', '残饵在 2 分钟内被抢光，底床无积存'),
        ],
      };
    case 4:
      return {
        tasks: [
          t('second-fish', '第一批稳定 → 补到计划鱼量约 60%', '隔一周加一批，让菌群跟随负载扩编，切忌一次下满', '老鱼追新鱼但无咬伤；氨、亚硝酸盐测不出'),
        ],
      };
    case 5:
      return {
        tasks: [
          t('rest-fish', '下剩余鱼群与娇贵品种（短鲷等）', '系统已稳定承载，娇贵鱼对氨和波动零容忍，必须最后下', '新鱼 1~2 天内开口、体色展开不发黑'),
        ],
      };
    case 6:
      return {
        tasks: [
          t('shrimp-rest', '补足工具虾/观赏虾（樱花虾等）', '鱼群稳定后虾的食物网与躲避环境才可靠', '虾蜕壳后存活、白天也敢出来'),
        ],
      };
    case 7:
    default:
      return {
        tasks: [
          t('graduate', '满月验收：连测 2 周氨/亚硝酸盐≈0、鱼虾无死亡 → 转常规维护', '连续两周无波动才叫系统成熟，单次合格不算', '水质透亮无异味、草持续生长、喂食后氨无抬头'),
        ],
      };
  }
}

function sparseMilestones(w: number): Milestone {
  switch (w) {
    case 0:
      return {
        tasks: [
          t('setup', '种草、开过滤 24h', '水草少更要让过滤尽早养菌补吸收的不足', '水短暂白浊后转清'),
          t('no-fish', '不放任何鱼虾', '硝化系统为零', '水质清亮、无明显腥味，测水无氨'),
        ],
      };
    case 1:
      return {
        tasks: [
          t('algae-watch', '重点盯藻类：缸壁一有褐膜就擦、减灯', '疏植空位多，藻抢到的光和肥比草多，前一个月防藻是第一要务', '草开始出新根；斑藻零星出现但不扩大'),
        ],
      };
    case 2:
      return {
        tasks: [
          t('root', '确认草成活并补植稀疏处', '空位不补草就会被藻永久占领', '新叶正常、白根扎入底床'),
        ],
      };
    case 3:
      return {
        tasks: [
          t('wait', '继续养水，暂不放生物', '疏植缸氨吸收弱于密植，比密植晚一周下生物更稳', '测得氨已较开缸时明显下降'),
        ],
      };
    case 4:
      return {
        tasks: [
          t('snail', '放 1~2 只工具螺试水', '螺是氨探针，稀疏草缸第 5 周才相对安全',
            '螺积极爬壁觅食', GATE_AMMONIA_DENSE),
          t('first-fish', '下第一批鱼：2~3 条闯缸小鱼', '先用少量鱼验证硝化系统，生物负载逐周增加',
            '鱼正常游动开口，次日测氨无抬头', { kind: 'ammonia', max: 0.25, label: '氨氮连续两次 ≤0.25' }),
        ],
      };
    case 5:
      return {
        tasks: [
          t('shrimp', '放 5~10 只黑壳虾', '虾除藻兼做水质探针；下虾前确认螺鱼都稳定',
            '虾正常蜕壳、啃藻积极', GATE_AMMONIA_DENSE),
          t('feed', '喂食保持 2 分钟吃完', '草少吸收弱，残饵是主要氨来源', '饲料 2 分钟内被抢光，底床无残饵积存'),
        ],
      };
    case 6:
      return {
        tasks: [
          t('rest-fish', '分批补到计划鱼量（每批间隔 ≥1 周）', '负载分批增加让菌群跟得上', '加鱼后氨仍测不出'),
        ],
      };
    case 7:
    default:
      return {
        tasks: [
          t('graduate', '满月验收：连测 2 周氨/亚硝酸盐≈0 → 转常规维护', '连续两周合格才算成熟', '无爆藻、鱼虾稳定、草开始封景'),
        ],
      };
  }
}

function bareMilestones(w: number): Milestone {
  switch (w) {
    case 0:
      return {
        tasks: [
          t('setup', '开过滤 24h、可放一小块造景石/闯缸饵料源', '裸缸没有植物吸收，全程靠换水与硝化菌，滤材/石头是菌的居所', '水微浑后变清；石头表面滑滑的是菌膜（好事）'),
          t('no-fish', '绝对不放鱼', '氨无处转化，下鱼等于毒鱼', '测氨开始有读数（养水启动的正常现象）'),
        ],
      };
    case 1:
      return {
        tasks: [
          t('ammonia-peak', '测氨：出现峰值不慌，继续少量多次换水', '裸缸氨会先冲高，这是养菌必需的「饲料曲线」', '氨读数先升；水可能微白（细菌繁殖）'),
        ],
      };
    case 2:
      return {
        tasks: [
          t('nitrite', '加测亚硝酸盐：应开始出现', '氨被第一类菌转成亚硝酸盐，说明养水进入第二阶段', '亚硝酸盐有读数、氨开始下降'),
        ],
      };
    case 3:
      return {
        tasks: [
          t('nitrite-fall', '等亚硝酸盐回落到接近 0', '第二类硝化菌成熟约需 2~3 周，急不得', '亚硝酸盐逐次下降、水透亮无味'),
        ],
      };
    case 4:
      return {
        tasks: [
          t('wait', '氨与亚硝酸盐双接近 0 后再等 3~5 天', '给菌群留余量，避免一下鱼负载就崩', '连续两次检测双双接近 0'),
        ],
      };
    case 5:
      return {
        tasks: [
          t('first-fish', '下第一批鱼：2~3 条最皮实的鱼（斑马鱼/草金等）', '裸缸养水约 6 周才稳；本周换水减半减少新鱼应激',
            '鱼游姿平稳、开口积极；喂食后氨无抬头', GATE_AMMONIA_BARE_FISH),
        ],
      };
    case 6:
      return {
        tasks: [
          t('rest-fish', '第一批稳定 → 分批补鱼（间隔 ≥1 周）', '菌群按实际负载扩编，一次加满易氨崩', '新鱼入群无追咬，氨/亚硝酸盐持续为 0'),
          t('snail', '可放工具螺', '裸缸藻少螺易挨饿，少量即可；此时水质已安全',
            '螺沿缸壁觅食', GATE_AMMONIA_DENSE),
        ],
      };
    case 7:
    default:
      return {
        tasks: [
          t('shrimp-note', '观赏虾不建议裸缸：如要放，必须先增躲避与水草（莫斯/水榕）', '虾需要微生物膜与躲避，裸缸无覆盖存活率低', '若已加躲避，虾白天敢出来、蜕壳存活'),
          t('graduate', '满月验收：连测 2 周氨/亚硝酸盐≈0、鱼无死亡 → 转常规维护（每周 40~50% 换水）', '连续合格才叫成熟；裸缸对换水的依赖长期高于草缸', '水透亮、鱼抢食、喂食后毒素无抬头'),
        ],
      };
  }
}

const MILESTONES: Record<TankStyle, (w: number) => Milestone> = {
  'dense-planted': denseMilestones,
  'sparse-planted': sparseMilestones,
  'bare': bareMilestones,
};

const WEEK_TITLES = ['开缸周', '第2周', '第3周', '第4周', '第5周', '第6周', '第7周', '满月周'];

// ---- 周表生成 --------------------------------------------------------------

export function buildSchedule(params: ScheduleParams): Schedule {
  const lightTable = lightHoursTable(params.style, params.pace);
  const weeks: ScheduleWeek[] = Array.from({ length: SCHEDULE_WEEKS }, (_, w) => {
    const wcB = adjustWcForVolume(wcBase(params.style, params.soil, params.pace, w), params.effectiveL);
    const liters = (wcB.pct / 100) * params.effectiveL;
    return {
      index: w,
      title: WEEK_TITLES[w],
      waterChange: {
        pct: wcB.pct,
        timesPerWeek: wcB.timesPerWeek,
        liters,
        reason: wcB.reason,
        expect: '换水后水更透亮、虾鱼活跃；若缸壁/底床明显变干净说明换水节奏合适',
        estimated: true,
      },
      light: {
        hoursPerDay: lightTable[w],
        reason: lightReason(params.style, lightTable[w]),
        expect: LIGHT_EXPECT[params.style],
        estimated: true,
      },
      co2: co2Task(params, w),
      tasks: MILESTONES[params.style](w).tasks,
      ranges: {
        ph: phRangeFor(params.style, params.soil, w, params.fishPhRanges),
        ammonia: ammoniaRangeFor(params.style, w),
      },
    };
  });

  return {
    weeks,
    style: params.style,
    pace: params.pace,
    soil: params.soil,
    effectiveL: params.effectiveL,
    plantQty: params.plantQty,
    estimated: true,
    note: '日程节奏为经验估算：换水/光照/CO₂/下生物的时点以实测氨氮、亚硝酸盐与生物状态为准，宁可晚一周下生物，不要抢跑。',
  };
}

// ---- 实测值校验 ------------------------------------------------------------

export type ReadingAlert = {
  metric: 'ph' | 'ammonia';
  level: 'warn' | 'info';
  message: string;
};

/** 校验某周某项实测值是否超出该周合理范围；返回提醒列表（无问题为空） */
export function evaluateReading(
  week: ScheduleWeek,
  metric: 'ph' | 'ammonia',
  value: number,
): ReadingAlert[] {
  if (!Number.isFinite(value)) return [];
  const alerts: ReadingAlert[] = [];
  const r = week.ranges[metric];
  const label = metric === 'ph' ? 'pH' : '氨氮 NH3-N';
  const unit = metric === 'ph' ? '' : ' mg/L';

  if ((r.min !== null && value < r.min) || (r.max !== null && value > r.max)) {
    const range = `${r.min ?? '—'}~${r.max ?? '—'}`;
    alerts.push({
      metric,
      level: 'warn',
      message: `本周${label}合理范围 ${range}${unit}，实测 ${value}${unit} 已超出：${r.note}`,
    });
  }

  if (metric === 'ammonia') {
    const fishTask = week.tasks.find((x) => x.id === 'first-fish');
    if (fishTask && value > (fishTask.gate?.kind === 'ammonia' ? fishTask.gate.max : 0.25)) {
      alerts.push({
        metric,
        level: 'warn',
        message: '本周计划下首批鱼：前置条件「' + (fishTask.gate?.label ?? '氨氮接近 0') + '」未满足，先别下鱼。',
      });
    }
  }

  // 高 pH 下非离子氨（NH3）毒性放大，给出科普提醒
  if (metric === 'ph' && value >= 7.5 && (week.ranges.ammonia.max ?? 0) > 0) {
    alerts.push({
      metric: 'ph',
      level: 'info',
      message: 'pH ≥ 7.5 时氨中毒性更强的非离子氨占比上升，请结合氨氮读数综合判断。',
    });
  }
  return alerts;
}

/** 里程碑前置条件在当前实测下是否满足（用于勾选时的提醒） */
export function gateBlocked(task: ScheduleTask, reading?: { ph?: number; ammonia?: number }): string | null {
  if (!task.gate) return null;
  const g = task.gate;
  if (!reading) return null; // 尚未测量：是否提醒由 UI 按「当周/历史」决定
  if (g.kind === 'ammonia') {
    if (reading.ammonia === undefined) return null;
    return reading.ammonia > g.max ? `前置条件「${g.label}」未满足（当前 ${reading.ammonia} mg/L）` : null;
  }
  if (reading.ph === undefined) return null;
  return reading.ph < g.min || reading.ph > g.max
    ? `前置条件「${g.label}」未满足（当前 pH ${reading.ph}）`
    : null;
}

// ---- 日期与周次 ------------------------------------------------------------

/** 解析 yyyy-mm-dd 为当地零点 Date */
export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 第 n 周（0 起）的起止日期 */
export function weekDateRange(startedOn: string, index: number): { start: Date; end: Date } {
  const start = parseDate(startedOn);
  start.setDate(start.getDate() + index * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { start, end };
}

/**
 * 当前处于第几周（0 起）：按当地日期整除 7。
 * 开缸日当天 = 第 0 周；超过 8 周返回 SCHEDULE_WEEKS-1（所有周均为历史）。
 */
export function currentWeekIndex(startedOn: string, now: Date = new Date()): number {
  const start = parseDate(startedOn);
  const days = Math.floor((stripTime(now).getTime() - stripTime(start).getTime()) / 86400000);
  if (days < 0) return 0;
  return Math.min(Math.floor(days / 7), SCHEDULE_WEEKS - 1);
}

function stripTime(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// ---- 历史周冻结（改参数不重排已过去的周）-----------------------------------

export type MaterializedWeek = {
  week: ScheduleWeek;
  frozen: boolean;
  /** 冻结时的参数签名；UI 可据此提示该周按什么参数生成 */
  signature?: string;
};

/**
 * 合并出实际展示的周表：
 * - index < currentWeekIndex：已过去 → 优先用冻结快照，没有则用当前参数生成
 *   （并视为新冻结，由调用方持久化）；
 * - index ≥ currentWeekIndex：当周及以后始终用当前参数重新生成。
 *
 * 纯函数：不写状态。冻结持久化由 state 层 syncFrozenWeeks 完成。
 */
export function materializeSchedule(
  schedule: Schedule,
  frozen: Record<number, { signature: string; week: ScheduleWeek }>,
  currentIndex: number,
): MaterializedWeek[] {
  return schedule.weeks.map((week) => {
    if (week.index < currentIndex && frozen[week.index]) {
      return { week: frozen[week.index].week, frozen: true, signature: frozen[week.index].signature };
    }
    return { week, frozen: week.index < currentIndex };
  });
}

/** 计算需要新冻结的历史周（参数变更只影响当周及以后，历史周第一次滑过即固化） */
export function weeksToFreeze(
  schedule: Schedule,
  signature: string,
  frozen: Record<number, { signature: string; week: ScheduleWeek }>,
  currentIndex: number,
  now: number,
): { index: number; entry: { signature: string; week: ScheduleWeek; frozenAt: number } }[] {
  const out: { index: number; entry: { signature: string; week: ScheduleWeek; frozenAt: number } }[] = [];
  for (let i = 0; i < currentIndex; i++) {
    if (!frozen[i]) out.push({ index: i, entry: { signature, week: schedule.weeks[i], frozenAt: now } });
  }
  return out;
}

// ---- 勾选进度 --------------------------------------------------------------

/** 全部任务 id（含每周换水/光照/CO₂ 固定项），与页面勾选 key 对齐 */
export const FIXED_TASK_IDS = {
  waterChange: 'water-change',
  light: 'light',
  co2: 'co2',
} as const;

export function allTaskKeys(week: ScheduleWeek): string[] {
  const keys: string[] = [FIXED_TASK_IDS.waterChange, FIXED_TASK_IDS.light];
  if (week.co2) keys.push(FIXED_TASK_IDS.co2);
  for (const task of week.tasks) keys.push(task.id);
  return keys;
}

export function taskDoneKey(weekIndex: number, taskId: string): string {
  return `${weekIndex}:${taskId}`;
}

export function scheduleProgress(
  weeks: ScheduleWeek[],
  done: Record<string, boolean>,
): { done: number; total: number; pct: number } {
  let d = 0;
  let total = 0;
  for (const week of weeks) {
    for (const key of allTaskKeys(week)) {
      total++;
      if (done[taskDoneKey(week.index, key)]) d++;
    }
  }
  return { done: d, total, pct: total === 0 ? 0 : Math.round((d / total) * 100) };
}
