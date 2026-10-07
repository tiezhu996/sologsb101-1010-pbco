/**
 * 外业离线包的导出（checkout / seal）与并回（import / resume / resolve / rollback）编排。
 *
 * 可靠性约定：
 * - 导入前先落恢复点（五表完整快照）+ 对账计划，写库分批事务、记录断点游标；
 *   写入失败后状态 paused，已处理记录与恢复点保留，可从断点继续。
 * - rollback 用恢复点在单事务内整体还原到导入前状态。
 * - 同一个离线包（pkgId）只处理一次：importRuns 以 pkgId 为主键。
 */
import { db, createId, DB_VERSION } from '$lib/utils/db'
import { defaultBasis, judgePoint } from '$lib/types/verdict'
import { clearFieldActive, markFieldActive } from '$lib/utils/fieldJournal'
import { reconcile, validateCrossReferences, validateOfflineReferences } from '$lib/utils/reconcile'
import type { Building } from '$lib/types/building'
import type { Device } from '$lib/types/device'
import type { Point } from '$lib/types/point'
import type { Verdict } from '$lib/types/verdict'
import type { Rectify } from '$lib/types/rectify'
import {
  OFFLINE_STATE_ID,
  type ConflictAction,
  type CreateAction,
  type DeleteAction,
  type ImportRun,
  type OfflinePackage,
  type OfflineSnapshot,
  type OfflineStateRow,
  type ReconcileAction,
  type ReconcilePlan,
  type RecomputeSpec,
  type UpdateAction
} from '$lib/types/offline'

/** 每批事务执行的动作数：失败时最多回滚这一批，断点从本批起点继续 */
const APPLY_BATCH = 20

/* ------------------------------ 快照读写 ------------------------------ */

export async function readSnapshot(): Promise<OfflineSnapshot> {
  const [buildings, devices, points, verdicts, rectifies] = await Promise.all([
    db.buildings.toArray(),
    db.devices.toArray(),
    db.points.toArray(),
    db.verdicts.toArray(),
    db.rectifies.toArray()
  ])
  return { buildings, devices, points, verdicts, rectifies }
}

export async function getActiveSession(): Promise<OfflineStateRow | null> {
  return (await db.offlineState.get(OFFLINE_STATE_ID)) ?? null
}

/* ------------------------------ 导出离线包 ------------------------------ */

/**
 * 出发前导出：冻结主档案基线并打开外业作业开关，之后平板上的增删改写入操作流水。
 * 同一时刻只允许一个未封盘的作业。
 */
export async function checkoutOfflinePackage(inspector: string): Promise<OfflineStateRow> {
  const existing = await getActiveSession()
  if (existing) {
    throw new Error(`已有外业作业 ${existing.pkgId} 尚未封盘，请先封盘或放弃作业`)
  }
  const pkgId = createId('pkg')
  const baseline = await readSnapshot()
  const state: OfflineStateRow = {
    id: OFFLINE_STATE_ID,
    pkgId,
    inspector: inspector.trim(),
    checkedOutAt: new Date().toISOString(),
    baseline
  }
  await db.transaction('rw', [db.offlineState, db.fieldLogs], async () => {
    await db.fieldLogs.clear()
    await db.offlineState.put(state)
  })
  markFieldActive(pkgId)
  return state
}

/** 放弃当前外业作业（基线与流水一并清除，主档案数据本身不动） */
export async function discardFieldSession(): Promise<void> {
  await db.transaction('rw', [db.offlineState, db.fieldLogs], async () => {
    await db.fieldLogs.clear()
    await db.offlineState.delete(OFFLINE_STATE_ID)
  })
  clearFieldActive()
}

