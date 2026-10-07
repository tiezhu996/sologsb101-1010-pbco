/**
 * 离线采集包 / 回单位并回主档案的核心类型。
 *
 * 流程：
 * 1. 单位出发前导出离线包（含主档案基线 baseline 与各对象引用）。
 * 2. 平板装载离线包后，外业技术员在离线状态下补录 / 修订建筑物、装置、测点、判定与整改单。
 * 3. 回单位导出回传包（仍是同一 packageId，baseline 不动，snapshot 为平板现状）。
 * 4. 主档案按「基线 / 主档案现状 / 离线现状」三方对账：单边改动直接应用，两边都改留成待确认。
 */
import type { Building } from '$lib/types/building'
import type { Device } from '$lib/types/device'
import type { Point } from '$lib/types/point'
import type { Verdict } from '$lib/types/verdict'
import type { Rectify } from '$lib/types/rectify'

/** 五张业务表的统一键名 */
export const OFFLINE_TABLE_KEYS = ['buildings', 'devices', 'points', 'verdicts', 'rectifies'] as const
export type OfflineTableKey = (typeof OFFLINE_TABLE_KEYS)[number]

/** 一次导出的五表集合（基线快照与现状快照共用此结构） */
export interface TableBundle {
  buildings: Building[]
  devices: Device[]
  points: Point[]
  verdicts: Verdict[]
  rectifies: Rectify[]
}

/** 空集合（校验失败兜底 / 新建会话时复用） */
export function emptyTableBundle(): TableBundle {
  return { buildings: [], devices: [], points: [], verdicts: [], rectifies: [] }
}

/** 离线包文件头：识别来源与结构版本 */
export interface OfflinePackageEnvelope {
  app: 'gblightprot-offline'
  /** 同一次外业任务的稳定标识：去重导入、断点续传都以它为准 */
  packageId: string
  /** 结构版本（随主档案 DB_VERSION 写入，导入时仅做提示不拦截） */
  dbVersion: number
  /** 离线包名称，便于外业辨认（如项目名 + 日期） */
  name: string
  /** 出发前导出（装载平板）时刻 */
  exportedAt: string
  /** 外业结束导出回传包时刻；未回传时为 null */
  returnedAt: string | null
  /** 出发前主档案基线，对账三方中的「基线」 */
  baseline: TableBundle
  /** 数据现状：出发前等于 baseline，回传后是平板上的最新数据 */
  snapshot: TableBundle
}

/** 平板上保存的离线会话（基线 + 外业现状），持久化在 offlineSessions 表 */
export type OfflineSession = OfflinePackageEnvelope

/* ------------------------------ 三方对账计划 ------------------------------ */

/**
 * 对账结论：
 * - unchanged：三方一致，不产生操作
 * - fast-forward：仅离线侧单边改动（或主档案未动），可直接应用
 * - keep-master：仅主档案侧改动，保留主档案
 * - deleted-offline：离线删除、主档案未动，直接删除
 * - deleted-master：主档案删除、离线未动，主档案已不存在，无需操作
 * - conflict：两边都改过，留成待确认
 * - created-offline：基线不存在，离线新增（补录）
 * - created-master：基线不存在，主档案新增（与离线无关）
 */
export type ReconcileKind =
  | 'unchanged'
  | 'fast-forward'
  | 'created-offline'
  | 'created-master'
  | 'keep-master'
  | 'deleted-offline'
  | 'deleted-master'
  | 'conflict'

/** 待确认冲突的原因 */
export type ConflictReason = 'both-edited' | 'offline-edit-master-deleted' | 'both-created' | 'offline-delete-master-edited'

/**
 * 冲突解决方式（人工选择）：
 * - take-offline：采用离线版本（删除类则执行离线的删除）
 * - keep-master：保留主档案版本（新建类则丢弃离线新增）
 */
export type ConflictResolution = 'take-offline' | 'keep-master'

/** 对账产生的单条冲突（两边都改过 / 删除与编辑相撞等） */
export interface ImportConflict {
  /** packageId + 表名 + 主键，稳定唯一，便于续传时定位 */
  key: string
  table: OfflineTableKey
  /** 基线 / 离线上的主键（补录记录可能与主档案撞 id，真正写入以 targetId 为准） */
  refId: string
  reason: ConflictReason
  /** 对象摘要（编号 / 名称 / 问题描述），列表展示用 */
  label: string
  /** 离线侧记录原文（冲突解决时采用离线版本可直接取用，不必再选回传包文件） */
  offlineRow: Record<string, unknown> | null
  resolution: ConflictResolution | null
  resolvedAt: number | null
}

