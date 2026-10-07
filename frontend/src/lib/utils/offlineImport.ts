/**
 * 离线包导入执行器（真正读写 Dexie 的一层；对账规则见 utils/reconcile.ts）：
 *
 * - 幂等：同一个 packageId 只算一次，已完成批次重复导入直接返回上次结果。
 * - 恢复点：首条业务写入前把主档案五表全量快照存到 importSnapshots，
 *   写入失败后可 rollbackImport() 恢复到导入前状态。
 * - 断点续传：操作按阶段排序后分块事务写入，每块完成打 applied 标记；
 *   中断后用同一包再次导入即从断点继续，已处理记录不重复执行。
 * - 整包退回：引用完整性校验失败时状态置 rejected，不写任何业务表；
 *   批次记录与恢复点保留，便于查错与修正后重试。
 * - 判定重算（rejudge）只改判定行，整改单跟踪状态一律不动。
 */
import { db, createId } from '$lib/utils/db'
import type { Verdict } from '$lib/types/verdict'
import { defaultBasis, judgePoint } from '$lib/types/verdict'
import {
  OFFLINE_TABLE_KEYS,
  type ConflictResolution,
  type ImportOp,
  type ImportOutcome,
  type ImportRun,
  type ImportSnapshot,
  type OfflinePackageEnvelope,
  type OfflineTableKey,
  type TableBundle
} from '$lib/types/offline'
import { readTableBundle } from '$lib/utils/offlinePackage'
import { buildReconcilePlan, resolveConflict, summarizePlan, type ReconcilePlan } from '$lib/utils/reconcile'

/** 每个事务处理的操作数：既保证长任务有断点，又不会逐行开关事务 */
const CHUNK_SIZE = 25

/** 导入涉及的五张业务表 */
const BUSINESS_TABLES = [db.buildings, db.devices, db.points, db.verdicts, db.rectifies] as const

/** Map 映射 ↔ 可持久化数组 */
type IdMapPairs = Record<OfflineTableKey, Array<[string, string]>>

function toIdMapPairs(plan: ReconcilePlan): IdMapPairs {
  const pairs = {} as IdMapPairs
  OFFLINE_TABLE_KEYS.forEach((key) => {
    pairs[key] = [...plan.idMaps[key].entries()]
  })
  return pairs
}

function fromIdMapPairs(pairs: IdMapPairs): ReconcilePlan['idMaps'] {
  const maps = {} as ReconcilePlan['idMaps']
  OFFLINE_TABLE_KEYS.forEach((key) => {
    maps[key] = new Map(pairs[key] ?? [])
  })
  return maps
}

/** 取某张业务表的 Dexie Table 对象 */
function tableOf(key: OfflineTableKey) {
  switch (key) {
    case 'buildings':
      return db.buildings
    case 'devices':
      return db.devices
    case 'points':
      return db.points
    case 'verdicts':
      return db.verdicts
    case 'rectifies':
      return db.rectifies
  }
}

/** 读取全部导入批次（最近在前） */
export async function listImportRuns(): Promise<ImportRun[]> {
  const runs = await db.importRuns.toArray()
  return runs.sort((a, b) => b.importedAt - a.importedAt)
}

/** 按 packageId 读取批次 */
export async function getImportRun(packageId: string): Promise<ImportRun | undefined> {
  return db.importRuns.get(packageId)
}

/** 创建导入前恢复点 */
async function persistSnapshot(runId: string, bundle: TableBundle): Promise<ImportSnapshot> {
  const snapshot: ImportSnapshot = {
    id: createId('snap'),
    packageId: runId,
    runId,
    createdAt: Date.now(),
    bundle,
    counts: {
      buildings: bundle.buildings.length,
      devices: bundle.devices.length,
      points: bundle.points.length,
      verdicts: bundle.verdicts.length,
      rectifies: bundle.rectifies.length
    }
  }
  await db.importSnapshots.put(snapshot)
  return snapshot
}

