/**
 * 导入执行层端到端测试（fake-indexeddb 模拟浏览器环境）：
 *   npx tsx scripts/test-import.ts
 * 覆盖：直接应用、判定重算落库且整改单不动、同包重复导入只算一次、
 * 写入失败中断后从断点继续、恢复点回滚、缺引用整包退回且不写业务表、冲突解决。
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { db, initDatabase, seedDemoData } from '../src/lib/utils/db.ts'
import {
  importOfflinePackage,
  resumeImport,
  rollbackImport,
  resolveImportConflict,
  getImportRun
} from '../src/lib/utils/offlineImport.ts'
import type { OfflinePackageEnvelope } from '../src/lib/types/offline.ts'
import type { Point } from '../src/lib/types/point.ts'

let passed = 0
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn()
  passed += 1
  console.log(`✓ ${name}`)
}

async function freshDb(): Promise<void> {
  await db.open()
  await Promise.all(
    [
      db.buildings,
      db.devices,
      db.points,
      db.verdicts,
      db.rectifies,
      db.offlineSessions,
      db.importRuns,
      db.importSnapshots
    ].map((table) => table.clear())
  )
}

/** 用当前主档案构造「出发前」离线包 */
async function makeFreshPackage(packageId = 'off_e2e1', name = '端到端任务'): Promise<OfflinePackageEnvelope> {
  const bundle = {
    buildings: await db.buildings.toArray(),
    devices: await db.devices.toArray(),
    points: await db.points.toArray(),
    verdicts: await db.verdicts.toArray(),
    rectifies: await db.rectifies.toArray()
  }
  return {
    app: 'gblightprot-offline',
    packageId,
    dbVersion: 3,
    name,
    exportedAt: '2026-10-05T08:00:00.000Z',
    returnedAt: '2026-10-06T08:00:00.000Z',
    baseline: structuredClone(bundle),
    snapshot: structuredClone(bundle)
  }
}

