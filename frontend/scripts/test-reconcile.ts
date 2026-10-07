/**
 * 三方对账纯逻辑场景测试（node 运行，不依赖 IndexedDB）：
 *   npx tsx scripts/test-reconcile.ts
 * 覆盖：导出基线、补录重编号沿用引用、单边改直接应用、两边都改留冲突、
 * 实测值改动触发判定重算、整改单状态保留、缺引用整包退回。
 */
import assert from 'node:assert/strict'
import { buildReconcilePlan, validatePackageReferences, resolveConflict, summarizePlan } from '../src/lib/utils/reconcile.ts'
import type { ReconcilePlan } from '../src/lib/utils/reconcile.ts'
import type { Building } from '../src/lib/types/building.ts'
import type { Device } from '../src/lib/types/device.ts'
import type { Point } from '../src/lib/types/point.ts'
import type { Verdict } from '../src/lib/types/verdict.ts'
import type { Rectify } from '../src/lib/types/rectify.ts'
import type { OfflinePackageEnvelope, TableBundle } from '../src/lib/types/offline.ts'

let passed = 0
function check(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`✓ ${name}`)
}

const now = Date.now()

function building(id: string, patch: Partial<Building> = {}): Building {
  return {
    id,
    name: `建筑-${id}`,
    usage: '油库',
    protectionClass: '二类',
    floors: 3,
    heightM: 12,
    address: '测试路 1 号',
    createdAt: now,
    updatedAt: now,
    ...patch
  }
}
function device(id: string, buildingId: string, patch: Partial<Device> = {}): Device {
  return {
    id,
    buildingId,
    type: '接地体',
    material: '热镀锌圆钢',
    spec: 'Φ12',
    quantity: 10,
    installDate: '2020-01-01',
    createdAt: now,
    updatedAt: now,
    ...patch
  }
}
function point(id: string, deviceId: string, patch: Partial<Point> = {}): Point {
  return {
    id,
    deviceId,
    code: `JD-${id}`,
    location: '测试点',
    measuredOhm: 3,
    limitOhm: 4,
    meter: 'ZC-8',
    measureDate: '2026-10-01',
    createdAt: now,
    updatedAt: now,
    ...patch
  }
}
function verdict(id: string, pointId: string, patch: Partial<Verdict> = {}): Verdict {
  return {
    id,
    pointId,
    result: '合格',
    basis: 'GB 50057-2010 第 4.4 节：二类防雷建筑物接地体接地电阻不大于 4 Ω',
    inspector: '陈立群',
    verdictDate: '2026-10-01',
    confirmed: true,
    createdAt: now,
    updatedAt: now,
    ...patch
  }
}
function rectify(id: string, buildingId: string, pointId: string | null, patch: Partial<Rectify> = {}): Rectify {
  return {
    id,
    buildingId,
    pointId,
    problem: '接地电阻实测值超过限值',
    suggestion: '增设接地极并复测',
    deadline: '2026-10-20',
    state: '待整改',
    owner: '王振海',
    createdAt: now,
    updatedAt: now,
    ...patch
  }
}

/** 标准主档案：1 建筑 / 1 装置 / 1 测点(合格) / 1 判定 / 1 整改单 */
function baseBundle(): TableBundle {
  const b = building('b1')
  const d = device('d1', 'b1')
  const p = point('p1', 'd1', { measuredOhm: 3, limitOhm: 4 })
  const v = verdict('v1', 'p1')
  const r = rectify('r1', 'b1', 'p1')
  return { buildings: [b], devices: [d], points: [p], verdicts: [v], rectifies: [r] }
}