/** 回单位封盘：基线 + 平板现状 + 操作流水打成离线包，并结束作业状态 */
export async function sealOfflinePackage(): Promise<OfflinePackage> {
  const state = await getActiveSession()
  if (!state) throw new Error('当前没有进行中的外业作业，无法封盘')
  const field = await readSnapshot()
  const logs = await db.fieldLogs.orderBy('seq').toArray()
  const pkg: OfflinePackage = {
    app: 'gblightprot-offline',
    pkgId: state.pkgId,
    dbVersion: DB_VERSION,
    inspector: state.inspector,
    checkedOutAt: state.checkedOutAt,
    sealedAt: new Date().toISOString(),
    baseline: state.baseline,
    field,
    logs
  }
  await db.transaction('rw', [db.offlineState, db.fieldLogs], async () => {
    await db.fieldLogs.clear()
    await db.offlineState.delete(OFFLINE_STATE_ID)
  })
  clearFieldActive()
  return pkg
}

/* ------------------------------ 并回导入 ------------------------------ */

/** 校验离线包结构 */
export function validateOfflinePackage(input: unknown): { ok: boolean; errors: string[]; pkg: OfflinePackage | null } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], pkg: null }
  }
  const obj = input as Partial<OfflinePackage>
  const errors: string[] = []
  if (obj.app !== 'gblightprot-offline') errors.push('app 字段应为 gblightprot-offline，文件不是外业离线包')
  if (typeof obj.pkgId !== 'string' || obj.pkgId.length === 0) errors.push('缺少离线包编号 pkgId')
  for (const side of ['baseline', 'field'] as const) {
    const snap = obj[side]
    if (!snap || typeof snap !== 'object') {
      errors.push(`${side} 快照缺失`)
      continue
    }
    for (const table of ['buildings', 'devices', 'points', 'verdicts', 'rectifies'] as const) {
      if (!Array.isArray(snap[table])) errors.push(`${side}.${table} 缺失或不是数组`)
    }
  }
  if (!Array.isArray(obj.logs)) errors.push('logs 操作流水缺失或不是数组')
  if (errors.length > 0) return { ok: false, errors, pkg: null }
  const pkg = obj as OfflinePackage
  // 引用完整性：缺建筑物或测点引用的离线记录整包退回
  errors.push(...validateOfflineReferences(pkg))
  if (errors.length > 0) return { ok: false, errors, pkg: null }
  return { ok: true, errors: [], pkg }
}

export interface ImportOutcome {
  run: ImportRun
  plan: ReconcilePlan
  duplicate: boolean
}

/**
 * 导入离线包：
 * 1. 幂等检查（同 pkgId 已处理 → 直接返回既有运行记录，不再次写业务表）
 * 2. 引用校验失败 → 整包退回（留 rejected 记录，不写业务数据）
 * 3. 落恢复点与对账计划，分批事务执行；失败留 paused + 断点
 */
export async function importOfflinePackage(pkg: OfflinePackage, pkgName: string): Promise<ImportOutcome> {
  const existing = await db.importRuns.get(pkg.pkgId)
  if (existing) {
    return { run: existing, plan: existing.plan, duplicate: true }
  }

  const master = await readSnapshot()

  // 跨侧引用校验：补录子对象的父对象在两侧都不存在 → 整包退回（留记录，不写业务数据）
  const crossErrors = validateCrossReferences(pkg, master)
  if (crossErrors.length > 0) {
    const rejected = await recordRejected(pkg, pkgName, crossErrors)
    return { run: rejected, plan: rejected.plan, duplicate: false }
  }

  const plan = reconcile(pkg, master)

  const run: ImportRun = {
    id: pkg.pkgId,
    status: 'applied',
    pkgName,
    inspector: pkg.inspector,
    importedAt: Date.now(),
    errors: [],
    preImage: master,
    plan,
    appliedIndex: 0,
    resolvedConflictKeys: [],
    attempts: 0,
    updatedAt: Date.now()
  }
  await db.importRuns.put(run)

  await applyRemaining(run.id)
  const saved = (await db.importRuns.get(pkg.pkgId))!
  return { run: saved, plan, duplicate: false }
}

