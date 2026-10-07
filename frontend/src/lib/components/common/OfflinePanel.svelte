<script lang="ts">
  /**
   * 离线采集与并回主档案面板（/backup 页内嵌使用）。
   *
   * 单位侧：出发前导出离线包 → 外业回单位导入回传包（三方对账）→ 待确认冲突逐条处理。
   * 平板侧：装载离线包离线作业 → 导出回传包。
   * 批次历史展示断点进度、引用退回原因，并提供断点续传与恢复点回滚。
   */
  import {
    offlineBusy,
    offlineSessionList,
    importRunList,
    prepareOfflinePackage,
    mergeReturnPackage,
    readPackageFile,
    loadPackageToTablet,
    exportReturnPackage,
    discardSession,
    settleConflict,
    continueImport,
    restoreBeforeImport,
    removeImportRun
  } from '$lib/stores/offlineStore.ts'
  import type { ImportRun, ImportConflict, ConflictReason } from '$lib/types/offline.ts'
  import { countBundle } from '$lib/utils/offlinePackage.ts'

  type Mode = 'office' | 'tablet'
  let mode = $state<Mode>('office')
  let pkgName = $state(`外业任务 ${new Date().toISOString().slice(0, 10)}`)
  let officeFile = $state<HTMLInputElement | null>(null)
  let tabletFile = $state<HTMLInputElement | null>(null)
  let notice = $state<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  const STATUS_TEXT: Record<ImportRun['status'], string> = {
    applying: '应用中',
    rejected: '整包退回',
    planned: '有待确认',
    completed: '已完成',
    failed: '写入中断',
    'rolled-back': '已回滚'
  }

  const REASON_TEXT: Record<ConflictReason, string> = {
    'both-edited': '两边都改过',
    'offline-edit-master-deleted': '离线改过、主档案已删除',
    'both-created': '两边新增撞号',
    'offline-delete-master-edited': '离线删除、主档案改过'
  }

  const TABLE_TEXT = {
    buildings: '建筑物',
    devices: '防雷装置',
    points: '测点',
    verdicts: '判定',
    rectifies: '整改单'
  } as const

  const activeSession = $derived($offlineSessionList[0] ?? null)

  function runProgress(run: ImportRun): { done: number; total: number; pct: number } {
    const total = run.ops.length
    const done = run.ops.filter((op) => op.applied).length
    return { done, total, pct: total === 0 ? 100 : Math.round((done / total) * 100) }
  }

  function fmtTime(iso: string | null): string {
    return iso ? new Date(iso).toLocaleString('zh-CN') : '—'
  }

  async function handlePrepare(): Promise<void> {
    notice = null
    if (!pkgName.trim()) {
      notice = { tone: 'bad', text: '请先填写离线包名称（便于外业辨认任务）。' }
      return
    }
    const result = await prepareOfflinePackage(pkgName)
    const counts = countBundle(result.pkg.baseline)
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
    notice = {
      tone: 'ok',
      text: `离线包已导出：${result.fileName}（基线共 ${total} 条记录），把它拷到外业平板上装载即可离线采集。`
    }
  }

  async function handleOfficeFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    notice = null
    try {
      const parsed = await readPackageFile(file)
      if (!parsed.ok || !parsed.pkg) {
        notice = { tone: 'bad', text: `离线包校验失败：${parsed.errors.join('；')}` }
        return
      }
      const outcome = await mergeReturnPackage(parsed.pkg)
      if (outcome.duplicated) {
        notice = { tone: 'ok', text: '同一个离线包此前已完成并回，本次未重复导入（只算一次）。' }
        return
      }
      const run = outcome.run
      if (run.status === 'rejected') {
        notice = {
          tone: 'bad',
          text: `整包退回，未写入任何业务数据：${run.errors.slice(0, 3).join('；')}${run.errors.length > 3 ? ' 等' : ''}。请修正离线包后重新导入，可从原断点继续。`
        }
        return
      }
      const pending = run.conflicts.filter((item) => item.resolution === null).length
      const applied = run.ops.filter((op) => !op.fromConflict).filter((op) => op.applied).length
      if (run.status === 'failed') {
        notice = {
          tone: 'bad',
          text: `导入在第 ${runProgress(run).done}/${runProgress(run).total} 步写入中断，已处理记录与恢复点均已保留，点「从断点继续」即可接着导入。`
        }
      } else if (pending > 0) {
        notice = {
          tone: 'ok',
          text: `对账完成：${applied} 条单边改动已直接应用，${pending} 条两边都改过留成待确认，请在下方逐条处理。`
        }
      } else {
        notice = {
          tone: 'ok',
          text: `${outcome.resumed ? '已从断点继续并' : ''}对账导入完成：${applied} 条改动直接应用，测点判定按最新限值重算，整改单跟踪状态保留。`
        }
      }
    } catch (error) {
      notice = { tone: 'bad', text: `导入失败：${String(error)}` }
    } finally {
      input.value = ''
    }
  }

  async function handleTabletFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    notice = null
    try {
      const parsed = await readPackageFile(file)
      if (!parsed.ok || !parsed.pkg) {
        notice = { tone: 'bad', text: `离线包校验失败：${parsed.errors.join('；')}` }
        return
      }
      if (activeSession && activeSession.packageId !== parsed.pkg.packageId) {
        const ok = window.confirm(
          '本机已装载另一个外业任务。装载新包会清空当前业务数据并切换会话，确定继续？'
        )
        if (!ok) return
      }
      await loadPackageToTablet(parsed.pkg)
      const counts = countBundle(parsed.pkg.snapshot)
      notice = {
        tone: 'ok',
        text: `已装载离线任务「${parsed.pkg.name}」：建筑物 ${counts.buildings}、装置 ${counts.devices}、测点 ${counts.points}，现在可离线采集。`
      }
    } catch (error) {
      notice = { tone: 'bad', text: `装载失败：${String(error)}` }
    } finally {
      input.value = ''
    }
  }

  async function handleReturn(): Promise<void> {
    notice = null
    try {
      const fileName = await exportReturnPackage()
      notice = { tone: 'ok', text: `回传包已生成：${fileName}。回单位后在「单位端」选择该文件并回主档案。` }
    } catch (error) {
      notice = { tone: 'bad', text: String(error) }
    }
  }

  async function handleDiscard(): Promise<void> {
    const ok = window.confirm('作废当前离线会话仅清除任务标记，不会删除已采集的业务数据。确定继续？')
    if (!ok) return
    await discardSession()
    notice = { tone: 'ok', text: '离线会话已作废。' }
  }

  async function handleResolve(run: ImportRun, conflict: ImportConflict, resolution: 'take-offline' | 'keep-master'): Promise<void> {
    const updated = await settleConflict(run.id, conflict.key, resolution)
    notice = {
      tone: updated.status === 'failed' ? 'bad' : 'ok',
      text:
        updated.status === 'failed'
          ? '冲突处理写入中断，可从断点继续。'
          : updated.status === 'completed'
            ? '最后一条冲突已处理，本次并回全部完成。'
            : '冲突已处理，改动已落库。'
    }
  }

  async function handleContinue(run: ImportRun): Promise<void> {
    const outcome = await continueImport(run.id)
    notice = {
      tone: outcome.run.status === 'failed' ? 'bad' : 'ok',
      text:
        outcome.run.status === 'failed'
          ? '续传再次中断，恢复点仍保留。'
          : outcome.run.status === 'completed'
            ? '已从断点继续，本次并回全部完成。'
            : '已从断点继续，仍有待确认冲突需要处理。'
    }
  }

  async function handleRollback(run: ImportRun): Promise<void> {
    const ok = window.confirm('将用导入前恢复点把主档案五张表整体恢复到导入前状态。确定继续？')
    if (!ok) return
    await restoreBeforeImport(run.id)
    notice = { tone: 'ok', text: '主档案已恢复到该包导入前的状态；如需重试请重新导入该包。' }
  }

  async function handleRemove(run: ImportRun): Promise<void> {
    const ok = window.confirm('仅删除批次记录与恢复点，不会改动当前业务数据。确定删除该历史？')
    if (!ok) return
    await removeImportRun(run.id)
    notice = { tone: 'ok', text: '批次历史已删除。' }
  }
