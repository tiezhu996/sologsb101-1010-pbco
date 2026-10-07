<script lang="ts">
  /**
   * 模块 6：/offline 外业离线采集并回
   *
   * 出发前导出带主档案基线与各对象引用的离线包；外业期间平板离线增删改由操作流水记录；
   * 回单位导入时按「基线 / 主档案现状 / 离线现状」三方对账：
   *   单边改过 → 直接应用；两边都改过 → 留成待确认；补录对象 → 重编编号并沿用引用关系。
   * 实测电阻改动按最新限值重算判定、整改单跟踪状态保留；同包重复导入只算一次；
   * 引用缺失整包退回；写入失败保留恢复点与断点，可继续或回滚。
   */
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte'
  import StatBadge from '$lib/components/common/StatBadge.svelte'
  import { activeSession, importRunList } from '$lib/stores/offlineSyncStore.ts'
  import { buildingList } from '$lib/stores/buildingStore.ts'
  import {
    checkoutOfflinePackage,
    discardFieldSession,
    downloadOfflinePackage,
    sealOfflinePackage,
    importOfflinePackage,
    recordRejected,
    resumeImport,
    resolveConflict,
    rollbackImport,
    pendingConflictsOf,
    validateOfflinePackage
  } from '$lib/utils/offlineSync.ts'
  import { readFileText } from '$lib/utils/export.ts'
  import { ENTITY_LABELS, fieldLabel } from '$lib/utils/reconcile.ts'
  import { DB_VERSION } from '$lib/utils/db.ts'
  import type { ConflictAction, ImportRun, OfflinePackage } from '$lib/types/offline.ts'

  let inspector = $state('陈立群')
  let busy = $state(false)
  let notice = $state<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function flash(text: string, tone: 'ok' | 'err' = 'ok'): void {
    notice = { tone, text }
  }

  async function handleCheckout(): Promise<void> {
    busy = true
    try {
      const state = await checkoutOfflinePackage(inspector)
      flash(`已导出离线包基线（${state.pkgId}）。现在可携带平板外业，期间的新增 / 修改 / 删除都会记入操作流水。`)
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error), 'err')
    } finally {
      busy = false
    }
  }

  async function handleSealAndDownload(): Promise<void> {
    busy = true
    try {
      const pkg = await sealOfflinePackage()
      const fileName = downloadOfflinePackage(pkg)
      flash(`已封盘并下载离线包 ${fileName}，可在本页下半区导入并回主档案。`)
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error), 'err')
    } finally {
      busy = false
    }
  }

  async function handleDiscard(): Promise<void> {
    const ok = window.confirm('放弃当前外业作业将清除基线与操作流水（主档案台账数据不受影响）。确认？')
    if (!ok) return
    busy = true
    try {
      await discardFieldSession()
      flash('已放弃外业作业。')
    } finally {
      busy = false
    }
  }

  async function handleImportFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    busy = true
    try {
      const text = await readFileText(file)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        flash('文件不是合法的 JSON，无法解析。', 'err')
        return
      }
      const validation = validateOfflinePackage(parsed)
      if (!validation.ok || !validation.pkg) {
        // 结构错误无法定位 pkgId 的不写运行记录；引用类退回保留记录与恢复点信息
        flash(`离线包整包退回：${validation.errors.join('；')}`, 'err')
        const pkg = (parsed as Partial<OfflinePackage> | null) &&
        typeof parsed === 'object' && parsed !== null && typeof (parsed as OfflinePackage).pkgId === 'string'
          ? (parsed as OfflinePackage)
          : null
        if (pkg && pkg.app === 'gblightprot-offline') await recordRejected(pkg, file.name, validation.errors)
        return
      }
      const outcome = await importOfflinePackage(validation.pkg, file.name)
      if (outcome.duplicate) {
        flash(`该离线包已导入过（状态：${statusText(outcome.run.status)}），同一个包只算一次，未重复写入。`)
        return
      }
      if (outcome.run.status === 'rejected') {
        flash(`离线包整包退回：${outcome.run.errors.join('；')}`, 'err')
        return
      }
      const c = outcome.plan.counts
      const summary = `新增 ${c.create}、更新 ${c.update}、删除 ${c.delete}、待确认 ${c.conflict}、无需处理 ${c.unchanged}`
      flash(
        outcome.run.status === 'paused'
          ? `部分写入失败，已处理记录与恢复点保留，可从断点继续。${summary}`
          : outcome.run.status === 'pending'
            ? `导入完成，仍有 ${c.conflict} 条两侧都改过的记录待确认。${summary}`
            : `导入完成：${summary}。`,
        outcome.run.status === 'paused' ? 'err' : 'ok'
      )
      if (outcome.run.status === 'paused' && outcome.run.lastError) flash(`写入失败：${outcome.run.lastError}`, 'err')
    } finally {
      busy = false
      input.value = ''
    }
  }

  async function handleResume(run: ImportRun): Promise<void> {
    busy = true
    try {
      const updated = await resumeImport(run.id)
      flash(
        updated.status === 'paused'
          ? `仍有写入失败：${updated.lastError ?? '未知错误'}`
          : updated.status === 'pending'
            ? '断点续跑完成，仍有待确认冲突。'
            : '已从断点继续并全部处理完成。',
        updated.status === 'paused' ? 'err' : 'ok'
      )
    } finally {
      busy = false
    }
  }

  async function handleRollback(run: ImportRun): Promise<void> {
    const ok = window.confirm('将用导入前恢复点把建筑物 / 装置 / 测点 / 判定 / 整改单整体还原到导入前状态。确认？')
    if (!ok) return
    busy = true
    try {
      await rollbackImport(run.id)
      flash('已恢复到导入前状态。')
    } finally {
      busy = false
    }
  }

  async function handleResolve(run: ImportRun, conflict: ConflictAction, winner: 'master' | 'field'): Promise<void> {
    busy = true
    try {
      const updated = await resolveConflict(run.id, conflict.key, { winner })
      flash(updated.status === 'resolved' ? '全部待确认冲突已处理。' : '已记录该条选择，继续处理其余冲突。')
    } finally {
      busy = false
    }
  }

  const STATUS_TEXT: Record<ImportRun['status'], string> = {
    rejected: '整包退回',
    applied: '已全部应用',
    paused: '写入失败·断点保留',
    pending: '待确认冲突',
    resolved: '冲突已处理完',
    rolledback: '已回滚'
  }
  function statusText(status: ImportRun['status']): string {
    return STATUS_TEXT[status]
  }

  function pendingOf(run: ImportRun): ConflictAction[] {
    return pendingConflictsOf(run)
  }

  function formatValue(value: unknown): string {
    if (value === null || value === undefined) return '—'
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  }

  function resolveTitle(conflict: ConflictAction): string {
    const fieldValue = conflict.detail.fieldRow
    if (fieldValue) return `主档案已删除此${ENTITY_LABELS[conflict.entity]}，离线一侧仍保留并修改`
    if (conflict.detail.field === null) return `离线一侧删除了此${ENTITY_LABELS[conflict.entity]}，主档案做过修改`
    return `${ENTITY_LABELS[conflict.entity]}两侧都改过`
  }

  const totalPending = $derived(
    $importRunList.reduce((sum, run) => sum + pendingOf(run).length, 0)
  )