/** 执行计划中尚未处理的动作（分批事务，推进断点游标） */
async function applyRemaining(runId: string): Promise<ImportRun> {
  const run = await db.importRuns.get(runId)
  if (!run) throw new Error('导入运行记录不存在')
  const { actions } = run.plan
  let index = run.appliedIndex
  run.attempts += 1
  run.lastError = undefined

  while (index < actions.length) {
    const batch = actions.slice(index, index + APPLY_BATCH)
    try {
      await db.transaction(
        'rw',
        [db.buildings, db.devices, db.points, db.verdicts, db.rectifies],
        async () => {
          for (const action of batch) {
            if (action.kind === 'conflict') continue // 待确认动作不自动执行
            await executeAction(action)
          }
        }
      )
      index += batch.length
      run.appliedIndex = index
      run.updatedAt = Date.now()
      await db.importRuns.put(run)
    } catch (error) {
      run.status = 'paused'
      run.lastError = error instanceof Error ? error.message : String(error)
      run.updatedAt = Date.now()
      await db.importRuns.put(run)
      return run
    }
  }

  const pendingConflicts = actions.filter(
    (action) => action.kind === 'conflict' && !run.resolvedConflictKeys.includes(action.key)
  ).length
  run.status = pendingConflicts > 0 ? 'pending' : 'applied'
  run.updatedAt = Date.now()
  await db.importRuns.put(run)
  return run
}

/** 从断点继续（写入失败 paused 后调用） */
export async function resumeImport(runId: string): Promise<ImportRun> {
  const run = await db.importRuns.get(runId)
  if (!run) throw new Error('导入运行记录不存在')
  if (run.status !== 'paused') return run
  return applyRemaining(runId)
}

/* ------------------------------ 动作执行 ------------------------------ */

async function executeAction(action: ReconcileAction): Promise<void> {
  switch (action.kind) {
    case 'create':
      await executeCreate(action)
      break
    case 'update':
      await executeUpdate(action)
      break
    case 'delete':
      await executeDelete(action)
      break
    case 'conflict':
      break
  }
}

async function executeCreate(action: CreateAction): Promise<void> {
  const now = Date.now()
  const row = { ...action.row, createdAt: Number(action.row.createdAt ?? now), updatedAt: Number(action.row.updatedAt ?? now) }
  if (action.entity === 'building') await db.buildings.put(row as unknown as Building)
  if (action.entity === 'device') await db.devices.put(row as unknown as Device)
  if (action.entity === 'point') {
    await db.points.put(row as unknown as Point)
    if (action.recompute) await recomputeVerdict(action.recompute)
  }
  if (action.entity === 'rectify') await db.rectifies.put(row as unknown as Rectify)
}

async function executeUpdate(action: UpdateAction): Promise<void> {
  const now = Date.now()
  if (action.entity === 'building') await db.buildings.update(action.id, { ...action.patch, updatedAt: now } as never)
  if (action.entity === 'device') await db.devices.update(action.id, { ...action.patch, updatedAt: now } as never)
  if (action.entity === 'rectify') await db.rectifies.update(action.id, { ...action.patch, updatedAt: now } as never)
  if (action.entity === 'point') {
    await db.points.update(action.id, { ...action.patch, updatedAt: now } as never)
    if (action.recompute) await recomputeVerdict(action.recompute)
  }
}

async function executeDelete(action: DeleteAction): Promise<void> {
  if (action.entity === 'rectify') {
    await db.rectifies.delete(action.id)
    return
  }
  if (action.entity === 'point') {
    await db.verdicts.where('pointId').equals(action.id).delete()
    await db.points.delete(action.id)
    return
  }
  if (action.entity === 'device') {
    const pointIds = (await db.points.where('deviceId').equals(action.id).toArray()).map((point) => point.id)
    if (pointIds.length > 0) await db.verdicts.where('pointId').anyOf(pointIds).delete()
    await db.points.where('deviceId').equals(action.id).delete()
    await db.devices.delete(action.id)
    return
  }
  // building：级联装置 → 测点 → 判定；整改单随建筑物清除（与台账删除语义一致）
  const deviceIds = (await db.devices.where('buildingId').equals(action.id).toArray()).map((device) => device.id)
  if (deviceIds.length > 0) {
    const pointIds = (await db.points.where('deviceId').anyOf(deviceIds).toArray()).map((point) => point.id)
    if (pointIds.length > 0) await db.verdicts.where('pointId').anyOf(pointIds).delete()
    await db.points.where('deviceId').anyOf(deviceIds).delete()
    await db.devices.bulkDelete(deviceIds)
  }
  await db.rectifies.where('buildingId').equals(action.id).delete()
  await db.buildings.delete(action.id)
}

