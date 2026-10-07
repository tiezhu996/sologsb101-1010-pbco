/**
 * 离线采集包的组装、下载、装载与回传。
 *
 * - 单位侧：exportOfflinePackage() 导出带基线的离线包（基线 = 出发前主档案全量快照）。
 * - 平板侧：loadOfflinePackage() 清空空库并按快照装载，同时在 offlineSessions 留存基线。
 * - 平板侧：buildReturnPackage() 外业结束后把当前五表现状写回同包 snapshot（基线不动）。
 *
 * 纯前端实现：平板与单位之间用同一个 JSON 文件传递，不依赖任何服务端。
 */
import { db, DB_VERSION, createId } from '$lib/utils/db'
import { readFileText } from '$lib/utils/export'
import {
  OFFLINE_TABLE_KEYS,
  emptyTableBundle,
  type OfflinePackageEnvelope,
  type OfflineSession,
  type OfflineTableKey,
  type TableBundle
} from '$lib/types/offline'

/** 离线包文件标识 */
export const OFFLINE_APP_TAG = 'gblightprot-offline'

/** 读取主档案五表全量数据 */
export async function readTableBundle(): Promise<TableBundle> {
  const [buildings, devices, points, verdicts, rectifies] = await Promise.all([
    db.buildings.toArray(),
    db.devices.toArray(),
    db.points.toArray(),
    db.verdicts.toArray(),
    db.rectifies.toArray()
  ])
  return { buildings, devices, points, verdicts, rectifies }
}

/** 生成离线包稳定标识：同一天多次导出也互不相同 */
export function createPackageId(): string {
  return `off_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`
}

/** 组装出发前离线包：基线与现状一致，均为当前主档案 */
export async function buildOfflinePackage(name: string): Promise<OfflinePackageEnvelope> {
  const bundle = await readTableBundle()
  const nowIso = new Date().toISOString()
  return {
    app: OFFLINE_APP_TAG,
    packageId: createPackageId(),
    dbVersion: DB_VERSION,
    name: name.trim() || '外业离线采集包',
    exportedAt: nowIso,
    returnedAt: null,
    baseline: bundle,
    snapshot: structuredCloneBundle(bundle)
  }
}

/** 深拷贝五表集合（structuredClone 在现代浏览器可用，兜底走 JSON） */
function structuredCloneBundle(bundle: TableBundle): TableBundle {
  if (typeof structuredClone === 'function') return structuredClone(bundle)
  return JSON.parse(JSON.stringify(bundle)) as TableBundle
}

/** 触发浏览器下载（离线包 / 回传包共用） */
function downloadJson(payload: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 文件名安全字符：保留中文，去掉文件系统不允许的符号 */
function safeName(name: string): string {
  return (name.trim() || 'offline').replace(/[\\/:*?"<>|]+/g, '_')
}

/** 导出并下载出发前离线包 */
export async function exportOfflinePackage(name: string): Promise<{ fileName: string; pkg: OfflinePackageEnvelope }> {
  const pkg = await buildOfflinePackage(name)
  const stamp = pkg.exportedAt.slice(0, 19).replace(/[:T]/g, '')
  const fileName = `gblightprot-offline-${safeName(pkg.name)}-${stamp}.json`
  downloadJson(pkg, fileName)
  return { fileName, pkg }
}

/** 校验外部 JSON 是否为合法离线包（结构层面；引用完整性由 reconcile 阶段校验） */
export function validateOfflineEnvelope(input: unknown): {
  ok: boolean
  errors: string[]
  pkg: OfflinePackageEnvelope | null
} {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], pkg: null }
  }
  const obj = input as Partial<OfflinePackageEnvelope>
  if (obj.app !== OFFLINE_APP_TAG) {
    errors.push(`app 字段应为 ${OFFLINE_APP_TAG}，文件不是防雷台账离线包`)
  }
  if (typeof obj.packageId !== 'string' || obj.packageId.length === 0) {
    errors.push('packageId 缺失：无法标识外业任务')
  }
  if (typeof obj.exportedAt !== 'string') errors.push('exportedAt 缺失')
  for (const section of ['baseline', 'snapshot'] as const) {
    const part = obj[section]
    if (typeof part !== 'object' || part === null) {
      errors.push(`${section} 缺失或不是对象`)
      continue
    }
    for (const key of OFFLINE_TABLE_KEYS) {
      if (!Array.isArray((part as Partial<TableBundle>)[key])) {
        errors.push(`${section}.${key} 缺失或不是数组`)
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors, pkg: null }
  const pkg = obj as OfflinePackageEnvelope
  if (typeof pkg.name !== 'string' || pkg.name.length === 0) pkg.name = '外业离线采集包'
  if (typeof pkg.returnedAt !== 'string') pkg.returnedAt = null
  return { ok: true, errors: [], pkg }
}

/** 读取用户选择的离线包文件并完成结构校验 */
export async function readOfflineFile(file: File): Promise<{ ok: boolean; errors: string[]; pkg: OfflinePackageEnvelope | null }> {
  const text = await readFileText(file)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['文件不是合法的 JSON，无法解析'], pkg: null }
  }
  return validateOfflineEnvelope(parsed)
}