function makePkg(baseline: TableBundle, snapshot: TableBundle): OfflinePackageEnvelope {
  return {
    app: 'gblightprot-offline',
    packageId: 'off_test1',
    dbVersion: 3,
    name: '测试任务',
    exportedAt: '2026-10-05T08:00:00.000Z',
    returnedAt: '2026-10-06T08:00:00.000Z',
    baseline,
    snapshot
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/* ------------------------------ 场景 ------------------------------ */

// 1. 无任何改动：不产生操作、不产生冲突
check('三方一致：零操作零冲突', () => {
  const master = baseBundle()
  const pkg = makePkg(clone(master), clone(master))
  const plan = buildReconcilePlan(pkg, master)
  assert.equal(plan.ops.length, 0)
  assert.equal(plan.conflicts.length, 0)
})

// 2. 外业单边改建筑物名：fast-forward 直接应用
check('离线单边改名：fast-forward', () => {
  const baseline = baseBundle()
  const master = baseBundle()
  const offline = baseBundle()
  offline.buildings[0].name = '外业改名建筑'
  offline.buildings[0].updatedAt = now + 1000
  const plan = buildReconcilePlan(makePkg(baseline, offline), master)
  assert.equal(plan.conflicts.length, 0)
  const ops = plan.ops.filter((op) => op.table === 'buildings')
  assert.equal(ops.length, 1)
  assert.equal(ops[0].kind, 'fast-forward')
  assert.equal((ops[0].row as unknown as Building).name, '外业改名建筑')
})

// 3. 仅主档案单边改：keep-master，不产生操作
check('主档案单边改：保留主档案', () => {
  const baseline = baseBundle()
  const master = baseBundle()
  master.buildings[0].name = '单位改名建筑'
  master.buildings[0].updatedAt = now + 2000
  const offline = baseBundle()
  const plan = buildReconcilePlan(makePkg(baseline, offline), master)
  assert.equal(plan.ops.length, 0)
  assert.equal(plan.conflicts.length, 0)
})

// 4. 两边都改建筑物：冲突待确认
check('两边都改：留成待确认冲突', () => {
  const baseline = baseBundle()
  const master = baseBundle()
  master.buildings[0].address = '单位改地址'
  master.buildings[0].updatedAt = now + 2000
  const offline = baseBundle()
  offline.buildings[0].name = '外业改名'
  offline.buildings[0].updatedAt = now + 3000
  const plan = buildReconcilePlan(makePkg(baseline, offline), master)
  assert.equal(plan.conflicts.length, 1)
  assert.equal(plan.conflicts[0].reason, 'both-edited')
  assert.equal(plan.conflicts[0].resolution, null)
})

// 5. 外业补录建筑物 + 装置 + 测点：重编新 id，引用链沿用
check('补录三级对象：重编号并沿用引用关系', () => {
  const baseline = baseBundle()
  const master = baseBundle()
  const offline = baseBundle()
  offline.buildings.push(building('b2'))
  offline.devices.push(device('d2', 'b2', { type: '引下线' }))
  offline.points.push(point('p2', 'd2', { measuredOhm: 8, limitOhm: 10 }))
  offline.verdicts.push(verdict('v2', 'p2', { result: '合格' }))
  offline.rectifies.push(rectify('r2', 'b2', null))
  const plan = buildReconcilePlan(makePkg(baseline, offline), master)
  assert.equal(plan.conflicts.length, 0)

  const bOp = plan.ops.find((op) => op.sourceId === 'b2')!
  const dOp = plan.ops.find((op) => op.sourceId === 'd2')!
  const pOp = plan.ops.find((op) => op.sourceId === 'p2')!
  assert.equal(bOp.kind, 'created-offline')
  assert.notEqual(bOp.targetId, 'b2')
  assert.ok(bOp.targetId.startsWith('bld_'))
  // 装置新行的 buildingId 必须指向重编后的建筑物
  assert.equal((dOp.row as unknown as Device).buildingId, bOp.targetId)
  // 测点新行的 deviceId 必须指向重编后的装置
  assert.equal((pOp.row as unknown as Point).deviceId, dOp.targetId)
  // 补录测点同样触发判定重算
  assert.ok(plan.rejudgePointIds.has(pOp.targetId))
})

// 6. 外业把测点实测值从 3 改成 12（限值 4）：测点 fast-forward + 判定 rejudge 为不合格
check('实测值改动：判定按最新限值重算', () => {
  const baseline = baseBundle()
  const master = baseBundle()
  const offline = baseBundle()
  offline.points[0].measuredOhm = 12
  offline.points[0].updatedAt = now + 1000
  offline.verdicts[0].result = '不合格'
  offline.verdicts[0].updatedAt = now + 1000
  const plan = buildReconcilePlan(makePkg(baseline, offline), master)
  // 判定不产生普通三方冲突，而是一条 rejudge 操作
  assert.equal(plan.conflicts.length, 0)
  const rejudge = plan.ops.filter((op) => Boolean(op.rejudge))
  assert.equal(rejudge.length, 1)
  assert.equal(rejudge[0].rejudge!.measuredOhm, 12)
  assert.equal(rejudge[0].rejudge!.limitOhm, 4)
  assert.equal(rejudge[0].targetId, 'v1') // 沿用主档案既有判定 id
  assert.equal(rejudge[0].rejudge!.inspector, '陈立群') // 检测人保留
  const stats = summarizePlan(plan)
  assert.equal(stats.rejudges, 1)
})

// 7. 整改单外业推进状态：fast-forward；且 rejudge 不动整改单
check('整改单跟踪状态随外业推进而保留 / 翻新判定不丢整改', () => {
  const baseline = baseBundle()
  const master = baseBundle()
  const offline = baseBundle()
  // 外业把测点改超限，并把整改单推进到已整改
  offline.points[0].measuredOhm = 12
  offline.points[0].updatedAt = now + 1000
  offline.verdicts[0].result = '不合格'
  offline.verdicts[0].updatedAt = now + 1000
  offline.rectifies[0].state = '已整改'
  offline.rectifies[0].updatedAt = now + 1000
  const plan = buildReconcilePlan(makePkg(baseline, offline), master)
  assert.equal(plan.conflicts.length, 0)
  const rOp = plan.ops.find((op) => op.sourceId === 'r1')!
  assert.equal(rOp.kind, 'fast-forward')
  assert.equal((rOp.row as unknown as Rectify).state, '已整改')
  // rejudge 操作不涉及 rectifies 表
  assert.ok(plan.ops.every((op) => !(op.rejudge && op.table === 'rectifies')))
})

// 8. 离线单边删除测点（主档案未动）：deleted-offline
check('离线删除：直接应用删除', () => {
  const baseline = baseBundle()
  const master = baseBundle()
  const offline = baseBundle()
  offline.points = []
  offline.verdicts = []
  offline.rectifies = []
  const plan = buildReconcilePlan(makePkg(baseline, offline), master)
  assert.equal(plan.conflicts.length, 0)
  const deleted = plan.ops.filter((op) => op.kind === 'deleted-offline').map((op) => op.sourceId).sort()
  assert.deepEqual(deleted, ['p1', 'r1', 'v1'])
})

// 9. 离线删除但主档案改过：冲突
check('离线删除撞上主档案编辑：冲突', () => {
  const baseline = baseBundle()
  const master = baseBundle()
  master.buildings[0].name = '单位改名'
  master.buildings[0].updatedAt = now + 2000
  const offline = baseBundle()
  offline.buildings = []
  offline.devices = []
  offline.points = []
  offline.verdicts = []
  offline.rectifies = []
  const plan = buildReconcilePlan(makePkg(baseline, offline), master)
  assert.ok(plan.conflicts.some((c) => c.reason === 'offline-delete-master-edited'))
})

// 10. 离线记录缺建筑物引用：整包退回
check('缺建筑物引用：整包校验退回', () => {
  const baseline = baseBundle()
  const offline = baseBundle()
  offline.devices[0] = { ...offline.devices[0], buildingId: 'missing' }
  const pkg = makePkg(baseline, offline)
  const errors = validatePackageReferences(pkg)
  assert.ok(errors.some((line) => line.includes('缺少建筑物引用')))
  const plan = buildReconcilePlan(pkg, baseBundle())
  assert.ok(plan.errors.length > 0)
  assert.equal(plan.ops.length, 0)
})

// 11. 判定缺测点引用：整包退回
check('缺测点引用：整包校验退回', () => {
  const baseline = baseBundle()
  const offline = baseBundle()
  offline.verdicts[0] = { ...offline.verdicts[0], pointId: 'no-such-point' }
  const errors = validatePackageReferences(makePkg(baseline, offline))
  assert.ok(errors.some((line) => line.includes('缺少测点引用')))
})

// 12. 冲突采用离线：生成 fast-forward 操作并标记解决
check('冲突解决-采用离线版本', () => {
  const baseline = baseBundle()
  const master = baseBundle()
  master.buildings[0].address = '单位地址'
  master.buildings[0].updatedAt = now + 2000
  const offline = baseBundle()
  offline.buildings[0].name = '外业名'
  offline.buildings[0].updatedAt = now + 3000
  const plan: ReconcilePlan = buildReconcilePlan(makePkg(baseline, offline), master)
  const key = plan.conflicts[0].key
  resolveConflict(plan, key, 'take-offline', { master })
  const conflict = plan.conflicts.find((c) => c.key === key)!
  assert.equal(conflict.resolution, 'take-offline')
  const op = plan.ops.find((o) => o.sourceId === 'b1' && o.fromConflict)!
  assert.equal((op.row as unknown as Building).name, '外业名')
})

// 13. 冲突保留主档案：不追加操作
check('冲突解决-保留主档案', () => {
  const baseline = baseBundle()
  const master = baseBundle()
  master.buildings[0].address = '单位地址'
  master.buildings[0].updatedAt = now + 2000
  const offline = baseBundle()
  offline.buildings[0].name = '外业名'
  offline.buildings[0].updatedAt = now + 3000
  const plan = buildReconcilePlan(makePkg(baseline, offline), master)
  const before = plan.ops.length
  resolveConflict(plan, plan.conflicts[0].key, 'keep-master', { master })
  assert.equal(plan.ops.length, before)
})

// 14. 主档案已删除、离线编辑：冲突；采用离线后作为新增重编号写回
check('离线编辑撞主档案删除：采用离线则重编号写回', () => {
  const baseline = baseBundle()
  const master = baseBundle()
  master.buildings = []
  master.devices = []
  master.points = []
  master.verdicts = []
  master.rectifies = []
  const offline = baseBundle()
  offline.buildings[0].name = '外业改名楼'
  offline.buildings[0].updatedAt = now + 3000
  const plan = buildReconcilePlan(makePkg(baseline, offline), master)
  assert.ok(plan.conflicts.some((c) => c.reason === 'offline-edit-master-deleted'))
  const buildingConflict = plan.conflicts.find((c) => c.table === 'buildings')!
  resolveConflict(plan, buildingConflict.key, 'take-offline', { master })
  const op = plan.ops.find((o) => o.sourceId === 'b1' && o.table === 'buildings')!
  assert.equal(op.kind, 'created-offline')
  assert.notEqual(op.targetId, 'b1')
})

console.log(`\n${passed} 个场景全部通过`)
