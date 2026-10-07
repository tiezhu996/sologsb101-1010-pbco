/**
 * 离线并回三方对账（纯函数，便于验证）：
 *
 *   baseline（出发时主档案基线）
 *   field   （回单位时平板一侧现状）
 *   master  （主档案当前现状）
 *
 * 对账规则：
 * - 基线没有、离线有：外业补录 → 重编编号并沿用原引用关系（building / device / point / rectify 四类）
 * - 仅离线一侧改过：直接应用；主档案一侧也改过：留成待确认
 * - 仅主档案改过：不动（保持主档案现值）；两侧一致：unchanged
 * - 基线有、两侧都没：主档案已处理过，不重复删除
 * - 接地电阻实测值改动：挂判定重算规格（应用时按主档案最新限值重算，原判定身份与整改单状态沿用）
 */
import { createId } from '$lib/utils/db'
import { renumberPointCode } from '$lib/utils/renumber'
import type { Building } from '$lib/types/building'
import type { Device } from '$lib/types/device'
import type { Point } from '$lib/types/point'
import type { Verdict } from '$lib/types/verdict'
import type { Rectify } from '$lib/types/rectify'
import type {
  ConflictDetail,
  CreateAction,
  DeleteAction,
  OfflineEntity,
  OfflinePackage,
  OfflineSnapshot,
  ReconcileAction,
  ReconcilePlan,
  RecomputeSpec,
  UpdateAction
} from '$lib/types/offline'

/** 参与对账的业务字段（时间戳不参与：任一侧写入都会刷新 updatedAt，不能误判为改动） */
export const FIELDS: Record<OfflineEntity, string[]> = {
  building: ['name', 'usage', 'protectionClass', 'floors', 'heightM', 'address'],
  device: ['buildingId', 'type', 'material', 'spec', 'quantity', 'installDate'],
  point: ['deviceId', 'code', 'location', 'measuredOhm', 'limitOhm', 'meter', 'measureDate'],
  rectify: ['buildingId', 'pointId', 'problem', 'suggestion', 'deadline', 'state', 'owner']
}

/** 业务字段中文名（待确认冲突展示用） */
export const FIELD_LABELS: Record<string, string> = {
  name: '名称',
  usage: '用途',
  protectionClass: '防雷类别',
  floors: '层数',
  heightM: '高度(m)',
  address: '地址',
  buildingId: '所属建筑物',
  type: '装置类型',
  material: '材质',
  spec: '规格',
  quantity: '数量',
  installDate: '安装日期',
  deviceId: '所属装置',
  code: '测点编号',
  location: '位置',
  measuredOhm: '实测电阻(Ω)',
  limitOhm: '限值(Ω)',
  meter: '检测仪器',
  measureDate: '检测日期',
  pointId: '关联测点',
  problem: '问题描述',
  suggestion: '建议措施',
  deadline: '建议期限',
  state: '整改状态',
  owner: '责任人',
  __deleted__: '记录已删除'
}

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field
}

/** 对象类型中文名 */
export const ENTITY_LABELS: Record<OfflineEntity, string> = {
  building: '建筑物',
  device: '防雷装置',
  point: '测点',
  rectify: '整改单'
}

function toMap<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]))
}

function pick(row: object, entity: OfflineEntity): Record<string, unknown> {
  const source = row as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const field of FIELDS[entity]) result[field] = source[field]
  return result
}

/** 两侧业务字段是否不同（按字段顺序逐项浅比较，NaN 不等的场景在电阻值上不存在） */
function diffFields(a: object, b: object, entity: OfflineEntity): string[] {
  const ar = a as Record<string, unknown>
  const br = b as Record<string, unknown>
  return FIELDS[entity].filter((field) => {
    const av = ar[field]
    const bv = br[field]
    if (av === bv) return false
    // 引用类字段可能为 null / ''，归一后比较
    return !(av === null && (bv === '' || bv === undefined)) && !(bv === null && (av === '' || av === undefined))
  })
}

function actionKey(entity: OfflineEntity, kind: string, refId: string): string {
  return `${entity}:${kind}:${refId}`
}

/** 找离线上某测点的判定（补录测点需要把判定一起带过来） */
function fieldVerdictOf(field: OfflineSnapshot, fieldPointId: string): Verdict | undefined {
  return field.verdicts.find((verdict) => verdict.pointId === fieldPointId)
}

/**
 * 校验离线现状的引用完整性。
 * 缺建筑物或测点引用（装置挂空建筑物、测点挂空装置、整改单挂空建筑物 / 空测点）时整包退回。
 */
