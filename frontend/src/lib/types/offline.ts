/**
 * 外业离线并回机制的类型定义。
 *
 * 作业链路：
 *   出发前 checkout（冻结主档案基线）→ 平板离线采集（操作流水 append 到 fieldLogs）
 *   → 回单位 seal（基线 + 两侧现状 + 流水打成离线包）→ import（基线 / 主档案 / 离线现状三方对账）
 *
 * 判定与整改不进入操作流水：判定由测点实测值按最新限值重算，整改单跟踪状态由主档案沿用。
 */
import type { BackupPayload } from '$lib/utils/db'
import type { Building } from './building'
import type { Device } from './device'
import type { Point } from './point'
import type { Rectify } from './rectify'

/** 进入外业对账的四类业务对象 */
export type OfflineEntity = 'building' | 'device' | 'point' | 'rectify'

/** 外业操作流水的操作类型 */
export type FieldOp = 'create' | 'update' | 'delete'

/** fieldLogs 表的一行（主键自增，即作业时序） */
export interface FieldLogRow {
  seq?: number
  pkgId: string
  entity: OfflineEntity
  op: FieldOp
  refId: string
  at: number
}

/** 主档案五表快照（离线包基线 / 离线现状共用） */
export interface OfflineSnapshot {
  buildings: Building[]
  devices: Device[]
  points: Point[]
  verdicts: BackupPayload['verdicts']
  rectifies: Rectify[]
}

/**
 * 离线包：带各对象引用和主档案基线。
 * - baseline：出发时主档案的冻结快照，供三方对账
 * - field：回单位时平板一侧的现状
 * - logs：外业期间的操作流水（补录对象靠它识别）
 */
export interface OfflinePackage {
  app: 'gblightprot-offline'
  /** 离线包唯一编号：同一包重复导入只算一次的幂等键 */
  pkgId: string
  dbVersion: number
  inspector: string
  checkedOutAt: string
  sealedAt: string
  baseline: OfflineSnapshot
  field: OfflineSnapshot
  logs: FieldLogRow[]
}

/* ------------------------------ 对账计划 ------------------------------ */

/** 对账动作的稳定 key（断点游标按它记录，重复导入不会重复执行） */
export type ActionKey = string

/** 判定重算规格：实测值改动后按最新限值重算 */
export interface RecomputeSpec {
  /** 应用动作后主档案中的测点 id（补录测点为重编号后的新 id） */
  pointId: string
  /** 沿用的原判定 id（补录测点的判定为新 id） */
  verdictId: string
  /** 沿用的检测人（留空则不署名） */
  inspector: string
  /** 判定日期（取测点检测日期） */
  verdictDate: string
}

/** 待确认冲突：两侧都改过（含主档案已删 / 离线已删），不自动应用 */
export interface ConflictDetail {
  /** 冲突字段（业务字段名；删除冲突为 __deleted__） */
  fields: string[]
  /** 基线值 / 主档案现值 / 离线现值（删除方缺该键） */
  baseline: Record<string, unknown>
  master: Record<string, unknown> | null
  field: Record<string, unknown> | null
  /** 主档案已删除时，离线上仍存在的完整行（取主档案则需重建） */
  fieldRow?: object
  /** 测点冲突重建时沿用的离线判定（取检测人；判定结果按最新限值重算） */
  fieldVerdict?: BackupPayload['verdicts'][number]
}

export interface CreateAction {
  kind: 'create'
  entity: OfflineEntity
  key: ActionKey
  /** 新主键（补录对象重编编号：规划时预分配，保证断点续跑稳定） */
  newId: string
  /** 引用关系已重映射后的完整业务行 */
  row: Record<string, unknown>
  /** 补录测点需要随测点一起重建判定 */
  recompute?: RecomputeSpec
  /** 补录测点的业务编号是否经过重编（沿用原引用关系但编号避让主档案） */
  renumbered?: boolean
}

export interface UpdateAction {
  kind: 'update'
  entity: OfflineEntity
  key: ActionKey
  id: string
  /** 仅离线一侧改动的业务字段补丁（updatedAt 不参与对账） */
  patch: Record<string, unknown>
  /** 实测值改动的测点需要重算判定 */
  recompute?: RecomputeSpec
}

export interface DeleteAction {
  kind: 'delete'
  entity: OfflineEntity
  key: ActionKey
  id: string
}

export interface ConflictAction {
  kind: 'conflict'
  entity: OfflineEntity
  key: ActionKey
  id: string
  detail: ConflictDetail
}

export type ReconcileAction = CreateAction | UpdateAction | DeleteAction | ConflictAction

/** 三方对账结果 */
export interface ReconcilePlan {
  /** 离线新增对象的旧 id → 重编后新 id（建筑物 / 装置 / 测点 / 整改单） */
  idMaps: {
    building: Record<string, string>
    device: Record<string, string>
    point: Record<string, string>
    rectify: Record<string, string>
  }
  /** 有序动作列表（父 → 子顺序，断点按游标顺序执行） */
  actions: ReconcileAction[]
  /** 各类动作计数（含「无需处理」的基线一致条数） */
  counts: {
    create: number
    update: number
    delete: number
    conflict: number
    unchanged: number
  }
}

/* ------------------------------ 导入运行记录 ------------------------------ */

export type ImportRunStatus =
  | 'rejected' // 整包退回（引用缺失等校验失败）：记录留下，未写入任何业务数据
  | 'applied' // 全部应用完成
  | 'paused' // 已应用到断点（无待确认），写入失败后可从断点继续
  | 'pending' // 自动应用完成，仍有待确认冲突
  | 'resolved' // 待确认冲突全部处理完
  | 'rolledback' // 已恢复到导入前状态

/** importRuns 表的一行：同一个离线包在主档案上只保留一条 */
export interface ImportRun {
  /** 即离线包 pkgId，天然去重：同包重复导入只算一次 */
  id: string
  status: ImportRunStatus
  pkgName: string
  inspector: string
  importedAt: number
  /** 校验退回 / 写入失败等原因说明 */
  errors: string[]
  /** 导入前五表完整快照（恢复点）：回滚据此整体还原 */
  preImage: OfflineSnapshot
  plan: ReconcilePlan
  /** 已执行到的动作下标（断点游标），resume 从此处继续 */
  appliedIndex: number
  /** 已确认处理的冲突 key */
  resolvedConflictKeys: string[]
  /** 最近一次写入失败信息（paused 时展示） */
  lastError?: string
  attempts: number
  updatedAt: number
}

/* --------------------------- 外业作业状态（offlineState） --------------------------- */

/** offlineState 表唯一行 id */
export const OFFLINE_STATE_ID = 'active'

export interface OfflineStateRow {
  id: typeof OFFLINE_STATE_ID
  pkgId: string
  inspector: string
  checkedOutAt: string
  /** 出发前主档案基线（封包时读出，与两侧现状对账） */
  baseline: OfflineSnapshot
}