/** 由纯对账计划构造可持久化批次 */
function runFromPlan(pkg: OfflinePackageEnvelope, plan: ReconcilePlan, master: TableBundle, now: number): ImportRun {
  return {
    id: pkg.packageId,
    packageName: pkg.name,
    dbVersion: pkg.dbVersion,
    exportedAt: pkg.exportedAt,
    returnedAt: pkg.returnedAt,
    importedAt: now,
    status: plan.errors.length > 0 ? 'rejected' : 'applying',
    phase: 'prepare',
    lastSeq: -1,
    ops: plan.ops,
    conflicts: plan.conflicts,
    idMaps: toIdMapPairs(plan),
    offlineSnapshot: pkg.snapshot,
    stats: summarizePlan(plan),
    errors: plan.errors,
    snapshotId: null,
    attempts: [now],
    completedAt: null
  }
}

/** 重新统计（冲突解决 / 续传后） */
function refreshStats(run: ImportRun): void {
  run.stats = summarizePlan({
    errors: run.errors,
    ops: run.ops,
    conflicts: run.conflicts,
    idMaps: fromIdMapPairs(run.idMaps),
    rejudgePointIds: new Set(),
    rejudgeParams: new Map()
  })
}

/**
 * 应用一批操作（一个 Dexie 读写事务内顺序执行），成功后就地打 applied 标记。
 * 父表先于子表的顺序由计划阶段排序保证；删除仅需 key，其余整行 put。
 */
async function executeChunk(run: ImportRun, ops: ImportOp[]): Promise<void> {
  await db.transaction('rw', BUSINESS_TABLES, async () => {
    for (const op of ops) {
      if (op.rejudge) {
        await applyRejudge(op)
      } else if (op.kind === 'deleted-offline') {
        await tableOf(op.table).delete(op.targetId)
      } else if (op.row) {
        // 表名为动态联合类型，行内容已在对账阶段按表组装，此处整体写入
        await (tableOf(op.table) as { put: (row: unknown) => Promise<unknown> }).put(structuredClone(op.row))
      }
      op.applied = true
      run.lastSeq = Math.max(run.lastSeq, op.seq)
    }
  })
}

/**
 * 判定重算：以测点最新实测值 / 限值重算结论与依据。
 * - 沿用主档案既有判定的 id、检测人（外业判定检测人优先）与创建时间，
 *   跟踪用的整改单完全不动——「判定翻新不丢整改跟踪」。
 * - 重算结果需检测人回单位后重新确认，confirmed 置为 false。
 */
async function applyRejudge(op: ImportOp): Promise<void> {
  const ctx = op.rejudge!
  const now = Date.now()
  const existing = await db.verdicts.get(op.targetId)
  const result = judgePoint(ctx.measuredOhm, ctx.limitOhm)
  const basis = defaultBasis(ctx.protectionClass, ctx.deviceType, ctx.limitOhm)
  const row: Verdict = existing
    ? {
        ...existing,
        result,
        basis,
        verdictDate: ctx.measureDate || existing.verdictDate,
        inspector: ctx.inspector || existing.inspector,
        confirmed: false,
        updatedAt: now
      }
    : {
        id: op.targetId,
        pointId: ctx.pointId,
        result,
        basis,
        inspector: ctx.inspector,
        verdictDate: ctx.measureDate,
        confirmed: false,
        createdAt: now,
        updatedAt: now
      }
  await db.verdicts.put(row)
}

/** 执行所有尚未 applied 的操作，分块事务提交，每块落库断点 */
async function applyPending(run: ImportRun): Promise<void> {
  const pending = run.ops.filter((op) => !op.applied).sort((a, b) => a.seq - b.seq)
  for (let index = 0; index < pending.length; index += CHUNK_SIZE) {
    const chunk = pending.slice(index, index + CHUNK_SIZE)
    await executeChunk(run, chunk)
    await db.importRuns.put(run)
  }
}

/**
 * 冲突解决后，未执行操作只剩「冲突派生操作」，按阶段（父表先于子表）重排其 seq。
 * 已 applied 的历史操作不动，断点标记不失效。
 */
