/**
 * 离线包三方对账（纯函数，不触碰数据库）：
 *
 *           基线 baseline（出发前主档案）
 *          /                            \\
 *   主档案现状 master              离线现状 snapshot
 *
 * - 仅离线单边改过：fast-forward / created-offline / deleted-offline → 直接应用
 * - 仅主档案单边改过：keep-master / deleted-master → 主档案不动
 * - 两边都改过：conflict，落待确认清单，不自动覆盖
 * - 测点实测值或限值被离线侧改动：判定按最新限值重算（rejudge），既有判定的检测人 / 创建时间保留
 * - 补录记录（基线不存在、离线新增）：重编新 id 写入，外键引用按映射沿用原关系
 *
 * 引用完整性在对账之前校验：缺少建筑物 / 测点等必需引用时返回错误，整包退回。
 */
import type { Building } from '$lib/types/building'
import type { Device } from '$lib/types/device'
import type { Point } from '$lib/types/point'
import type { Verdict } from '$lib/types/verdict'
import type { Rectify } from '$lib/types/rectify'
import {
  type ConflictReason,
  type ConflictResolution,
  type ImportConflict,
  type ImportOp,
  type ImportPlanStats,
  type OfflinePackageEnvelope,
  type OfflineTableKey,
  type TableBundle
} from '$lib/types/offline'

/** 新 id 前缀（补录记录重编编号，沿用此前缀与手工录入 id 风格一致） */
const NEW_ID_PREFIX: Record<OfflineTableKey, string> = {
  buildings: 'bld',
  devices: 'dev',
  points: 'pnt',
  verdicts: 'vrd',
  rectifies: 'rct'
}

/** 对账中间态：累积操作、冲突与 id 映射 */
export interface ReconcilePlan {
  errors: string[]
  ops: ImportOp[]
  conflicts: ImportConflict[]
  /** 表名 → 离线原 id → 主档案目标 id（补录记录重编，其余恒等映射） */
  idMaps: Record<OfflineTableKey, Map<string, string>>
  /** 需要重算判定的目标测点 id 集合 */
  rejudgePointIds: Set<string>
  /** 待重算判定所需的最新测点参数（按目标测点 id 索引） */
  rejudgeParams: Map<string, { measuredOhm: number; limitOhm: number; measureDate: string; inspector: string }>
}

export function emptyStats(): ImportPlanStats {
  return {
    apply: { buildings: 0, devices: 0, points: 0, verdicts: 0, rectifies: 0 },
    conflicts: 0,
    rejudges: 0,
    validationErrors: 0
  }
}

function emptyIdMaps(): Record<OfflineTableKey, Map<string, string>> {
  return {
    buildings: new Map(),
    devices: new Map(),
    points: new Map(),
    verdicts: new Map(),
    rectifies: new Map()
  }
}

/* ------------------------------ 基础工具 ------------------------------ */

