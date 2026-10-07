# sologsb101-1010 防雷装置检测与接地电阻台账

面向防雷检测机构的纯前端单页应用：对建筑物的接闪器、引下线与接地装置逐项登记，按测点录入接地电阻实测值并与限值比对判定合格与否，最后汇总出检测结论与整改建议。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22810**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22810）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Svelte 5（runes：`$state` / `$derived` / `$props` / `$effect`） | 页面组件使用 `lang="ts"` |
| 语言 | TypeScript 5.7 | 构建脚本执行 `svelte-check --tsconfig ./tsconfig.json` |
| 路由 | svelte-spa-router 5 | hash 路由，`/buildings`、`/devices`、`/points`、`/verdicts`、`/backup` |
| 样式 | Tailwind CSS 4（`@tailwindcss/vite`）+ 自定义组件类 | 主题变量走 `@theme` |
| 状态管理 | Svelte store（`writable` / `derived`） | `buildingStore`、`pointStore`、`rectifyStore` |
| 持久化 | Dexie 4（IndexedDB，库名 `gblightprot`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/buildings` | 建筑物与防雷类别台账 | Building、Device、Point | 新建/编辑/删除建筑物，按用途与防雷类别筛选，卡片回显装置数、测点数、不合格数与合格率 |
| `/devices` | 接闪器/引下线/接地装置登记 | Device、Building、Point | 登记类型、材质、规格、数量与安装日期，按建筑物与类型筛选，展开查看该装置全部测点 |
| `/points` | 接地电阻测点录入 | Point、Device | 逐点录实测电阻与限值、批量改写、批量粘贴导入（`编号,位置,实测[,限值]`） |
| `/verdicts` | 合格判定与整改建议 | Verdict、Point、Rectify | 自动初判（实测 ≤ 限值）、检测人确认生效、批量改判、由不合格判定批量生成整改建议、整改状态机（待整改→已整改→已复检） |
| `/backup` | 检测结论与结构版本导出 | 全部模型 | 按建筑物出检测结论、全部测点判定一览、外业离线包导出 / 平板装载 / 回传三方对账并回（待确认冲突与恢复点）、全量 JSON 导入导出（覆盖 / 追加两种模式）、清空重建演示数据 |

> 深层 id 场景：本项目的列表与明细集中在同一组路由（建筑物 → 装置 → 测点 → 判定 → 结论），不存在 `/xxx/:id/yyy` 形式的层级深链；筛选条件通过 query 传递（例如 `/points?device=dev_oil_belt`），刷新后仍可复现当前视图。若 query 指向的装置已被删除，页面自动回落到全部测点并给出空态引导，不会白屏。

## 四、目录结构

```
sologsb101-1010/
├── README.md
├── docker-compose.yml            # name: gblightprot，不写 version
├── Dockerfile                    # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                    # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example           # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile                # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf                # 前端独立托管用
    ├── .dockerignore
    ├── package.json              # build = svelte-check && vite build
    ├── tsconfig.json
    ├── vite.config.js
    ├── svelte.config.js
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.js               # Svelte 5 mount 入口，并打开并播种数据库
        ├── App.svelte            # 顶部导航（link action）+ 页脚数据概览
        ├── app.css               # Tailwind 入口 + 主题变量 + 通用组件类
        ├── lib/
        │   ├── types/            # building / device / point / verdict / rectify / offline
        │   ├── stores/           # buildingStore / pointStore / rectifyStore / offlineStore
        │   ├── components/common/# QualifyTag / FilterBar / StatBadge / EmptyPanel / OfflinePanel
        │   ├── hooks/            # useIdbTable / useQualifyRate
        │   └── utils/            # resistance.ts / db.ts / export.ts / query.ts / offlinePackage.ts / reconcile.ts / offlineImport.ts
        └── routes/
            ├── index.ts          # 路由表（svelte-spa-router 的 route 映射）
            ├── BuildingList.svelte
            ├── DeviceList.svelte
            ├── PointEntry.svelte
            ├── VerdictBoard.svelte
            └── BackupView.svelte
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22810
npm run build      # svelte-check 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gblightprot`，当前结构版本 `v3`。所有读写经 `frontend/src/lib/utils/db.ts` 与 hooks 封装，组件不直接触碰 Dexie 实例。
- **数据表**：`buildings`（建筑物）、`devices`（防雷装置）、`points`（接地电阻测点）、`verdicts`（合格判定）、`rectifies`（整改建议）；v3 另增离线并回支撑表 `offlineSessions`（平板离线会话 / 基线）、`importRuns`（导入批次：去重、断点、冲突）、`importSnapshots`（导入前恢复点）。
- **升级迁移**：`db.version(1)` 保留初版结构，`db.version(2).stores(...).upgrade(...)` 补齐索引并回填历史数据缺失的时间戳、限值、判定确认标记，`db.version(3).stores(...)` 新增离线会话 / 导入批次 / 恢复点三张表（不改既有五表，无需回填）；调整字段结构时递增 `DB_VERSION` 并补迁移。
- **首屏播种**：`initDatabase()` 在 `buildings` 表为空时执行幂等播种，生成三层互相引用的演示数据（3 栋建筑物 / 6 个防雷装置 / 9 个测点 / 9 条判定 / 3 条整改建议），其中既有合格样本也有超限样本，便于演示挂红、整改与结论导出。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，Svelte store 自动刷新，页面用 `$store` 只读订阅。
- **判定规则**：实测电阻 ≤ 限值判合格；限值初始值按防雷类别与装置类型建议（一类/二类接地装置 4 Ω，其余 10 Ω），最终以设计文件与规范条款为准。
- **备份与恢复**：`/backup` 页可导出包含五张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id）」；备份时间写入 `localStorage`，页脚与备份页均展示结构版本号。
- **离线采集与并回**：见下节「外业离线采集 → 回单位并回主档案」。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。