/**
 * 平板装载离线包：
 * 1. 留存离线会话（基线，供回传与对账使用）；
 * 2. 用包内现状快照整体替换业务五表（事务内清空 + 写入，失败可回到空库不残留）。
 */
export async function loadOfflinePackage(pkg: OfflinePackageEnvelope): Promise<void> {
  const session: OfflineSession = { ...pkg, returnedAt: null }
  await db.transaction(
    'rw',
    [db.offlineSessions, db.buildings, db.devices, db.points, db.verdicts, db.rectifies],
    async () => {
      await db.offlineSessions.clear()
      await db.offlineSessions.put(session)
      await replaceBundleInTx(pkg.snapshot)
    }
  )
}

/** 事务内整体替换五表（调用方负责开启事务） */
async function replaceBundleInTx(bundle: TableBundle): Promise<void> {
  await Promise.all([
    db.buildings.clear(),
    db.devices.clear(),
    db.points.clear(),
    db.verdicts.clear(),
    db.rectifies.clear()
  ])
  await db.buildings.bulkPut(bundle.buildings)
  await db.devices.bulkPut(bundle.devices)
  await db.points.bulkPut(bundle.points)
  await db.verdicts.bulkPut(bundle.verdicts)
  await db.rectifies.bulkPut(bundle.rectifies)
}

/** 读取当前平板上的离线会话（单机单会话：只保留最近装载的一包） */
export async function getActiveSession(): Promise<OfflineSession | null> {
  const sessions = await db.offlineSessions.toCollection().sortBy('exportedAt')
  return sessions.length > 0 ? sessions[sessions.length - 1] : null
}

/** 平板清除离线会话（仅外业任务作废时使用，不影响业务数据） */
export async function clearActiveSession(): Promise<void> {
  await db.offlineSessions.clear()
}

/**
 * 外业结束生成回传包：保持 packageId / baseline 不变，snapshot 取平板当前五表现状。
 * 同时更新离线会话（会话里也留下 returnedAt），供页面提示任务状态。
 */
export async function buildReturnPackage(): Promise<OfflinePackageEnvelope> {
  const session = await getActiveSession()
  if (!session) {
    throw new Error('平板上没有离线会话：请先由单位导出离线包并在本机装载')
  }
  const current = await readTableBundle()
  const returned: OfflinePackageEnvelope = {
    ...session,
    snapshot: current,
    returnedAt: new Date().toISOString()
  }
  await db.offlineSessions.put(returned)
  return returned
}

/** 下载回传包（回单位导入的就是这个文件） */
export function downloadReturnPackage(pkg: OfflinePackageEnvelope): string {
  const stamp = (pkg.returnedAt ?? new Date().toISOString()).slice(0, 19).replace(/[:T]/g, '')
  const fileName = `gblightprot-return-${safeName(pkg.name)}-${stamp}.json`
  downloadJson(pkg, fileName)
  return fileName
}

/** 五表行数统计（会话 / 快照展示共用） */
export function countBundle(bundle: TableBundle): Record<OfflineTableKey, number> {
  const counts = { buildings: 0, devices: 0, points: 0, verdicts: 0, rectifies: 0 }
  OFFLINE_TABLE_KEYS.forEach((key) => {
    counts[key] = bundle[key].length
  })
  return counts
}

/** 空集合导出（供其他模块复用，避免循环依赖时直接 new） */
export { emptyTableBundle }