/** 生成重编主键 */
function remappedId(table: OfflineTableKey): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${NEW_ID_PREFIX[table]}_${Date.now().toString(36)}${rand}${Math.floor(Math.random() * 1e4).toString(36)}`
}

function byId(rows: Array<Record<string, unknown>>): Map<string, Record<string, unknown>> {
  return new Map(rows.map((row) => [String(row.id), row]))
}

/**
 * 数据行实质内容是否一致：忽略主键与 updatedAt（updatedAt 每次编辑都会变，
 * 不能参与业务字段比对），按稳定 JSON 序列化比较。
 */
export function sameData(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const strip = (row: Record<string, unknown>): string => {
    const { id, updatedAt, ...rest } = row
    void id
    void updatedAt
    return JSON.stringify(rest, Object.keys(rest).sort())
  }
  return strip(a) === strip(b)
}

/** 对象展示摘要（冲突清单 / 导入报告中定位记录用） */
export function conflictLabel(table: OfflineTableKey, row: Record<string, unknown> | null): string {
  if (!row) return '（记录已缺失）'
  switch (table) {
    case 'buildings': {
      const b = row as unknown as Building
      return `建筑物「${b.name ?? '未命名'}」`
    }
    case 'devices': {
      const d = row as unknown as Device
      return `${d.type ?? '装置'} ${d.spec ?? ''}（${d.material ?? '材质未知'}）`
    }
    case 'points': {
      const p = row as unknown as Point
      return `测点 ${p.code ?? p.id}（${p.location ?? '位置未填'}）`
    }
    case 'verdicts': {
      const v = row as unknown as Verdict
      return `判定 ${v.pointId} → ${v.result}`
    }
    case 'rectifies': {
      const r = row as unknown as Rectify
      return `整改单「${r.problem ? r.problem.slice(0, 24) : r.id}」`
    }
  }
}

/* --------------------------- 引用完整性校验 --------------------------- */

/**
 * 整包引用校验（基线与现状两侧都要自洽）：
 * - devices.buildingId 必须指向存在的建筑物
 * - points.deviceId 必须指向存在的装置
 * - verdicts.pointId 必须指向存在的测点
 * - rectifies.buildingId 必须指向存在的建筑物；pointId 非空时必须指向存在的测点
 * 任一引用缺失：返回错误清单，调用方整包退回，不写任何业务数据。
 */
export function validatePackageReferences(pkg: OfflinePackageEnvelope): string[] {
  const errors: string[] = []
  for (const section of ['baseline', 'snapshot'] as const) {
    const tag = section === 'baseline' ? '基线' : '离线现状'
    const bundle = pkg[section]
    const buildingIds = new Set(bundle.buildings.map((row) => row.id))
    const deviceIds = new Set(bundle.devices.map((row) => row.id))
    const pointIds = new Set(bundle.points.map((row) => row.id))

    bundle.devices.forEach((device) => {
      if (!device.buildingId || !buildingIds.has(device.buildingId)) {
        errors.push(`${tag}：装置 ${device.id} 缺少建筑物引用（buildingId=${device.buildingId || '空'}）`)
      }
    })
    bundle.points.forEach((point) => {
      if (!point.deviceId || !deviceIds.has(point.deviceId)) {
        errors.push(`${tag}：测点 ${point.code || point.id} 缺少装置引用（deviceId=${point.deviceId || '空'}）`)
      }
    })
    bundle.verdicts.forEach((verdict) => {
      if (!verdict.pointId || !pointIds.has(verdict.pointId)) {
        errors.push(`${tag}：判定 ${verdict.id} 缺少测点引用（pointId=${verdict.pointId || '空'}）`)
      }
    })
    bundle.rectifies.forEach((rectify) => {
      if (!rectify.buildingId || !buildingIds.has(rectify.buildingId)) {
        errors.push(`${tag}：整改单 ${rectify.id} 缺少建筑物引用（buildingId=${rectify.buildingId || '空'}）`)
      }
      if (rectify.pointId && !pointIds.has(rectify.pointId)) {
        errors.push(`${tag}：整改单 ${rectify.id} 的测点引用不存在（pointId=${rectify.pointId}）`)
      }
    })
  }
  return errors
}

/* ------------------------------ 三方对账 ------------------------------ */

interface SideSets {
  baseline: Map<string, Record<string, unknown>>
  master: Map<string, Record<string, unknown>>
  offline: Map<string, Record<string, unknown>>
}

/**
 * 对单张表执行三方比对，向计划追加 ops / conflicts。
 * resolveRefs：把子表外键从离线原 id 翻译成主档案目标 id。
 */
function reconcileTable(
  plan: ReconcilePlan,
  table: OfflineTableKey,
  sides: SideSets,
  resolveRefs: (offlineRow: Record<string, unknown>, plan: ReconcilePlan) => Record<string, string | null>,
  isRejudgedPoint?: (sourcePointId: string) => boolean
): void {
  const allIds = new Set<string>([...sides.baseline.keys(), ...sides.master.keys(), ...sides.offline.keys()])
  const stage = table as ImportOp['stage']

  allIds.forEach((refId) => {
    const base = sides.baseline.get(refId) ?? null
    const master = sides.master.get(refId) ?? null
    const offline = sides.offline.get(refId) ?? null

    // 主档案单边新增：与本离线包无关
    if (!base && master && !offline) return
    // 基线有、两边都删：无需操作
    if (base && !master && !offline) return

    let targetId = refId
    let kind: ImportOp['kind']
    let reason: ConflictReason | null = null

    if (!base && !master && offline) {
      // 离线补录：重编新 id，避免与主档案已有 / 后增记录撞键
      kind = 'created-offline'
      targetId = remappedId(table)
      plan.idMaps[table].set(refId, targetId)
    } else if (!base && master && offline) {
      // 两边各自新增且 id 相撞：留待确认
      kind = 'conflict'
      reason = 'both-created'
      plan.idMaps[table].set(refId, refId)
    } else if (base && master && offline) {
      const offlineChanged = !sameData(base, offline)
      const masterChanged = !sameData(base, master)
      if (!offlineChanged && masterChanged) {
        kind = 'keep-master'
      } else if (offlineChanged && !masterChanged) {
        kind = 'fast-forward'
      } else if (offlineChanged && masterChanged) {
        kind = 'conflict'
        reason = 'both-edited'
      } else {
        kind = 'unchanged'
      }
    } else if (base && !master && offline) {
      // 主档案已删除，离线仍持有（无论是否编辑过）：不能自动删，也不能自动盖，留确认
      kind = 'conflict'
      reason = 'offline-edit-master-deleted'
    } else if (base && master && !offline) {
      const masterChanged = !sameData(base, master)
      if (masterChanged) {
        // 离线删除、主档案却编辑过：删除与编辑相撞，留确认
        kind = 'conflict'
        reason = 'offline-delete-master-edited'
      } else {
        kind = 'deleted-offline'
      }
    } else {
      // 兜底（理论不可达）：离线有、基线主档案都没有，按补录处理
      kind = 'created-offline'
      targetId = remappedId(table)
      plan.idMaps[table].set(refId, targetId)
    }

    if (kind === 'unchanged' || kind === 'keep-master') {
      return
    }

    // 该测点判定将由 rejudge 接管：离线判定不再参与普通三方比对，避免双重写入
    if (table === 'verdicts' && isRejudgedPoint) {
      const v = offline as unknown as Verdict | null
      if (v && isRejudgedPoint(v.pointId)) return
    }

    if (kind === 'conflict' && reason) {
      plan.conflicts.push({
        key: `${table}:${refId}`,
        table,
        refId,
        reason,
        label: conflictLabel(table, offline ?? master),
        offlineRow: offline ? { ...offline } : null,
        resolution: null,
        resolvedAt: null
      })
      return
    }

    const isDelete = kind === 'deleted-offline'
    let row: Record<string, unknown> | null = null
    if (!isDelete && offline) {
      row = { ...offline, id: targetId, ...resolveRefs(offline, plan) }
    }

    const op: ImportOp = {
      seq: plan.ops.length,
      stage,
      kind,
      table,
      targetId,
      sourceId: refId,
      row
    }

    // 测点补录 / 单边改值：登记判定重算参数（verdicts 阶段统一执行）
    if (table === 'points' && row && (kind === 'created-offline' || kind === 'fast-forward')) {
      const point = row as unknown as Point
      const resistanceChanged =
        kind === 'created-offline' ||
        !master ||
        (master as unknown as Point).measuredOhm !== point.measuredOhm ||
        (master as unknown as Point).limitOhm !== point.limitOhm
      if (resistanceChanged) {
        plan.rejudgePointIds.add(targetId)
        plan.rejudgeParams.set(targetId, {
          measuredOhm: point.measuredOhm,
          limitOhm: point.limitOhm,
          measureDate: point.measureDate,
          inspector: ''
        })
      }
    }

    plan.ops.push(op)
  })
}

/* ------------------------------ 外键翻译 ------------------------------ */

function refBuilding(offlineRow: Record<string, unknown>, plan: ReconcilePlan): string {
  const source = String(offlineRow.buildingId ?? '')
  return plan.idMaps.buildings.get(source) ?? source
}

function refDevice(offlineRow: Record<string, unknown>, plan: ReconcilePlan): string {
  const source = String(offlineRow.deviceId ?? '')
  return plan.idMaps.devices.get(source) ?? source
}

function refPoint(offlineRow: Record<string, unknown>, plan: ReconcilePlan): string | null {
  const source = offlineRow.pointId == null ? null : String(offlineRow.pointId)
  if (source === null) return null
  return plan.idMaps.points.get(source) ?? source
}

/* --------------------------- 判定重算操作 --------------------------- */

/** 在计划已落地的行里找装置（补录装置在 ops 中，主档案装置在 master 中） */
function findDevice(plan: ReconcilePlan, master: TableBundle, deviceId: string): Device | undefined {
  const inMaster = master.devices.find((d) => d.id === deviceId)
  if (inMaster) return inMaster
  const op = plan.ops.find((item) => item.table === 'devices' && item.targetId === deviceId && item.row)
  return op?.row as unknown as Device | undefined
}

function findBuilding(plan: ReconcilePlan, master: TableBundle, buildingId: string): Building | undefined {
  const inMaster = master.buildings.find((b) => b.id === buildingId)
  if (inMaster) return inMaster
  const op = plan.ops.find((item) => item.table === 'buildings' && item.targetId === buildingId && item.row)
  return op?.row as unknown as Building | undefined
}

/** 主表对账后，把需要重算判定测点上的离线判定检测人补给重算参数 */
function attachRejudgeInspector(plan: ReconcilePlan, snapshot: TableBundle): void {
  const verdictByPoint = new Map(snapshot.verdicts.map((v) => [v.pointId, v]))
  const sourceOfTarget = (targetPointId: string): string => {
    for (const [source, target] of plan.idMaps.points) {
      if (target === targetPointId) return source
    }
    return targetPointId
  }
  plan.rejudgePointIds.forEach((targetPointId) => {
    const verdict = verdictByPoint.get(sourceOfTarget(targetPointId))
    const params = plan.rejudgeParams.get(targetPointId)
    if (params && verdict) params.inspector = verdict.inspector
  })
}

/** 为全部待重算测点追加 verdicts 阶段操作（主档案已有判定则沿用其 id 与创建时间） */
function appendRejudgeOps(plan: ReconcilePlan, master: TableBundle): void {
  plan.rejudgePointIds.forEach((targetPointId) => {
    const pointOp = plan.ops.find((op) => op.table === 'points' && op.targetId === targetPointId && op.row)
    const point = pointOp?.row as unknown as Point | undefined
    if (!point) return
    const device = findDevice(plan, master, point.deviceId)
    const building = device ? findBuilding(plan, master, device.buildingId) : undefined
    const params = plan.rejudgeParams.get(targetPointId)
    if (!params) return

    const masterVerdict = master.verdicts.find((v) => v.pointId === targetPointId)
    const verdictTargetId = masterVerdict?.id ?? `vrd_${targetPointId}`

    plan.ops.push({
      seq: plan.ops.length,
      stage: 'verdicts',
      kind: 'fast-forward',
      table: 'verdicts',
      targetId: verdictTargetId,
      sourceId: masterVerdict?.id ?? `rejudge:${targetPointId}`,
      rejudge: {
        pointId: targetPointId,
        measuredOhm: params.measuredOhm,
        limitOhm: params.limitOhm,
        protectionClass: building?.protectionClass ?? '三类',
        deviceType: device?.type ?? '接地体',
        measureDate: params.measureDate,
        inspector: params.inspector
      }
    })
  })
}

/** 重新排序并重排顺序号（断点续传与分块事务依赖阶段顺序） */
function reorderOps(plan: ReconcilePlan): void {
  const stageOrder: Record<ImportOp['stage'], number> = {
    buildings: 0,
    devices: 1,
    points: 2,
    verdicts: 3,
    rectifies: 4
  }
  // 同阶段内：写入在前（保证父记录先建）、删除在后（保证子记录先删）
  const deleteLast = (op: ImportOp): number => (op.kind === 'deleted-offline' ? 1 : 0)
  plan.ops.sort((a, b) => stageOrder[a.stage] - stageOrder[b.stage] || deleteLast(a) - deleteLast(b) || a.seq - b.seq)
  plan.ops.forEach((op, index) => {
    op.seq = index
  })
}

/**
 * 执行完整对账：先整包引用校验，再按父表 → 子表顺序逐表三方比对，
 * 最后为改动过电阻的测点追加判定重算操作并汇总统计。
 */
export function buildReconcilePlan(pkg: OfflinePackageEnvelope, master: TableBundle): ReconcilePlan {
  const plan: ReconcilePlan = {
    errors: validatePackageReferences(pkg),
    ops: [],
    conflicts: [],
    idMaps: emptyIdMaps(),
    rejudgePointIds: new Set(),
    rejudgeParams: new Map()
  }
  if (plan.errors.length > 0) return plan

  const { baseline, snapshot: offline } = pkg
  const sidesOf = (key: OfflineTableKey): SideSets => ({
    baseline: byId(baseline[key] as unknown as Array<Record<string, unknown>>),
    master: byId(master[key] as unknown as Array<Record<string, unknown>>),
    offline: byId(offline[key] as unknown as Array<Record<string, unknown>>)
  })

  // 顺序不可调换：子表外键映射依赖父表结果
  reconcileTable(plan, 'buildings', sidesOf('buildings'), () => ({}))
  reconcileTable(plan, 'devices', sidesOf('devices'), (row, current) => ({ buildingId: refBuilding(row, current) }))
  reconcileTable(plan, 'points', sidesOf('points'), (row, current) => ({ deviceId: refDevice(row, current) }))

  // 判定表：落在「需重算测点」集合内的离线判定不参与普通三方比对（由 rejudge 统一接管）
  const isRejudgedSourcePoint = (sourcePointId: string): boolean => {
    const target = plan.idMaps.points.get(sourcePointId) ?? sourcePointId
    return plan.rejudgePointIds.has(target)
  }
  reconcileTable(
    plan,
    'verdicts',
    sidesOf('verdicts'),
    (row, current) => ({ pointId: refPoint(row, current) }),
    isRejudgedSourcePoint
  )

  attachRejudgeInspector(plan, offline)
  appendRejudgeOps(plan, master)

  reconcileTable(plan, 'rectifies', sidesOf('rectifies'), (row, current) => ({
    buildingId: refBuilding(row, current),
    pointId: refPoint(row, current)
  }))

  reorderOps(plan)
  return plan
}

/** 由计划生成统计 */
export function summarizePlan(plan: ReconcilePlan): ImportPlanStats {
  const stats = emptyStats()
  plan.ops.forEach((op) => {
    stats.apply[op.table] += 1
    if (op.rejudge) stats.rejudges += 1
  })
  stats.conflicts = plan.conflicts.length
  stats.validationErrors = plan.errors.length
  return stats
}

/* ------------------------------ 冲突解决 ------------------------------ */

/**
 * 应用人工冲突解决（新操作只追加到计划末尾，不重排 seq——执行器按 applied 标记去重）：
 * - take-offline：把该记录转成一条可执行操作（离线编辑撞主档案删除 → 作为新增重写入；
 *   离线删除撞主档案编辑 → 产生删除操作）。
 * - keep-master：不产生写入，仅在冲突上标记（主档案保持不动）。
 *
 * 若解决的是测点冲突且采用离线版本，同样按最新限值重算其判定；
 * 此时该测点原有的判定冲突随之自动按「保留主档案判定 → 再重算」结案，避免重复待确认。
 */
export function resolveConflict(
  plan: ReconcilePlan,
  conflictKey: string,
  resolution: ConflictResolution,
  context: { master: TableBundle }
): void {
  const conflict = plan.conflicts.find((item) => item.key === conflictKey)
  if (!conflict || conflict.resolution) return
  conflict.resolution = resolution
  conflict.resolvedAt = Date.now()

  if (resolution === 'keep-master') return

  const { table, refId, reason } = conflict
  const offlineRow = conflict.offlineRow ?? undefined

  // 离线删除 vs 主档案编辑：执行删除
  if (reason === 'offline-delete-master-edited') {
    plan.ops.push({
      seq: plan.ops.length,
      stage: table as ImportOp['stage'],
      kind: 'deleted-offline',
      table,
      targetId: refId,
      sourceId: refId,
      row: null,
      fromConflict: true
    })
    return
  }

  if (!offlineRow) return

  // 主档案已删除而离线在编辑，或两边新增撞 id：按新增重编 id 写回
  let targetId = refId
  if (reason === 'offline-edit-master-deleted' || reason === 'both-created') {
    targetId = remappedId(table)
    plan.idMaps[table].set(refId, targetId)
  }

  const refPatches: Record<string, string | null> = {}
  if (table === 'devices') refPatches.buildingId = refBuilding(offlineRow, plan)
  if (table === 'points') refPatches.deviceId = refDevice(offlineRow, plan)
  if (table === 'verdicts') refPatches.pointId = refPoint(offlineRow, plan)
  if (table === 'rectifies') {
    refPatches.buildingId = refBuilding(offlineRow, plan)
    refPatches.pointId = refPoint(offlineRow, plan)
  }

  plan.ops.push({
    seq: plan.ops.length,
    stage: table as ImportOp['stage'],
    kind: reason === 'both-edited' ? 'fast-forward' : 'created-offline',
    table,
    targetId,
    sourceId: refId,
    row: { ...offlineRow, id: targetId, ...refPatches },
    fromConflict: true
  })

  // 测点冲突采用离线版本：按最新限值重算判定，并顺手结案该测点的判定冲突
  if (table === 'points') {
    const point = offlineRow as unknown as Point
    const deviceId = refDevice(offlineRow, plan)
    const device = findDevice(plan, context.master, deviceId)
    const building = device ? findBuilding(plan, context.master, device.buildingId) : undefined
    const verdictConflict = plan.conflicts.find(
      (item) => item.table === 'verdicts' && !item.resolution && (item.offlineRow as unknown as Verdict | null)?.pointId === refId
    )
    const inspector = (verdictConflict?.offlineRow as unknown as Verdict | undefined)?.inspector ?? ''
    plan.ops.push({
      seq: plan.ops.length,
      stage: 'verdicts',
      kind: 'fast-forward',
      table: 'verdicts',
      targetId: context.master.verdicts.find((v) => v.pointId === targetId)?.id ?? `vrd_${targetId}`,
      sourceId: `rejudge:${refId}`,
      fromConflict: true,
      rejudge: {
        pointId: targetId,
        measuredOhm: point.measuredOhm,
        limitOhm: point.limitOhm,
        protectionClass: building?.protectionClass ?? '三类',
        deviceType: device?.type ?? '接地体',
        measureDate: point.measureDate,
        inspector
      }
    })
    plan.conflicts
      .filter((item) => item.table === 'verdicts' && !item.resolution)
      .forEach((item) => {
        if ((item.offlineRow as unknown as Verdict | null)?.pointId === refId) {
          item.resolution = 'keep-master'
          item.resolvedAt = Date.now()
        }
      })
  }
}