function renumberPendingByStage(run: ImportRun): void {
  const stageOrder: Record<ImportOp['stage'], number> = {
    buildings: 0,
    devices: 1,
    points: 2,
    verdicts: 3,
    rectifies: 4
  }
  // 同阶段内：写入在前（父先建）、删除在后（子先删）
  const deleteLast = (op: ImportOp): number => (op.kind === 'deleted-offline' ? 1 : 0)
  let nextSeq = run.ops.reduce((max, op) => Math.max(max, op.seq), -1) + 1
  const pending = run.ops
    .filter((op) => !op.applied)
    .sort((a, b) => stageOrder[a.stage] - stageOrder[b.stage] || deleteLast(a) - deleteLast(b))
  pending.forEach((op) => {
    op.seq = nextSeq++
  })
}

/** 应用结束后根据冲突解决情况收束状态 */
function finalizeRun(run: ImportRun): void {
  const pending = run.conflicts.filter((conflict) => conflict.resolution === null).length
  run.phase = pending > 0 ? 'resolving' : 'done'
  run.status = pending > 0 ? 'planned' : 'completed'
  run.completedAt = pending > 0 ? null : Date.now()
  refreshStats(run)
}

/**
 * 导入离线包（入口）。
 *
 * - 已 completed：幂等返回（duplicated = true），同一个包重复导入只算一次。
 * - failed / planned：从断点继续（resumed = true），已处理记录不重放。
 * - rejected / rolled-back / 首次：重新读取主档案、重建恢复点与对账计划。
 */
export async function importOfflinePackage(pkg: OfflinePackageEnvelope): Promise<ImportOutcome> {
  const now = Date.now()
  const existing = await db.importRuns.get(pkg.packageId)

  if (existing?.status === 'completed') {
    return { run: existing, duplicated: true, resumed: false }
  }

  if (existing && (existing.status === 'failed' || existing.status === 'planned')) {
    return resumeImport(existing.id)
  }

  // 首次导入，或此前被整包退回 / 已回滚：基于当前主档案重新对账
  const master = await readTableBundle()
  const plan = buildReconcilePlan(pkg, master)
  const run = runFromPlan(pkg, plan, master, now)

  if (plan.errors.length > 0) {
    // 整包退回：仍留下批次记录与恢复点（恢复点即当时主档案），不写任何业务表
    await db.transaction('rw', [db.importRuns, db.importSnapshots], async () => {
      const snapshot = await persistSnapshot(pkg.packageId, master)
      run.snapshotId = snapshot.id
      run.phase = 'done'
      await db.importRuns.put(run)
    })
    return { run, duplicated: false, resumed: false }
  }

  try {
    // 恢复点先于一切业务变更落库（同一事务，保证不会出现「改了数据却没有恢复点」）
    await db.transaction('rw', [db.importRuns, db.importSnapshots], async () => {
      const snapshot = await persistSnapshot(pkg.packageId, master)
      run.snapshotId = snapshot.id
      await db.importRuns.put(run)
    })
    await applyPending(run)
    const fresh = (await db.importRuns.get(pkg.packageId))!
    finalizeRun(fresh)
    await db.importRuns.put(fresh)
    return { run: fresh, duplicated: false, resumed: false }
  } catch (error) {
    const failed = await db.importRuns.get(pkg.packageId)
    if (failed) {
      failed.status = 'failed'
      failed.errors = [
        ...failed.errors.filter((line) => !line.startsWith('写入中断：')),
        `写入中断：${String(error)}`
      ]
      await db.importRuns.put(failed)
      return { run: failed, duplicated: false, resumed: false }
    }
    throw error
  }
}