</script>

<section class="page">
  <div class="gb-brand-bar"></div>

  <div class="page__head">
    <div>
      <h2 class="page__title">外业离线采集并回</h2>
      <p class="gb-hint">
        出发前导出带对象引用与主档案基线的离线包，平板离线采集建筑物 / 防雷装置 / 测点 / 整改单，
        回单位后按基线与两侧现状三方对账并回。
      </p>
    </div>
  </div>

  {#if notice}
    <p class="gb-alert" class:is-err={notice.tone === 'err'}>{notice.text}</p>
  {/if}

  <!-- ① 导出离线包 -->
  <div class="gb-panel">
    <div class="gb-panel-title">
      <h3>① 出发前导出离线包</h3>
      <span class="gb-hint">基线冻结后，台账页的增删改即视为外业采集并记入流水</span>
    </div>

    {#if $activeSession}
      <div class="gb-alert">
        外业作业进行中：<span class="gb-mono">{$activeSession.pkgId}</span>
        · 检测人 {$activeSession.inspector || '未署名'}
        · 导出时间 {new Date($activeSession.checkedOutAt).toLocaleString('zh-CN')}
        · 基线含 {$activeSession.baseline.points.length} 个测点
      </div>
      <div class="action-row">
        <button class="btn btn--primary" type="button" disabled={busy} onclick={handleSealAndDownload}>
          回单位封盘并下载离线包
        </button>
        <button class="btn btn--danger" type="button" disabled={busy} onclick={handleDiscard}>放弃本次作业</button>
      </div>
      <p class="gb-hint">
        封盘前请在「测点录入 / 判定整改」等页面完成外业补录；封盘会读取平板现状与操作流水并结束作业。
      </p>
    {:else}
      <div class="action-row">
        <label class="gb-field">
          <span>外业检测人</span>
          <input bind:value={inspector} placeholder="检测人姓名" />
        </label>
        <button class="btn btn--primary" type="button" disabled={busy || !inspector.trim()} onclick={handleCheckout}>
          导出离线包（冻结基线）
        </button>
      </div>
      <p class="gb-hint">
        当前主档案：{$buildingList.length} 栋建筑物。基线冻结后，离线包编号写入本地，同一包重复导入只算一次。
      </p>
    {/if}
  </div>

  <!-- ② 导入并回 -->
  <div class="gb-panel">
    <div class="gb-panel-title">
      <h3>② 回单位导入离线包</h3>
      <span class="gb-hint">单边改动直接应用；两边都改过留待确认；缺建筑物 / 测点引用整包退回</span>
    </div>
    <div class="action-row">
      <label class="gb-field">
        <span>选择离线包 JSON</span>
        <input type="file" accept="application/json" disabled={busy} onchange={handleImportFile} />
      </label>
    </div>
    <div class="gb-stats-row">
      <StatBadge label="待确认冲突" value={totalPending} suffix="条" tone={totalPending > 0 ? 'danger' : 'success'} />
    </div>
  </div>

  <!-- ③ 待确认冲突 -->
  {#each $importRunList.filter((run) => pendingOf(run).length > 0) as run (run.id + ':conflicts')}
    <div class="gb-panel">
      <div class="gb-panel-title">
        <h3>③ 待确认 · {run.pkgName}</h3>
        <span class="gb-hint">{run.inspector} · 导入于 {new Date(run.importedAt).toLocaleString('zh-CN')}</span>
      </div>
      {#each pendingOf(run) as conflict (conflict.key)}
        <div class="conflict">
          <div class="conflict__title">{resolveTitle(conflict)}</div>
          <table class="gb-table">
            <thead>
              <tr>
                <th>字段</th>
                <th>基线（出发时）</th>
                <th>主档案现状</th>
                <th>离线现状</th>
              </tr>
            </thead>
            <tbody>
              {#each conflict.detail.fields as fieldName (fieldName)}
                <tr>
                  <th>{fieldLabel(fieldName)}</th>
                  <td class="gb-mono">{formatValue(conflict.detail.baseline[fieldName])}</td>
                  <td class="gb-mono">
                    {conflict.detail.master ? formatValue(conflict.detail.master[fieldName]) : '（已删除）'}
                  </td>
                  <td class="gb-mono">
                    {conflict.detail.field ? formatValue(conflict.detail.field[fieldName]) : '（已删除）'}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          <div class="action-row">
            <button class="btn" type="button" disabled={busy} onclick={() => handleResolve(run, conflict, 'master')}>
              采用主档案
            </button>
            <button class="btn btn--primary" type="button" disabled={busy} onclick={() => handleResolve(run, conflict, 'field')}>
              采用离线值
            </button>
          </div>
          <p class="gb-hint">
            采用离线值后实测电阻会按主档案最新限值重算判定；原整改单跟踪状态保留，不会因判定翻新丢失。
          </p>
        </div>
      {/each}
    </div>
  {/each}

  <!-- ④ 导入记录 / 断点 / 恢复点 -->
  <div class="gb-panel">
    <div class="gb-panel-title">
      <h3>④ 导入记录、断点与恢复点</h3>
      <span class="gb-hint">写入失败可从断点继续，或整体回滚到导入前状态（结构版本 v{DB_VERSION}）</span>
    </div>
    {#if $importRunList.length === 0}
      <EmptyPanel title="还没有导入记录" description="导出并封盘离线包后，在上方选择文件导入。" compact />
    {:else}
      <table class="gb-table">
        <thead>
          <tr>
            <th>离线包</th>
            <th>状态</th>
            <th>对账结果（增/改/删/冲突/一致）</th>
            <th>断点</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {#each $importRunList as run (run.id)}
            <tr>
              <td>
                <div class="gb-mono">{run.pkgName}</div>
                <div class="gb-hint">{run.errors.length > 0 ? run.errors.join('；') : run.inspector || '—'}</div>
              </td>
              <td><span class="gb-tag">{statusText(run.status)}</span></td>
              <td class="gb-mono">
                {run.plan.counts.create} / {run.plan.counts.update} / {run.plan.counts.delete} /
                {run.plan.counts.conflict} / {run.plan.counts.unchanged}
              </td>
              <td class="gb-mono">
                {run.appliedIndex}/{run.plan.actions.length}
                {#if run.lastError}<div class="gb-hint">{run.lastError}</div>{/if}
              </td>
              <td>
                <div class="action-row action-row--tight">
                  {#if run.status === 'paused'}
                    <button class="btn btn--primary" type="button" disabled={busy} onclick={() => handleResume(run)}>
                      从断点继续
                    </button>
                  {/if}
                  {#if run.status !== 'rolledback' && run.status !== 'rejected'}
                    <button class="btn btn--danger" type="button" disabled={busy} onclick={() => handleRollback(run)}>
                      回滚
                    </button>
                  {/if}
                  {#if run.status === 'applied' || run.status === 'resolved'}
                    <span class="gb-hint">恢复点保留中</span>
                  {/if}
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .page__title {
    margin: 0 0 4px;
    font-size: 19px;
    color: #1d3557;
  }

  .action-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px;
    margin: 10px 0;
  }

  .action-row--tight {
    margin: 0;
  }

  .conflict {
    border: 1px solid #e4d7d2;
    border-radius: 10px;
    padding: 10px 12px;
    margin-bottom: 12px;
    background: #fffaf8;
  }

  .conflict__title {
    font-weight: 600;
    color: #9c3d2e;
    margin-bottom: 8px;
  }

  .gb-alert.is-err {
    background: #fdecea;
    color: #9c2f22;
  }
</style>