</script>

<div class="offline">
  <div class="offline__tabs">
    <button
      class="btn btn--small"
      class:btn--primary={mode === 'office'}
      type="button"
      onclick={() => (mode = 'office')}
    >
      单位端：导出 / 并回
    </button>
    <button
      class="btn btn--small"
      class:btn--primary={mode === 'tablet'}
      type="button"
      onclick={() => (mode = 'tablet')}
    >
      平板端：装载 / 回传
    </button>
  </div>

  {#if notice}
    <p class="gb-alert" class:gb-danger={notice.tone === 'bad'}>{notice.text}</p>
  {/if}

  {#if mode === 'office'}
    <div class="offline__block">
      <h4>① 出发前导出离线包</h4>
      <p class="gb-hint">
        包内含主档案基线与建筑物 → 装置 → 测点 → 判定 → 整改单的全部引用关系；外业补录的对象在并回时会重编编号并沿用原引用。
      </p>
      <div class="offline__row">
        <label class="gb-field">
          <span>任务名称</span>
          <input type="text" bind:value={pkgName} placeholder="如：临港油库年度检测" />
        </label>
        <button class="btn btn--primary" type="button" disabled={$offlineBusy} onclick={handlePrepare}>导出离线包</button>
      </div>
    </div>

    <div class="offline__block">
      <h4>② 回单位并回主档案</h4>
      <p class="gb-hint">
        选择外业回传包，系统按基线与两侧现状对账：离线单边改过的直接应用，两边都改过的留成待确认；
        接地电阻实测值改动后判定按最新限值重算，整改单跟踪状态保留；同一个包重复导入只算一次。
      </p>
      <div class="offline__row">
        <label class="gb-field">
          <span>选择回传包</span>
          <input type="file" accept="application/json" bind:this={officeFile} onchange={handleOfficeFile} />
        </label>
      </div>
    </div>
  {:else}
    <div class="offline__block">
      <h4>① 平板装载离线包</h4>
      <p class="gb-hint">装载会把任务基线存入本机并按包内现状准备台账，之后全程离线作业，不需要任何网络。</p>
      <div class="offline__row">
        <label class="gb-field">
          <span>选择单位导出的离线包</span>
          <input type="file" accept="application/json" bind:this={tabletFile} onchange={handleTabletFile} />
        </label>
      </div>
      {#if activeSession}
        <table class="gb-table">
          <tbody>
            <tr>
              <th>当前任务</th>
              <td>{activeSession.name}</td>
              <th>任务号</th>
              <td class="gb-mono">{activeSession.packageId}</td>
            </tr>
            <tr>
              <th>装载时间</th>
              <td>{fmtTime(activeSession.exportedAt)}</td>
              <th>回传状态</th>
              <td>{activeSession.returnedAt ? `已回传 ${fmtTime(activeSession.returnedAt)}` : '采集中，未回传'}</td>
            </tr>
          </tbody>
        </table>
      {/if}
    </div>

    <div class="offline__block">
      <h4>② 外业结束导出回传包</h4>
      <p class="gb-hint">回传包沿用原任务号与基线，只更新平板上的最新采集数据。</p>
      <div class="offline__row">
        <button class="btn btn--primary" type="button" disabled={$offlineBusy || !activeSession} onclick={handleReturn}>
          生成并下载回传包
        </button>
        {#if activeSession}
          <button class="btn btn--small" type="button" disabled={$offlineBusy} onclick={handleDiscard}>作废当前会话</button>
        {/if}
      </div>
    </div>
  {/if}

  {#if $importRunList.length > 0}
    <div class="offline__block">
      <h4>并回批次与恢复点{mode === 'tablet' ? '（单位端操作）' : ''}</h4>
      {#each $importRunList as run (run.id)}
        {@const progress = runProgress(run)}
        <div class="run-card">
          <div class="run-card__head">
            <strong>{run.packageName}</strong>
            <span class="gb-tag" class:gb-danger={run.status === 'rejected' || run.status === 'failed'}>
              {STATUS_TEXT[run.status]}
            </span>
            <span class="gb-hint gb-mono">{run.id}</span>
          </div>
          <div class="run-card__meta gb-hint">
            导出 {fmtTime(run.exportedAt)} · 回传 {fmtTime(run.returnedAt)} · 进度 {progress.done}/{progress.total}
            （{progress.pct}%）· 尝试 {run.attempts.length} 次
          </div>

          {#if run.status === 'rejected'}
            <ul class="run-card__errors">
              {#each run.errors.slice(0, 5) as error (error)}
                <li>{error}</li>
              {/each}
              {#if run.errors.length > 5}
                <li>…共 {run.errors.length} 条引用问题，整包退回，未写入业务数据</li>
              {/if}
            </ul>
          {/if}

          {#if run.stats.rejudges > 0}
            <p class="gb-hint">其中 {run.stats.rejudges} 个测点的判定已按最新限值重算（检测人保留、需重新确认），整改单跟踪状态未改动。</p>
          {/if}

          {#if run.conflicts.some((item) => item.resolution === null)}
            <table class="gb-table">
              <thead>
                <tr>
                  <th>对象</th>
                  <th>类型</th>
                  <th>冲突原因</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {#each run.conflicts.filter((item) => item.resolution === null) as conflict (conflict.key)}
                  <tr>
                    <td>{conflict.label}</td>
                    <td>{TABLE_TEXT[conflict.table]}</td>
                    <td>{REASON_TEXT[conflict.reason]}</td>
                    <td class="run-card__actions">
                      <button
                        class="btn btn--small btn--primary"
                        type="button"
                        disabled={$offlineBusy}
                        onclick={() => handleResolve(run, conflict, 'take-offline')}
                      >
                        采用离线
                      </button>
                      <button
                        class="btn btn--small"
                        type="button"
                        disabled={$offlineBusy}
                        onclick={() => handleResolve(run, conflict, 'keep-master')}
                      >
                        保留主档案
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}

          <div class="run-card__actions">
            {#if run.status === 'failed'}
              <button class="btn btn--small btn--primary" type="button" disabled={$offlineBusy} onclick={() => handleContinue(run)}>
                从断点继续
              </button>
            {/if}
            {#if run.status === 'planned' && run.ops.some((op) => !op.applied)}
              <button class="btn btn--small btn--primary" type="button" disabled={$offlineBusy} onclick={() => handleContinue(run)}>
                继续未完成操作
              </button>
            {/if}
            {#if run.snapshotId && run.status !== 'rolled-back'}
              <button class="btn btn--small btn--danger" type="button" disabled={$offlineBusy} onclick={() => handleRollback(run)}>
                恢复到导入前
              </button>
            {/if}
            <button class="btn btn--small" type="button" disabled={$offlineBusy} onclick={() => handleRemove(run)}>
              删除历史
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .offline {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .offline__tabs {
    display: flex;
    gap: 8px;
  }

  .offline__block {
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .offline__block h4 {
    margin: 0;
    color: #1d3557;
    font-size: 15px;
  }

  .offline__row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px;
  }

  .run-card {
    border: 1px dashed #cbd5e1;
    border-radius: 8px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .run-card + .run-card {
    margin-top: 10px;
  }

  .run-card__head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .run-card__meta {
    font-size: 12px;
  }

  .run-card__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .run-card__errors {
    margin: 0;
    padding-left: 18px;
    color: #b42318;
    font-size: 13px;
  }
</style>