/**
 * 接地电阻实测值改动后重算判定：按主档案上测点的最新限值重算结果与依据，
 * 原判定 id / 检测人 / 确认标记 / 创建时间沿用（整改单跟踪状态因此不丢失、不翻新）。
 */
async function recomputeVerdict(spec: RecomputeSpec): Promise<void> {
  const point = await db.points.get(spec.pointId)
  if (!point) return
  const device = await db.devices.get(point.deviceId)
  let protectionClass = '三类'
  if (device) {
    const building = await db.buildings.get(device.buildingId)
    if (building) protectionClass = building.protectionClass
  }
  const result = judgePoint(point.measuredOhm, point.limitOhm)
  const basis = defaultBasis(protectionClass, device?.type ?? '接地体', point.limitOhm)
  const existing = await db.verdicts.get(spec.verdictId)
  const now = Date.now()
  const verdict: Verdict = existing
    ? {
        ...existing,
        result,
        basis,
        verdictDate: spec.verdictDate || existing.verdictDate,
        updatedAt: now
      }
    : {
        id: spec.verdictId,
        pointId: spec.pointId,
        result,
        basis,
        inspector: spec.inspector,
        verdictDate: spec.verdictDate || point.measureDate,
        confirmed: false,
        createdAt: now,
        updatedAt: now
      }
  await db.verdicts.put(verdict)
}

/* ------------------------------ 冲突处理 ------------------------------ */

/** 取某运行记录中尚未处理的待确认冲突 */
export function pendingConflictsOf(run: ImportRun): ConflictAction[] {
  return run.plan.actions.filter(
    (action): action is ConflictAction =>
      action.kind === 'conflict' && !run.resolvedConflictKeys.includes(action.key)
  )
}

export interface ConflictChoice {
  /** 采用哪一侧：master=保持主档案现状（含尊重主档案的删除）；field=采用离线值（含重建被删对象） */
  winner: 'master' | 'field'
}

/**
 * 处理一条待确认冲突：
 * - master 胜出：不改动主档案；若离线一侧是「要求删除」，按删除语义级联
 * - field 胜出：把离线值写入主档案（主档案已删时整行重建）；实测相关变更触发判定重算
 */
export async function resolveConflict(runId: string, conflictKey: string, choice: ConflictChoice): Promise<ImportRun> {
  const run = await db.importRuns.get(runId)
  if (!run) throw new Error('导入运行记录不存在')
  const action = run.plan.actions.find((item) => item.key === conflictKey)
  if (!action || action.kind !== 'conflict') throw new Error('待确认冲突不存在或已处理')
  if (run.resolvedConflictKeys.includes(conflictKey)) return run

  await db.transaction('rw', [db.buildings, db.devices, db.points, db.verdicts, db.rectifies], async () => {
    if (choice.winner === 'master') {
      // 冲突为「离线删除 vs 主档案修改」：尊重主档案即放弃删除；其余 master 胜出均为零写入
      // （主档案现值保持不变）。
    } else {
      await applyFieldWinner(action)
    }
  })

  run.resolvedConflictKeys = [...run.resolvedConflictKeys, conflictKey]
  const remaining = pendingConflictsOf(run).length
  run.status = remaining === 0 ? 'resolved' : 'pending'
  run.updatedAt = Date.now()
  await db.importRuns.put(run)
  return run
}