async function run(): Promise<void> {
  await initDatabase()
  await freshDb()
  await seedDemoData()

  /* 1. 外业补录一栋新建筑 + 装置 + 测点 */
  await check('补录对象：重编号导入后可按新引用链查到', async () => {
    const pkg = await makeFreshPackage('off_add')
    const now = Date.now()
    pkg.snapshot.buildings.push({
      id: 'bld_new1',
      name: '外业新登记泵房',
      usage: '泵房',
      protectionClass: '三类',
      floors: 1,
      heightM: 5,
      address: '厂区东北角',
      createdAt: now,
      updatedAt: now
    })
    pkg.snapshot.devices.push({
      id: 'dev_new1',
      buildingId: 'bld_new1',
      type: '接闪杆',
      material: '不锈钢',
      spec: 'Φ20',
      quantity: 2,
      installDate: '2026-09-01',
      createdAt: now,
      updatedAt: now
    })
    pkg.snapshot.points.push({
      id: 'pnt_new1',
      deviceId: 'dev_new1',
      code: 'JD-NEW-01',
      location: '泵房西侧',
      measuredOhm: 6.5,
      limitOhm: 10,
      meter: 'ZC-8',
      measureDate: '2026-10-06',
      createdAt: now,
      updatedAt: now
    })
    const beforeCounts = {
      buildings: await db.buildings.count(),
      devices: await db.devices.count(),
      points: await db.points.count()
    }
    const outcome = await importOfflinePackage(pkg)
    assert.equal(outcome.duplicated, false)
    assert.equal(outcome.run.status, 'completed')
    assert.equal(await db.buildings.count(), beforeCounts.buildings + 1)
    assert.equal(await db.devices.count(), beforeCounts.devices + 1)
    assert.equal(await db.points.count(), beforeCounts.points + 1)

    const newBuilding = await db.buildings.where('name').equals('外业新登记泵房').first()
    assert.ok(newBuilding)
    assert.notEqual(newBuilding!.id, 'bld_new1')
    const newDevice = await db.devices.where('spec').equals('Φ20').first()
    assert.equal(newDevice!.buildingId, newBuilding!.id)
    const newPoint = await db.points.where('code').equals('JD-NEW-01').first()
    assert.equal(newPoint!.deviceId, newDevice!.id)
    const newVerdicts = await db.verdicts.where('pointId').equals(newPoint!.id).toArray()
    assert.equal(newVerdicts.length, 1)
    assert.equal(newVerdicts[0].result, '合格')
    assert.equal(newVerdicts[0].confirmed, false, '重算判定需重新确认')
  })

  /* 2. 同一个包重复导入只算一次 */
  await check('同包重复导入：幂等不重复写入', async () => {
    const pkg = await makeFreshPackage('off_dup')
    const buildingsBefore = await db.buildings.count()
    await importOfflinePackage(pkg)
    const second = await importOfflinePackage(pkg)
    assert.equal(second.duplicated, true)
    assert.equal(await db.buildings.count(), buildingsBefore)
  })

  /* 3. 实测值改动 → 判定重算；整改单跟踪状态保留 */
  await check('判定重算落库：结果翻新、confirmed 重置、整改单状态不动', async () => {
    const pkg = await makeFreshPackage('off_judge')
    const rectify = pkg.baseline.rectifies.find((r) => r.pointId)!
    assert.ok(rectify, '演示数据应存在带测点的整改单')
    const targetPointId = rectify.pointId!
    const targetPoint = pkg.snapshot.points.find((p) => p.id === targetPointId)!
    targetPoint.measuredOhm = 2
    targetPoint.updatedAt = Date.now()
    const v = pkg.snapshot.verdicts.find((item) => item.pointId === targetPointId)
    if (v) {
      v.result = '合格'
      v.updatedAt = Date.now()
    }

    const outcome = await importOfflinePackage(pkg)
    assert.equal(outcome.run.status, 'completed')
    const verdictRow = await db.verdicts.where('pointId').equals(targetPointId).first()
    assert.equal(verdictRow!.result, '合格', '应按最新值重算为合格')
    assert.equal(verdictRow!.confirmed, false, '重算后待人工确认')
    assert.equal(verdictRow!.inspector, '陈立群', '检测人沿用')
    const rectifyAfter = await db.rectifies.get(rectify.id)
    assert.equal(rectifyAfter!.state, rectify.state, '判定翻新不能丢掉整改跟踪状态')
  })

  /* 4. 引用缺失整包退回，业务表一行不动 */
  await check('缺引用整包退回：零业务写入、批次留档为 rejected', async () => {
    const pkg = await makeFreshPackage('off_reject')
    const countsBefore = {
      buildings: await db.buildings.count(),
      devices: await db.devices.count(),
      points: await db.points.count(),
      verdicts: await db.verdicts.count(),
      rectifies: await db.rectifies.count()
    }
    ;(pkg.snapshot.points[0] as Point).deviceId = 'not-exist-device'
    const outcome = await importOfflinePackage(pkg)
    assert.equal(outcome.run.status, 'rejected')
    assert.ok(outcome.run.errors.some((line) => line.includes('缺少装置引用')))
    assert.ok(outcome.run.snapshotId, '退回也保留恢复点')
    assert.equal(await db.buildings.count(), countsBefore.buildings)
    assert.equal(await db.devices.count(), countsBefore.devices)
    assert.equal(await db.points.count(), countsBefore.points)
    assert.equal(await db.verdicts.count(), countsBefore.verdicts)
    assert.equal(await db.rectifies.count(), countsBefore.rectifies)
  })

  /* 5. 两边都改 → 冲突；采用离线后批次完成 */
  await check('两边都改留冲突：解决采用离线后收束完成', async () => {
    const pkg = await makeFreshPackage('off_conflict')
    const firstBuildingId = pkg.baseline.buildings[0].id
    await db.buildings.update(firstBuildingId, { address: '单位刚更新的地址', updatedAt: Date.now() })
    const offlineBuilding = pkg.snapshot.buildings.find((b) => b.id === firstBuildingId)!
    offlineBuilding.name = '外业改的建筑名'
    offlineBuilding.updatedAt = Date.now() + 1000

    const outcome = await importOfflinePackage(pkg)
    assert.equal(outcome.run.status, 'planned')
    assert.equal(outcome.run.conflicts.length, 1)
    const mid = await db.buildings.get(firstBuildingId)
    assert.equal(mid!.address, '单位刚更新的地址')

    const conflictKey = outcome.run.conflicts[0].key
    const finished = await resolveImportConflict(pkg.packageId, conflictKey, 'take-offline')
    assert.equal(finished.status, 'completed')
    const finalRow = await db.buildings.get(firstBuildingId)
    assert.equal(finalRow!.name, '外业改的建筑名')
  })

  /* 6. 恢复点回滚 */
  await check('回滚：主档案恢复到导入前状态', async () => {
    const pkg = await makeFreshPackage('off_rollback')
    const before = (await db.buildings.toArray()).map((b) => [b.id, b.name])
    pkg.snapshot.buildings[0].name = '回滚测试-外业名'
    pkg.snapshot.buildings[0].updatedAt = Date.now()
    const outcome = await importOfflinePackage(pkg)
    assert.equal(outcome.run.status, 'completed')
    const rolled = await rollbackImport(pkg.packageId)
    assert.equal(rolled.status, 'rolled-back')
    const after = (await db.buildings.toArray()).map((b) => [b.id, b.name])
    assert.deepEqual(after, before)
  })

  /* 7. 回滚后重新导入同一包 */
  await check('回滚后重新导入：按首次导入执行', async () => {
    const pkg = await makeFreshPackage('off_rollback2')
    pkg.snapshot.buildings[0].name = '重新导入-外业名'
    pkg.snapshot.buildings[0].updatedAt = Date.now()
    await importOfflinePackage(pkg)
    await rollbackImport(pkg.packageId)
    const again = await importOfflinePackage(pkg)
    assert.equal(again.duplicated, false)
    assert.equal(again.run.status, 'completed')
    assert.equal((await db.buildings.get(pkg.snapshot.buildings[0].id))!.name, '重新导入-外业名')
  })

  /* 8. 写入失败中断 → 断点续传（故障注入：写入第 40 次 put 时抛错一次） */
  await check('写入失败：从断点继续后完成且无重复写入', async () => {
    const pkg = await makeFreshPackage('off_resume')
    const base = Date.now()
    for (let i = 0; i < 60; i += 1) {
      pkg.snapshot.buildings.push({
        id: `bld_resume_${i}`,
        name: `断点测试建筑 ${i}`,
        usage: '断点测试用途',
        protectionClass: '三类',
        floors: 1,
        heightM: 3,
        address: '断点测试',
        createdAt: base + i,
        updatedAt: base + i
      })
    }

    const originalPut = db.buildings.put.bind(db.buildings)
    let callCount = 0
    let failedOnce = false
    db.buildings.put = (async (row: unknown) => {
      callCount += 1
      if (!failedOnce && callCount === 40) {
        failedOnce = true
        throw new Error('模拟磁盘写入失败')
      }
      return originalPut(row as never)
    }) as typeof originalPut

    const failed = await importOfflinePackage(pkg)
    db.buildings.put = originalPut
    assert.equal(failed.run.status, 'failed', '首次导入应记录为中断')
    assert.ok(failed.run.ops.some((op) => op.applied), '应有已处理记录作为断点')
    assert.ok(failed.run.snapshotId, '恢复点已留下')

    const resumed = await resumeImport(pkg.packageId)
    assert.equal(resumed.run.status, 'completed')
    assert.ok(resumed.resumed)
    const imported = await db.buildings.where('usage').equals('断点测试用途').toArray()
    assert.equal(imported.length, 60, '60 栋全部到位且无重复')
    const stored = await getImportRun(pkg.packageId)
    assert.equal(stored!.attempts.length, 2, '首次 + 续传共两次尝试')
  })

  console.log(`\n${passed} 个端到端场景全部通过`)
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