## 七、外业离线采集 → 回单位并回主档案

面向「外业技术员用平板离线采集、回单位并回」的完整闭环，入口都在 `/backup` 页的「外业离线采集与并回主档案」面板（代码分层：类型 `types/offline.ts`、纯对账 `utils/reconcile.ts`、组装装载 `utils/offlinePackage.ts`、执行恢复 `utils/offlineImport.ts`、状态 `stores/offlineStore.ts`、UI `components/common/OfflinePanel.svelte`）。

1. **出发前导出离线包（单位端）**：包内含主档案全量**基线**与建筑物 → 装置 → 测点 → 判定 → 整改单的全部引用关系（`baseline` 与 `snapshot` 两份五表快照 + 稳定 `packageId`）。
2. **平板装载离线采集（平板端）**：装载时留存基线会话并按包内现状准备台账，外业补录建筑物 / 装置 / 测点 / 整改单全程离线；结束后「生成回传包」，任务号与基线不变、只更新现状快照。
3. **回单位三方对账并回（单位端）**：按 `基线 / 主档案现状 / 离线现状` 对账——
   - 仅离线单边改过（含新增、修改、删除）直接应用；仅主档案改过则保留主档案；两边都改过（含删除与编辑相撞）留成**待确认冲突**，人工选择「采用离线 / 保留主档案」。
   - 补录对象**重编新编号**写入，外键按 id 映射改写，沿用原有引用关系；同阶段内写入在前、删除在后，保证父子依赖。
   - 测点实测值 / 限值被改动后，判定按**最新限值重算**（结论、依据刷新，检测人与创建时间保留，`confirmed` 重置待复检确认）；**整改单跟踪状态原样保留，不会因判定翻新被重置或删除**。
   - **幂等**：同一 `packageId` 已完成的批次重复导入只算一次；中断 / 待确认批次再导同一文件即从断点继续。
   - **整包退回**：导入前先校验引用完整性（装置必须有建筑物、测点必须有装置、判定必须有测点、整改单必须有建筑物），任一缺失整包退回、不写业务表，批次记录与恢复点仍保留，修正后从断点继续。
   - **断点与恢复**：操作按阶段分块事务提交，每块落库已执行标记作为断点；首条业务写入前保存导入前五表全量快照，写入失败或人工干预均可一键「恢复到导入前」，回滚后允许重新导入。