/** field 胜出：把离线一侧的值落到主档案（删除冲突需要重建整行） */
async function applyFieldWinner(action: ConflictAction): Promise<void> {
  const { fieldRow, fieldVerdict } = action.detail
  if (fieldRow) {
    // 主档案已删、离线要求保留：整行重建（沿用原 id 与引用关系；补录子对象引用已在规划期重映射）
    const row = { ...fieldRow, updatedAt: Date.now() } as Record<string, unknown>
    if (action.entity === 'building') await db.buildings.put(row as unknown as Building)
    if (action.entity === 'device') await db.devices.put(row as unknown as Device)
    if (action.entity === 'rectify') await db.rectifies.put(row as unknown as Rectify)
    if (action.entity === 'point') {
      await db.points.put(row as unknown as Point)
      await recomputeVerdict({
        pointId: action.id,
        verdictId: fieldVerdict?.id ?? `vrd_${action.id}`,
        inspector: fieldVerdict?.inspector ?? '',
        verdictDate: (row.measureDate as string) ?? ''
      })
    }
    return
  }

  // 两侧都在：整体采用离线业务字段（主档案同字段的修改被离线值覆盖；引用字段已在计划里重映射）
  const fieldValues = action.detail.field
  if (!fieldValues) return
  const now = Date.now()
  if (action.entity === 'building') await db.buildings.update(action.id, { ...fieldValues, updatedAt: now } as never)
  if (action.entity === 'device') await db.devices.update(action.id, { ...fieldValues, updatedAt: now } as never)
  if (action.entity === 'rectify') await db.rectifies.update(action.id, { ...fieldValues, updatedAt: now } as never)
  if (action.entity === 'point') {
    await db.points.update(action.id, { ...fieldValues, updatedAt: now } as never)
    await recomputeVerdict({
      pointId: action.id,
      verdictId: fieldVerdict?.id ?? `vrd_${action.id}`,
      inspector: fieldVerdict?.inspector ?? '',
      verdictDate: (fieldValues.measureDate as string) ?? ''
    })
  }
}

/* ------------------------------ 回滚恢复 ------------------------------ */

/** 整包退回前落 rejected 记录（不写业务数据） */
export async function recordRejected(pkg: OfflinePackage, pkgName: string, errors: string[]): Promise<ImportRun> {
  const master = await readSnapshot()
  const run: ImportRun = {
    id: pkg.pkgId,
    status: 'rejected',
    pkgName,
    inspector: pkg.inspector,
    importedAt: Date.now(),
    errors,
    preImage: master,
    plan: { idMaps: { building: {}, device: {}, point: {}, rectify: {} }, actions: [], counts: { create: 0, update: 0, delete: 0, conflict: 0, unchanged: 0 } },
    appliedIndex: 0,
    resolvedConflictKeys: [],
    attempts: 1,
    updatedAt: Date.now()
  }
  await db.importRuns.put(run)
  return run
}

/** 用恢复点把五表整体还原到导入前状态（单事务；运行记录保留为 rolledback） */
export async function rollbackImport(runId: string): Promise<ImportRun> {
  const run = await db.importRuns.get(runId)
  if (!run) throw new Error('导入运行记录不存在')
  if (run.status === 'rolledback') return run
  const { preImage } = run
  await db.transaction('rw', [db.buildings, db.devices, db.points, db.verdicts, db.rectifies], async () => {
    await Promise.all([
      db.buildings.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.verdicts.clear(),
      db.rectifies.clear()
    ])
    await db.buildings.bulkPut(preImage.buildings)
    await db.devices.bulkPut(preImage.devices)
    await db.points.bulkPut(preImage.points)
    await db.verdicts.bulkPut(preImage.verdicts)
    await db.rectifies.bulkPut(preImage.rectifies)
  })
  run.status = 'rolledback'
  run.updatedAt = Date.now()
  await db.importRuns.put(run)
  return run
}

/** 列出全部导入运行记录（最近在前） */
export async function listImportRuns(): Promise<ImportRun[]> {
  const rows = await db.importRuns.toArray()
  return rows.sort((a, b) => b.importedAt - a.importedAt)
}

/** 离线包文件名：gblightprot-offline-<短编号>-<封盘时间>.json */
export function offlinePackageFileName(pkg: OfflinePackage): string {
  const stamp = pkg.sealedAt.slice(0, 19).replace(/[:T]/g, '')
  return `gblightprot-offline-${pkg.pkgId.slice(-6)}-${stamp}.json`
}

/** 下载离线包 JSON（封盘 / 调试查看基线用） */
export function downloadOfflinePackage(pkg: OfflinePackage): string {
  const fileName = offlinePackageFileName(pkg)
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return fileName
}
