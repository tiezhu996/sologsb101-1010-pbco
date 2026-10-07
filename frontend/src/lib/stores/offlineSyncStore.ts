/**
 * 外业并回页面状态：活动作业信息与导入运行记录的响应式订阅。
 * 只做展示层聚合，写操作一律走 utils/offlineSync。
 */
import { writable } from 'svelte/store'
import { db, watchTable } from '$lib/utils/db'
import type { ImportRun, OfflineStateRow } from '$lib/types/offline'
import { OFFLINE_STATE_ID } from '$lib/types/offline'

export const importRunList = writable<ImportRun[]>([])
export const activeSession = writable<OfflineStateRow | null>(null)
export const syncReady = writable(false)

watchTable<ImportRun>(() => db.importRuns).subscribe((rows) => {
  importRunList.set(rows.sort((a, b) => b.importedAt - a.importedAt))
})

db.offlineState
  .get(OFFLINE_STATE_ID)
  .then((row) => activeSession.set(row ?? null))
  .catch(() => activeSession.set(null))

// 作业只有一行，直接订阅整表
watchTable<OfflineStateRow>(() => db.offlineState).subscribe((rows) => {
  activeSession.set(rows.find((row) => row.id === OFFLINE_STATE_ID) ?? null)
  syncReady.set(true)
})
