/**
 * 外业操作流水：仅在「已导出离线包、外业作业进行中」记录增 / 改 / 删。
 *
 * 设计要点：
 * - stores 里的业务写操作统一调用 {@link logFieldChange}；没有活动作业时它是一次空操作，
 *   主档案日常台账录入不受影响。
 * - 活动作业标记缓存在 localStorage，热路径上不必每写一条记录都查 IndexedDB；
 *   真正入表前再以事务里的 offlineState 行兜底（例如另一标签页放弃了作业）。
 * - 在显式 Dexie 事务内调用时，fieldLogs 必须已列入该事务的表清单，
 *   流水与业务写入同事务提交，避免「台账改了、流水丢了」。
 */
import { db } from '$lib/utils/db'
import type { FieldLogRow, FieldOp, OfflineEntity } from '$lib/types/offline'
import { OFFLINE_STATE_ID } from '$lib/types/offline'

const ACTIVE_KEY = 'gblightprot:field-active'
const PKGS_KEY = 'gblightprot:field-pkg'

/** 标记当前浏览器存在外业作业（离线包导出成功后调用） */
export function markFieldActive(pkgId: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, '1')
    localStorage.setItem(PKGS_KEY, pkgId)
  } catch {
    // localStorage 不可用时退化为每次查表，不影响流水正确性
  }
}

/** 放弃 / 封盘后取消活动标记 */
export function clearFieldActive(): void {
  try {
    localStorage.removeItem(ACTIVE_KEY)
    localStorage.removeItem(PKGS_KEY)
  } catch {
    // 忽略
  }
}

/** 是否存在活动外业作业（先读缓存标记，避免给台账热路径加 IndexedDB 开销） */
export function isFieldActive(): boolean {
  try {
    return localStorage.getItem(ACTIVE_KEY) === '1'
  } catch {
    return true
  }
}

/** 活动作业对应的离线包 id */
export function activePkgId(): string | null {
  try {
    return localStorage.getItem(PKGS_KEY)
  } catch {
    return null
  }
}

/**
 * 追加一条外业流水。
 * 无活动作业时直接返回；事务内调用依赖调用方把 fieldLogs / offlineState 列入事务表。
 */
export async function logFieldChange(entity: OfflineEntity, op: FieldOp, refId: string): Promise<void> {
  if (!isFieldActive()) return
  const state = await db.offlineState.get(OFFLINE_STATE_ID)
  if (!state) {
    clearFieldActive()
    return
  }
  const row: Omit<FieldLogRow, 'seq'> = {
    pkgId: state.pkgId,
    entity,
    op,
    refId,
    at: Date.now()
  }
  await db.fieldLogs.put(row as FieldLogRow)
}