/**
 * 对账计划中的一条应用操作。
 * kind 为三方对账结论；rejudge 是测点落地后的派生操作（判定按最新限值重算）。
 */
export interface ImportOp {
  /** 包内顺序号，断点续传的游标即「最后完成的顺序号」 */
  seq: number
  /** 执行阶段：父表先于子表写入，rejudge 必须在测点全部落库后执行 */
  stage: 'buildings' | 'devices' | 'points' | 'verdicts' | 'rectifies'
  kind: ReconcileKind
  table: OfflineTableKey
  /** 目标主档案主键：新增为重编后的新 id，其余沿用原 id */
  targetId: string
  /** 离线侧原主键（排错展示用） */
  sourceId: string
  /** upsert 时要写入的完整行（引用已按 id 映射改写） */
  row?: Record<string, unknown> | null
  /** true 表示该操作来自已解决冲突（统计与展示区分） */
  fromConflict?: boolean
  /** 执行状态机：已成功落库的操作在断点续传时跳过（比 seq 游标更可靠，冲突解决可能在任意阶段追加操作） */
  applied?: boolean
  /**
   * 测点判定重算参数（kind === 'fast-forward' 且测点实测值 / 限值发生变化时附带）：
   * 目标测点行已在 points 阶段写入，verdicts 阶段按其最新值重算判定。
   */
  rejudge?: {
    pointId: string
    measuredOhm: number
    limitOhm: number
    protectionClass: string
    deviceType: string
    measureDate: string
    inspector: string
  }
}

/** 对账计划统计 */
export interface ImportPlanStats {
  /** 各表可直接应用（含离线新增 / 单边修改 / 离线删除）的条数 */
  apply: Record<OfflineTableKey, number>
  /** 待确认冲突条数 */
  conflicts: number
  /** 需要重算判定的测点数 */
  rejudges: number
  /** 引用校验问题数（>0 时整包退回） */
  validationErrors: number
}

/** 导入批次状态机 */
export type ImportRunStatus =
  | 'applying' // 无冲突操作应用中（断点续传的中间态）
  | 'rejected' // 引用完整性校验失败，整包退回（未写业务表）
  | 'planned' // 对账完成，存在待确认冲突，自动部分已应用
  | 'completed' // 全部无冲突操作已应用（或冲突已全部解决）
  | 'failed' // 写入中断，可从断点继续
  | 'rolled-back' // 已用恢复点回滚到导入前状态

/** 执行到的阶段（断点信息的一部分） */
export type ImportPhase = 'prepare' | 'applying' | 'resolving' | 'done'

/** 导入前主档案恢复点：五表全量快照 + 当时行数 */
export interface ImportSnapshot {
  id: string
  packageId: string
  runId: string
  createdAt: number
  bundle: TableBundle
  counts: Record<OfflineTableKey, number>
}

/**
 * 导入批次（importRuns 表，主键 packageId）。
 * 同一个离线包重复导入只算一次：已完成批次直接返回上次结果。
 */
export interface ImportRun {
  /** 等于离线包 packageId，天然去重 */
  id: string
  packageName: string
  dbVersion: number
  exportedAt: string
  returnedAt: string | null
  importedAt: number
  status: ImportRunStatus
  phase: ImportPhase
  /** 已执行到的操作顺序号（从 0 开始；-1 表示尚未开始） */
  lastSeq: number
  /** 对账计划（含全部操作与冲突），随执行进度更新 */
  ops: ImportOp[]
  conflicts: ImportConflict[]
  /** id 重编映射（数组化的 Map，IndexedDB 可直接持久化；冲突解决追加操作时沿用原引用关系） */
  idMaps: Record<OfflineTableKey, Array<[string, string]>>
  /** 离线现状快照（冲突解决时需要离线原文，不必要求用户再次选择回传包文件） */
  offlineSnapshot: TableBundle
  stats: ImportPlanStats
  /** 引用 / 结构校验错误（整包退回时给出原因清单） */
  errors: string[]
  /** 恢复点 id（首条写入前落库，回滚与已退回包留档共用） */
  snapshotId: string | null
  /** 历次尝试时间戳（首次导入与断点续传都追加） */
  attempts: number[]
  completedAt: number | null
}

/** 导入执行结果摘要（UI 提示与去重复用共用） */
export interface ImportOutcome {
  run: ImportRun
  /** true 表示该包此前已完成导入，本次未重复执行（同一个包只算一次） */
  duplicated: boolean
  /** true 表示本次是从中断点继续执行 */
  resumed: boolean
}