/** 从断点继续一个中断 / 待确认的批次 */
export async function resumeImport(packageId: string): Promise<ImportOutcome> {
  const current = await db.importRuns.get(packageId)
  if (!current) throw new Error('导入批次已不存在，无法续传')
  if (current.status === 'completed') return { run: current, duplicated: true, resumed: false }

  current.attempts.push(Date.now())
  current.errors = current.errors.filter((line) => !line.startsWith('写入中断：'))
  current.status = 'applying'
  await db.importRuns.put(current)

  try {
    await applyPending(current)
    const fresh = (await db.importRuns.get(packageId))!
    finalizeRun(fresh)
    await db.importRuns.put(fresh)
    return { run: fresh, duplicated: false, resumed: true }
  } catch (error) {
    const failed = (await db.importRuns.get(packageId))!
    failed.status = 'failed'
    failed.errors = [...failed.errors, `写入中断：${String(error)}`]
    await db.importRuns.put(failed)
    return { run: failed, duplicated: false, resumed: true }
  }
}

/**
 * 解决一条冲突并立即执行因此新增的操作。
 * 冲突原文 / id 映射 / 离线快照都在批次里，解决时无需用户重新选择回传包文件；
 * 最后一条待确认冲突结案后批次自动收束为 completed。
 */
export async function resolveImportConflict(
  packageId: string,
  conflictKey: string,
  resolution: ConflictResolution
): Promise<ImportRun> {
  const run = await db.importRuns.get(packageId)
  if (!run) throw new Error('导入批次不存在')
  const conflict = run.conflicts.find((item) => item.key === conflictKey)
  if (!conflict) throw new Error('冲突记录不存在')
  if (conflict.resolution) return run

  const beforeSeq = run.ops.length
  const master = await readTableBundle()
  const planView: ReconcilePlan = {
    errors: run.errors,
    ops: run.ops,
    conflicts: run.conflicts,
    idMaps: fromIdMapPairs(run.idMaps),
    rejudgePointIds: new Set(),
    rejudgeParams: new Map()
  }
  resolveConflict(planView, conflictKey, resolution, { master })

  // 把可能被重编的 id 映射写回批次
  run.idMaps = toIdMapPairs(planView)
  const added = run.ops.slice(beforeSeq)
  added.forEach((op) => (op.applied = false))
  renumberPendingByStage(run)

  try {
    await applyPending(run)
    const fresh = (await db.importRuns.get(packageId))!
    finalizeRun(fresh)
    await db.importRuns.put(fresh)
    return fresh
  } catch (error) {
    const failed = (await db.importRuns.get(packageId))!
    failed.status = 'failed'
    failed.errors = [...failed.errors, `冲突解决写入中断：${String(error)}`]
    await db.importRuns.put(failed)
    return failed
  }
}

/**
 * 回滚：用恢复点把五张业务表恢复到导入前状态（一个事务内清空 + 回灌）。
 * 批次记录保留并置 rolled-back；此后重新导入同一包会按首次导入全新对账。
 */
export async function rollbackImport(packageId: string): Promise<ImportRun> {
  const run = await db.importRuns.get(packageId)
  if (!run) throw new Error('导入批次不存在')
  const snapshot = run.snapshotId ? await db.importSnapshots.get(run.snapshotId) : null
  if (!snapshot) throw new Error('恢复点缺失，无法回滚')

  await db.transaction('rw', BUSINESS_TABLES, async () => {
    await Promise.all([
      db.buildings.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.verdicts.clear(),
      db.rectifies.clear()
    ])
    await db.buildings.bulkPut(snapshot.bundle.buildings)
    await db.devices.bulkPut(snapshot.bundle.devices)
    await db.points.bulkPut(snapshot.bundle.points)
    await db.verdicts.bulkPut(snapshot.bundle.verdicts)
    await db.rectifies.bulkPut(snapshot.bundle.rectifies)
  })

  run.status = 'rolled-back'
  run.phase = 'done'
  run.completedAt = null
  await db.importRuns.put(run)
  return run
}

/** 删除批次与对应恢复点（仅整理历史用，不影响业务数据） */
export async function deleteImportRun(packageId: string): Promise<void> {
  const run = await db.importRuns.get(packageId)
  await db.transaction('rw', [db.importRuns, db.importSnapshots], async () => {
    if (run?.snapshotId) await db.importSnapshots.delete(run.snapshotId)
    await db.importRuns.delete(packageId)
  })
}
