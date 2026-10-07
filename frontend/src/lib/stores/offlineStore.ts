/**
 * 离线采集并回 store：维护平板离线会话与主档案导入批次的响应式视图，
 * 页面只做动作派发与提示，具体组装 / 对账 / 恢复逻辑都在 utils 层。
 */
import { writable } from 'svelte/store'
import { db, watchTable } from '$lib/utils/db'
import type { ImportRun, OfflineSession } from '$lib/types/offline'
import type { ConflictResolution, OfflinePackageEnvelope, ImportOutcome } from '$lib/types/offline'
import {
  buildReturnPackage,
  clearActiveSession,
  downloadReturnPackage,
  exportOfflinePackage,
  getActiveSession,
  loadOfflinePackage,
  readOfflineFile
} from '$lib/utils/offlinePackage'
import {
  deleteImportRun,
  getImportRun,
  importOfflinePackage,
  listImportRuns,
  resolveImportConflict,
  resumeImport,
  rollbackImport
} from '$lib/utils/offlineImport'

/** 当前平板上的离线会话（单机单会话） */
export const offlineSessionList = writable<OfflineSession[]>([])
/** 主档案侧全部导入批次（最近在前） */
export const importRunList = writable<ImportRun[]>([])
/** 全局面板忙等（导出 / 装载 / 导入 / 回滚共用） */
export const offlineBusy = writable(false)

watchTable<OfflineSession>(() => db.offlineSessions).subscribe((rows) => {
  offlineSessionList.set([...rows].sort((a, b) => b.exportedAt.localeCompare(a.exportedAt)))
})
watchTable<ImportRun>(() => db.importRuns).subscribe((rows) => {
  importRunList.set([...rows].sort((a, b) => b.importedAt - a.importedAt))
})

/** 主动刷新批次列表（liveQuery 通常已覆盖，动作后兜底同步） */
export async function refreshImportRuns(): Promise<void> {
  importRunList.set(await listImportRuns())
}

/* -------------------------------- 单位侧 -------------------------------- */

/** 出发前：导出带基线与引用的离线包 */
export async function prepareOfflinePackage(name: string): Promise<{ fileName: string; pkg: OfflinePackageEnvelope }> {
  offlineBusy.set(true)
  try {
    return await exportOfflinePackage(name)
  } finally {
    offlineBusy.set(false)
  }
}

/** 回单位：导入外业回传包（三方对账 + 断点续传 + 幂等） */
export async function mergeReturnPackage(pkg: OfflinePackageEnvelope): Promise<ImportOutcome> {
  offlineBusy.set(true)
  try {
    const outcome = await importOfflinePackage(pkg)
    await refreshImportRuns()
    return outcome
  } finally {
    offlineBusy.set(false)
  }
}

/** 读取并校验用户选择的离线包 / 回传包文件 */
export async function readPackageFile(file: File) {
  return readOfflineFile(file)
}

/* -------------------------------- 平板侧 -------------------------------- */

/** 平板：装载出发前离线包（留存会话基线并整体替换业务数据） */
export async function loadPackageToTablet(pkg: OfflinePackageEnvelope): Promise<void> {
  offlineBusy.set(true)
  try {
    await loadOfflinePackage(pkg)
  } finally {
    offlineBusy.set(false)
  }
}

/** 平板：读取当前会话（页面回显任务名 / 导出时间） */
export async function fetchActiveSession(): Promise<OfflineSession | null> {
  return getActiveSession()
}

/** 平板：导出外业回传包（基线不动，写入当前五表现状） */
export async function exportReturnPackage(): Promise<string> {
  offlineBusy.set(true)
  try {
    const pkg = await buildReturnPackage()
    return downloadReturnPackage(pkg)
  } finally {
    offlineBusy.set(false)
  }
}

/** 平板：作废当前离线会话（仅清会话，不动业务数据） */
export async function discardSession(): Promise<void> {
  await clearActiveSession()
}

/* ------------------------------ 冲突与恢复 ------------------------------ */

/** 解决单条待确认冲突并立即落库 */
export async function settleConflict(packageId: string, conflictKey: string, resolution: ConflictResolution): Promise<ImportRun> {
  offlineBusy.set(true)
  try {
    const run = await resolveImportConflict(packageId, conflictKey, resolution)
    await refreshImportRuns()
    return run
  } finally {
    offlineBusy.set(false)
  }
}

/** 从中断点继续导入 */
export async function continueImport(packageId: string): Promise<ImportOutcome> {
  offlineBusy.set(true)
  try {
    const outcome = await resumeImport(packageId)
    await refreshImportRuns()
    return outcome
  } finally {
    offlineBusy.set(false)
  }
}

/** 用恢复点回滚到导入前状态 */
export async function restoreBeforeImport(packageId: string): Promise<ImportRun> {
  offlineBusy.set(true)
  try {
    const run = await rollbackImport(packageId)
    await refreshImportRuns()
    return run
  } finally {
    offlineBusy.set(false)
  }
}

/** 查询单个批次（页面定位用） */
export async function fetchImportRun(packageId: string): Promise<ImportRun | undefined> {
  return getImportRun(packageId)
}

/** 删除批次历史及其恢复点 */
export async function removeImportRun(packageId: string): Promise<void> {
  await deleteImportRun(packageId)
  await refreshImportRuns()
}