export function validateOfflineReferences(pkg: OfflinePackage): string[] {
  const errors: string[] = []
  const { field } = pkg
  const buildings = toMap(field.buildings)
  const devices = toMap(field.devices)
  const points = toMap(field.points)

  for (const device of field.devices) {
    if (!buildings.has(device.buildingId)) {
      errors.push(`装置 ${device.id}（${device.type}）缺少建筑物引用 buildingId=${device.buildingId}`)
    }
  }
  for (const point of field.points) {
    if (!devices.has(point.deviceId)) {
      errors.push(`测点 ${point.code}（${point.id}）缺少装置引用 deviceId=${point.deviceId}`)
    }
  }
  for (const verdict of field.verdicts) {
    if (!points.has(verdict.pointId)) {
      errors.push(`判定 ${verdict.id} 缺少测点引用 pointId=${verdict.pointId}`)
    }
  }
  for (const rectify of field.rectifies) {
    // 建筑物引用是整改单的强制归属；测点引用可空（测点被删除后整改跟踪仍要保留）
    if (!buildings.has(rectify.buildingId)) {
      errors.push(`整改单 ${rectify.id} 缺少建筑物引用 buildingId=${rectify.buildingId}`)
    }
    if (
      rectify.pointId &&
      !points.has(rectify.pointId) &&
      // 允许「外业期间测点被删、整改单跟踪保留」的悬空引用；基线里根本不存在的 id 才是坏引用
      !pkg.baseline.points.some((point) => point.id === rectify.pointId)
    ) {
      errors.push(`整改单 ${rectify.id} 的测点引用 pointId=${rectify.pointId} 在基线与离线现状中均不存在`)
    }
  }
  return errors
}

/**
 * 离线现状与主档案之间的跨侧引用校验（结构校验通过后、生成对账计划前调用）。
 *
 * 离线记录内部的引用在 {@link validateOfflineReferences} 已保证完整；这里额外兜住
 * 「外业补录的子对象，其父对象在主档案一侧已被删除（且非外业补录）」这种跨侧悬挂——
 * 没有任何一侧能提供父对象，补录子对象无处挂接，按要求整包退回。
 */
export function validateCrossReferences(pkg: OfflinePackage, master: OfflineSnapshot): string[] {
  const errors: string[] = []
  const { baseline, field } = pkg
  const fieldBuildingIds = new Set(field.buildings.map((row) => row.id))
  const fieldDeviceIds = new Set(field.devices.map((row) => row.id))
  const fieldPointIds = new Set(field.points.map((row) => row.id))
  const masterBuildingIds = new Set(master.buildings.map((row) => row.id))
  const masterDeviceIds = new Set(master.devices.map((row) => row.id))
  const baselineBuildingIds = new Set(baseline.buildings.map((row) => row.id))
  const baselineDeviceIds = new Set(baseline.devices.map((row) => row.id))
  const baselinePointIds = new Set(baseline.points.map((row) => row.id))
  const baselineRectifyIds = new Set(baseline.rectifies.map((row) => row.id))

  for (const device of field.devices) {
    if (baselineDeviceIds.has(device.id)) continue
    const parentCreatedInField = fieldBuildingIds.has(device.buildingId)
    if (!parentCreatedInField && !masterBuildingIds.has(device.buildingId)) {
      errors.push(
        `补录装置 ${device.id}（${device.type}）引用的建筑物 ${device.buildingId} 在主档案已被删除，无法挂接，整包退回`
      )
    }
  }
  for (const point of field.points) {
    if (baselinePointIds.has(point.id)) continue
    const parentCreatedInField = fieldDeviceIds.has(point.deviceId)
    if (!parentCreatedInField && !masterDeviceIds.has(point.deviceId)) {
      errors.push(`补录测点 ${point.code}（${point.id}）引用的装置 ${point.deviceId} 在主档案已被删除，无法挂接，整包退回`)
    }
  }
  for (const rectify of field.rectifies) {
    if (baselineRectifyIds.has(rectify.id)) continue
    if (!fieldBuildingIds.has(rectify.buildingId) && !masterBuildingIds.has(rectify.buildingId)) {
      errors.push(`补录整改单 ${rectify.id} 引用的建筑物 ${rectify.buildingId} 在主档案已被删除，整包退回`)
    }
    if (rectify.pointId && !fieldPointIds.has(rectify.pointId) && !master.points.some((row) => row.id === rectify.pointId)) {
      errors.push(`补录整改单 ${rectify.id} 关联测点 ${rectify.pointId} 在主档案不存在（仅允许原测点被删的历史悬空），整包退回`)
    }
  }
  return errors
}

/**
 * 生成三方对账计划（不落库）。
 * 计划内的新 id / 测点编号在规划期一次性确定，因此同一份计划从断点反复执行结果稳定。
 */
export function reconcile(pkg: OfflinePackage, master: OfflineSnapshot): ReconcilePlan {
  const { baseline, field } = pkg
  const idMaps: ReconcilePlan['idMaps'] = { building: {}, device: {}, point: {}, rectify: {} }
  const counts = { create: 0, update: 0, delete: 0, conflict: 0, unchanged: 0 }

  /**
   * 把补丁 / 冲突展示值里的引用字段重映射到主档案 id。
   * 仅外业把对象挂到「外业补录父对象」这类极端场景命中；常规并回值恒等。
   */
  function remapValues(entity: OfflineEntity, values: Record<string, unknown>): Record<string, unknown> {
    const out = { ...values }
    if (entity === 'device' && typeof out.buildingId === 'string') {
      out.buildingId = idMaps.building[out.buildingId] ?? out.buildingId
    }
    if (entity === 'point' && typeof out.deviceId === 'string') {
      out.deviceId = idMaps.device[out.deviceId] ?? out.deviceId
    }
    if (entity === 'rectify') {
      if (typeof out.buildingId === 'string') out.buildingId = idMaps.building[out.buildingId] ?? out.buildingId
      if (typeof out.pointId === 'string') out.pointId = idMaps.point[out.pointId] ?? out.pointId
    }
    return out
  }

  /* ---------- 预分配补录对象的新 id（父 → 子），保证引用映射完整 ---------- */
  const baselineMaps = {
    building: toMap(baseline.buildings),
    device: toMap(baseline.devices),
    point: toMap(baseline.points),
    rectify: toMap(baseline.rectifies)
  }
  const fieldMaps = {
    building: toMap(field.buildings),
    device: toMap(field.devices),
    point: toMap(field.points),
    rectify: toMap(field.rectifies)
  }
  const masterMaps = {
    building: toMap(master.buildings),
    device: toMap(master.devices),
    point: toMap(master.points),
    rectify: toMap(master.rectifies)
  }

  const allocations: Array<{ entity: OfflineEntity; prefix: string; rows: Array<{ id: string }> }> = [
    { entity: 'building', prefix: 'bld', rows: field.buildings },
    { entity: 'device', prefix: 'dev', rows: field.devices },
    { entity: 'point', prefix: 'pnt', rows: field.points },
    { entity: 'rectify', prefix: 'rct', rows: field.rectifies }
  ]
  for (const { entity, prefix, rows } of allocations) {
    for (const row of rows) {
      // 基线存在（或主档案恰好同 id）视为既有对象；否则是外业补录，重编主键
      if (!baselineMaps[entity].has(row.id)) {
        let newId = createId(prefix)
        while (masterMaps[entity].has(newId)) newId = createId(prefix)
        idMaps[entity][row.id] = newId
      }
    }
  }

  /* ---------- 补录测点编号避让：按「装置 → 原编号」顺序逐个分配 ---------- */
  const codeByFieldPoint = new Map<string, string>()
  const newFieldPoints = field.points
    .filter((point) => idMaps.point[point.id])
    .sort((a, b) =>
      a.deviceId === b.deviceId
        ? a.code.localeCompare(b.code, 'zh-Hans-CN')
        : a.deviceId.localeCompare(b.deviceId, 'zh-Hans-CN')
    )
  const occupiedByDevice = new Map<string, Set<string>>()
  for (const point of newFieldPoints) {
    const mappedDeviceId = idMaps.device[point.deviceId] ?? point.deviceId
    let occupied = occupiedByDevice.get(mappedDeviceId)
    if (!occupied) {
      occupied = new Set(
        master.points.filter((item) => item.deviceId === mappedDeviceId).map((item) => item.code)
      )
      occupiedByDevice.set(mappedDeviceId, occupied)
    }
    const newCode = renumberPointCode(point.code, occupied)
    codeByFieldPoint.set(point.id, newCode)
  }

  const actions: ReconcileAction[] = []

  /** 对账单个既有对象（基线中存在的 id） */
  function diffExisting(
    entity: OfflineEntity,
    id: string,
    baseRow: { id: string },
    fieldRow: { id: string } | undefined,
    masterRow: { id: string } | undefined
  ): void {
    const base = pick(baseRow, entity)
    if (fieldRow === undefined && masterRow === undefined) {
      // 两侧都删：主档案已无此行，无需处理
      counts.unchanged += 1
      return
    }
    if (fieldRow === undefined) {
      // 离线删、主档案在
      if (masterRow === undefined) return
      const masterChanged = diffFields(pick(masterRow, entity), base, entity).length > 0
      if (masterChanged) {
        counts.conflict += 1
        actions.push({
          kind: 'conflict',
          entity,
          key: actionKey(entity, 'deleteReq', id),
          id,
          detail: {
            fields: ['__deleted__', ...diffFields(pick(masterRow, entity), base, entity)],
            baseline: base,
            master: pick(masterRow, entity),
            field: null
          }
        })
      } else {
        counts.delete += 1
        actions.push({ kind: 'delete', entity, key: actionKey(entity, 'delete', id), id })
      }
      return
    }
    if (masterRow === undefined) {
      // 主档案删、离线在（且离线改过 → 冲突；离线原封不动则接受主档案的删除，避免把已删对象捞回来）
      const fieldChanged = diffFields(pick(fieldRow, entity), base, entity).length > 0
      if (fieldChanged) {
        counts.conflict += 1
        actions.push({
          kind: 'conflict',
          entity,
          key: actionKey(entity, 'recall', id),
          id,
          detail: {
            fields: ['__deleted__', ...diffFields(pick(fieldRow, entity), base, entity)],
            baseline: base,
            master: null,
            field: remapValues(entity, pick(fieldRow, entity)),
            fieldRow,
            // 测点重建时沿用原判定的检测人（判定本身按最新限值重算）
            fieldVerdict: entity === 'point' ? fieldVerdictOf(field, id) : undefined
          }
        })
      } else {
        counts.unchanged += 1
      }
      return
    }
    // 两侧都在
    const fieldChanges = diffFields(pick(fieldRow, entity), base, entity)
    const masterChanges = diffFields(pick(masterRow, entity), base, entity)
    if (fieldChanges.length === 0 && masterChanges.length === 0) {
      counts.unchanged += 1
      return
    }
    const overlap = fieldChanges.filter((fieldName) => masterChanges.includes(fieldName))
    if (fieldChanges.length === 0) {
      counts.unchanged += 1 // 只有主档案改过：保持主档案
      return
    }
    if (masterChanges.length === 0) {
      // 仅离线一侧改过：直接应用
      counts.update += 1
      const patch: Record<string, unknown> = {}
      for (const fieldName of fieldChanges) patch[fieldName] = pick(fieldRow, entity)[fieldName]
      const action: UpdateAction = {
        kind: 'update',
        entity,
        key: actionKey(entity, 'update', id),
        id,
        patch: remapValues(entity, patch)
      }
      if (entity === 'point' && fieldChanges.includes('measuredOhm')) {
        action.recompute = recomputeFor(fieldRow as unknown as Point, id, fieldVerdictOf(field, id))
      }
      actions.push(action)
      return
    }
    if (overlap.length === 0) {
      // 两侧改的是不同字段：离线补丁仍按单边应用（主档案改动不受影响）
      counts.update += 1
      const patch: Record<string, unknown> = {}
      for (const fieldName of fieldChanges) patch[fieldName] = pick(fieldRow, entity)[fieldName]
      const action: UpdateAction = {
        kind: 'update',
        entity,
        key: actionKey(entity, 'update', id),
        id,
        patch: remapValues(entity, patch)
      }
      if (entity === 'point' && fieldChanges.includes('measuredOhm') && !masterChanges.includes('measuredOhm')) {
        action.recompute = recomputeFor(fieldRow as unknown as Point, id, fieldVerdictOf(field, id))
      }
      actions.push(action)
      return
    }
    // 同一字段两侧都改过：待确认
    counts.conflict += 1
    const detail: ConflictDetail = {
      fields: overlap,
      baseline: base,
      master: pick(masterRow, entity),
      field: remapValues(entity, pick(fieldRow, entity))
    }
    actions.push({ kind: 'conflict', entity, key: actionKey(entity, 'conflict', id), id, detail })
  }

  function recomputeFor(fieldPoint: Point, masterPointId: string, existing?: Verdict): RecomputeSpec {
    return {
      pointId: masterPointId,
      verdictId: existing?.id ?? `vrd_${masterPointId}`,
      inspector: existing?.inspector ?? pkg.inspector,
      verdictDate: fieldPoint.measureDate
    }
  }

  /** 补录对象 create 动作（引用映射 + 测点编号重编） */
  function buildCreate(entity: OfflineEntity, fieldRow: Record<string, unknown>): CreateAction {
    const newId = idMaps[entity][String(fieldRow.id)]
    const row: Record<string, unknown> = { ...fieldRow, id: newId }
    const baseCreate = (): CreateAction => ({ kind: 'create', entity, key: actionKey(entity, 'create', newId), newId, row })

    if (entity === 'device') {
      row.buildingId = idMaps.building[String(fieldRow.buildingId)] ?? fieldRow.buildingId
      return baseCreate()
    }
    if (entity === 'point') {
      row.deviceId = idMaps.device[String(fieldRow.deviceId)] ?? fieldRow.deviceId
      const renumberedCode = codeByFieldPoint.get(String(fieldRow.id))
      if (renumberedCode) {
        row.code = renumberedCode
      }
      const action = baseCreate()
      action.renumbered = renumberedCode !== undefined && renumberedCode !== fieldRow.code
      const existing = fieldVerdictOf(field, String(fieldRow.id))
      action.recompute = {
        pointId: newId,
        verdictId: `vrd_${newId}`,
        inspector: existing?.inspector ?? pkg.inspector,
        verdictDate: String(row.measureDate ?? '')
      }
      return action
    }
    if (entity === 'rectify') {
      row.buildingId = idMaps.building[String(fieldRow.buildingId)] ?? fieldRow.buildingId
      row.pointId = fieldRow.pointId ? idMaps.point[String(fieldRow.pointId)] ?? fieldRow.pointId : null
      return baseCreate()
    }
    return baseCreate()
  }

  /* ---------- 建筑物 → 装置 → 测点 → 整改单 有序产出 ---------- */

  // 建筑物
  for (const building of field.buildings) {
    if (idMaps.building[building.id]) {
      counts.create += 1
      actions.push(buildCreate('building', building as unknown as Record<string, unknown>))
    }
  }
  for (const [id, baseRow] of baselineMaps.building) {
    diffExisting('building', id, baseRow, fieldMaps.building.get(id), masterMaps.building.get(id))
  }

  // 装置（补录装置必须排在其建筑物补录之后）
  for (const device of field.devices) {
    if (idMaps.device[device.id]) {
      counts.create += 1
      actions.push(buildCreate('device', device as unknown as Record<string, unknown>))
    }
  }
  for (const [id, baseRow] of baselineMaps.device) {
    diffExisting('device', id, baseRow, fieldMaps.device.get(id), masterMaps.device.get(id))
  }

  // 测点（补录测点排在装置补录之后；编号已按装置避让）
  for (const point of newFieldPoints) {
    counts.create += 1
    actions.push(buildCreate('point', point as unknown as Record<string, unknown>))
  }
  for (const [id, baseRow] of baselineMaps.point) {
    diffExisting('point', id, baseRow, fieldMaps.point.get(id), masterMaps.point.get(id))
  }

  // 整改单（原跟踪状态随记录直接保留，不翻新）
  for (const rectify of field.rectifies) {
    if (idMaps.rectify[rectify.id]) {
      counts.create += 1
      actions.push(buildCreate('rectify', rectify as unknown as Record<string, unknown>))
    }
  }
  for (const [id, baseRow] of baselineMaps.rectify) {
    diffExisting('rectify', id, baseRow, fieldMaps.rectify.get(id), masterMaps.rectify.get(id))
  }

  return { idMaps, actions, counts }
}

/** 计划内的删除动作是否会级联波及某测点（建筑物 / 装置删除连带测点） */
export function cascadeDeletedPointIds(plan: ReconcilePlan, master: OfflineSnapshot): Set<string> {
  const deletedBuildingIds = new Set<string>()
  const deletedDeviceIds = new Set<string>()
  for (const action of plan.actions) {
    if (action.kind !== 'delete') continue
    if (action.entity === 'building') deletedBuildingIds.add(action.id)
    if (action.entity === 'device') deletedDeviceIds.add(action.id)
  }
  const result = new Set<string>()
  for (const device of master.devices) {
    if (deletedBuildingIds.has(device.buildingId)) deletedDeviceIds.add(device.id)
  }
  for (const point of master.points) {
    if (deletedDeviceIds.has(point.deviceId)) result.add(point.id)
  }
  return result
}
