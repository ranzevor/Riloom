# 命令、事务与后台任务

供 Web、MCP、CLI、SDK 与插件开发者查询命令封套、回执、错误、事件和后台任务行为。

## 1. 一个命令契约

每个 CommandSpec 登记稳定名称、语义版本、输入/输出 Schema、对象范围、副作用类别、幂等策略、资源预算、任务支持和展示元数据。JSON Schema 是类型、工具目录及接口文档的来源，产品文案使用独立的本地化 key。

CommandSpec.version 与请求 commandVersion 均使用完整 SemVer 字符串，例如 "1.0.0"。调用指定注册表中存在的准确版本，回执回显实际执行版本。重投与任务恢复使用原命令版本，执行器版本另行固定。新操作使用不支持的命令版本时，在登记或派发前返回 UNSUPPORTED_VERSION。已有操作先核对固定输入并返回原回执。

命令分为 query、prepare、apply、external 和 maintenance。query 以只读方式访问工程、运行状态与外部目标，读缓存保存可重建的查询结果。prepare 基于固定来源修订保存草稿、候选及产物，apply 通过事务更新既有工程的模型修订。external 执行绑定目标上的授权操作，maintenance 执行资源维护。候选、任务与评审元数据按各自所属事务保存。

计划命令族：

| 名称前缀 | 职责 |
| --- | --- |
| riloom.project | 创建、打开、读取、应用、撤销和重做 |
| riloom.asset | 导入、替换候选、来源和素材查询 |
| riloom.authoring | 注册工位、运行配方、准备候选 |
| riloom.evaluate | 姿态、轨迹、动作和物理求值 |
| riloom.review | 缺陷、评审、返修及复验关联 |
| riloom.job | 开始、查询、取消、恢复 |
| riloom.target | 连接、绑定、检查、模型安装和获授权控制 |
| riloom.delivery | 准备、转换、核验和组装 |
| riloom.resource | 盘点、重建、回收计划及执行 |

MCP 通过 stdio 公开同名工具、类型化结果、分页资源和进度。发行兼容清单固定支持的协议版本，握手、结果封装和传输取消按所选协议映射。每个持久任务都有应用层 jobId 和查询接口，业务取消通过任务命令提交。工具 hint 用于展示，实际副作用在应用服务校验。

<a id="project-editing-entry"></a>

### 工程编辑入口

当前参数编辑闭环采用命令版本 1.0.0。MCP 工具目录由同一注册表提供输入 Schema，CLI 的 `call --input` 读取完整 JSON 请求，Web 将相同请求发往 `POST /api/v1/commands`。

| 命令 | 输入和结果 |
| --- | --- |
| `riloom.workspace.get` | 工作区作用域，返回工作区、服务世代和可用命令 |
| `riloom.project.list` | 工作区作用域，接受 limit 和 cursor，返回工程列表 |
| `riloom.project.create` | name、directory、canvas，返回 projectId、初始修订及状态身份 |
| `riloom.project.get` | 工程作用域，result.project 返回模型、修订、事件游标与历史位置 |
| `riloom.project.saveDraft` | 完整草稿、固定基线、编辑代次及 expectedDraftVersion，result.draft 返回已保存草稿 |
| `riloom.project.getDraft` | draftId，result.draft 和 result.base 返回草稿与对应基线模型 |
| `riloom.project.listDrafts` | limit 和 cursor，返回保存的草稿列表 |
| `riloom.project.prepareDraft` | draftId 和 expectedDraftVersion，result.candidate 返回固定版本候选 |
| `riloom.project.apply` | candidateId、draftId、草稿与工程前提，原子提交模型、草稿终结和回执 |
| `riloom.project.discardDraft` | draftId 和 expectedDraftVersion，终结草稿 |
| `riloom.project.undo`、`riloom.project.redo` | undoGroupId、工程前提和 expectedHistoryVersion，导航共享历史 |
| `riloom.project.getOperation`、`riloom.workspace.getOperation` | 原 requestId，在对应作用域查询原操作 |

每个请求包含 requestId、command、commandVersion、arguments，并按作用域提供 workspaceId 或 projectId。工具调用参数省略 command，由 MCP 工具名确定。查询返回当前读视图，写入结果按原请求保存在对应数据库中。

Parameter 字段为 id、name、unit、min、default、max、value。id 稳定且在工程内唯一，名称允许重复；默认值与当前值位于闭区间 [min,max]，数值必须有限。ChangeSet 支持 addParameter、updateParameter、removeParameter。更新和删除提供完整 before，新增提供完整 after，逆操作保留参数顺序。空草稿可保存，有效模型变化由准备和应用步骤检查。

创建目录为工作区内单级 `.riloom` 目录名。已有非空目录返回 RESOURCE_BUSY。创建意图持久化后，完整初始化结果由重启接续登记；初始化完成前中断的请求保存失败回执，可用新请求重新创建。每次模型应用形成一个完整撤销组。

Studio 自动保存最多保留一个在途请求，后续输入在前次保存确认后提交。应用结果未知时保留原请求进行核对，确认前暂停该草稿的编辑。其他入口修改模型时保留当前草稿；选择“保留编辑并重新准备”会将本次修改的字段应用到当前模型，再保存为新草稿。

浏览器使用启动链接中的一次性短期凭据建立会话。服务校验回环 Host、同源 Origin、会话 Cookie 和写请求的 CSRF 值。SSE 以 projectId 和 after 订阅，重连优先使用 Last-Event-ID；事件包含工程身份、序号、修订和操作身份。IPC 校验操作系统提供的对端身份，再完成绑定工作区与服务世代的授权握手。

### PNG 素材与绘画

riloom.asset.import 使用工程作用域和命令版本 1.0.0，输入 name、pngBase64 与 expectedDraftVersion。可指定 draftId、editorId、baseRevision 和 baseStateHash，以追加到已有编辑草稿。省略 draftId 时建立独立草稿。返回 asset、drawing、draft、candidate 及像素统计，绘画通过 riloom.project.apply 应用。

同请求重投返回原导入结果。草稿版本变化或来源不符时返回 REVISION_CONFLICT。导入保持原 PNG 及完整解码通道，初始绘画按原尺寸居中放置。

riloom.asset.read 输入已登记的 blob 引用，可附 offset 和 length。length 最大为 4 MiB，返回当前段的 Base64 data、offset、bytes 和 nextOffset。读取下一段时使用 nextOffset，直到等于 bytes。读取需要当前工程会话授权，内容与登记不符时返回 DATA_CORRUPT。

当前 PNG 输入上限为 16 MiB、800 万像素，接受 8/16 位 sRGB、灰度和索引图像及透明度。无色彩配置按 sRGB 解释。嵌入 ICC、cICP、其他色域或伽马配置返回 UNSUPPORTED_FEATURE，转换为 sRGB PNG 后可导入。原文件与解码像素分别保存，16 位通道使用小端字节序。

ChangeSet 增加 addAsset、removeAsset、addDrawItem、updateDrawItem 和 removeDrawItem。绘画字段为 id、name、assetId、x、y、visible、opacity、drawOrder、orderToken。排序按 drawOrder 升序，再按 orderToken 的 UTF-8 字节序确定同层顺序。更新提供完整 before/after，原子应用及逆操作沿用工程编辑契约。

### 工程备份命令

备份操作使用工作区作用域，便于在工程数据损坏时读取备份并恢复登记。全部命令版本为 1.0.0。

| 命令 | 输入 | 返回 |
| --- | --- | --- |
| `riloom.project.backup` | projectId、expectedRevision、expectedStateHash、expectedStorageGeneration | result.backup |
| `riloom.project.listBackups` | 可选 projectId、limit、cursor | 当前工作区的备份列表 |
| `riloom.project.importBackup` | 显式选择的本地备份 directory | 导入后的 result.backup |
| `riloom.project.prepareRestore` | backupId | result.plan，包含备份和当前恢复前提 |
| `riloom.project.restore` | backupId、新 directory、prepareRestore 返回的 expectedProject | 新存储世代的 result.project |
| `riloom.project.open` | projectId | result.project，同时为当前会话刷新该工程的存储授权 |

expectedProject 包含当前登记的 storageGeneration。当前工程可读时另含 revision 和 stateHash。工程数据损坏时只包含登记世代。工作区没有该工程登记时省略。恢复执行前重新核对这些条件，恢复目录须为工作区内的新 .riloom 目录。

恢复保留 projectId，分配新的 storageGeneration，并原子接替当前工作区登记。工作台在恢复成功后重新打开工程。其他客户端先调用 project.open，再为后续工程写入提供顶层 expectedStorageGeneration。旧世代写入返回 PERMISSION_DENIED，省略存储世代的恢复后写入返回 EFFECT_UNRESOLVED。重复请求先读取已有回执，原成功结果继续可查。

CLI 提供 `backup create --project`、`backup list`、`backup import --source` 和 `backup restore --backup --directory`。所有命令继续使用 `--workspace` 指定工作区。恢复命令先读取当前恢复前提，再提交固定请求。
## 2. 写入封套与回执

### 对象作用域与并发前提

Web、MCP、CLI 与 SDK 按实际操作对象选择前提，并交由应用服务校验。

| 操作范围 | 提供方 | 前提与并发保护 | 回执与可观察结果 |
| --- | --- | --- | --- |
| 工作区创建与登记 | 应用服务、工作区存储 | workspaceId、requestId、目标目录归属和持久创建意图 | 完整工程登记与回执，创建成功后返回 projectId |
| 候选准备 | 应用服务、制作执行器 | projectId、requestId、固定来源修订及其状态身份 | 候选、来源修订和可查询任务，应用时核对当前工程前提 |
| 既有工程模型编辑 | 应用服务、工程存储 | projectId、requestId、expectedRevision、expectedStateHash | 一个事务内的变更、逆操作、前后修订、回执与事件 |
| 草稿保存、应用与丢弃 | 应用服务、工程存储 | projectId、draftId、requestId、expectedDraftVersion，应用另带工程前提 | 持久草稿版本、编辑代次和状态，见[草稿契约](#draft-persistence) |
| 历史导航与手势聚合 | 应用服务、工程存储 | 工程前提、expectedHistoryVersion，操作已有组时携带组身份 | 同一事务内的模型结果、historyVersion、组和游标，见[历史契约](#undo-history) |
| 已有任务的取消与恢复 | 任务调度器 | jobId、本次控制命令的 requestId 和 expectedJobVersion，另关联原任务 | 可查询的任务版本，受理与实际停止分别表达 |
| 资源回收 | 应用服务、工程存储 | 工程归属、requestId、回收计划、预期修订、当前保留引用及资源占用 | 已执行项、保留项和具体失败对象，按[资源生命周期](project-format.md#resource-lifecycle)协调发布与删除 |
| 外部目标控制 | 目标适配器、应用服务 | 目标绑定身份、控制世代和原请求身份 | 操作回执与目标回读，结果按原操作核对 |
| 模型安装与更新 | 目标适配器、应用服务、工作区存储 | workspaceId、requestId、已授权安装目标、预期目录内容和固定安装计划 | 原操作与任务、安装后回读、旧包保留引用及阶段结果，见[安装契约](integrations-and-delivery.md#model-installation) |

工程创建以 workspaceId 定位请求，使用目标目录归属、唯一登记和持久意图协调初始化。expectedRevision 与 expectedStateHash 用于既有工程模型编辑。准备候选时固定来源修订，应用候选时再核对工程当前修订。

工程修订、状态身份、草稿版本、历史版本或任务版本与预期不符时返回 REVISION_CONFLICT，错误详情指明对应对象和当前前提。

下例为合成契约示意；实际请求的标识、修订和摘要由调用方生成或从工程读取：

~~~json
{
  "requestId": "op-019-example",
  "command": "riloom.project.apply",
  "commandVersion": "1.0.0",
  "projectId": "project-example",
  "expectedRevision": 12,
  "expectedStateHash": { "algorithm": "sha256", "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  "arguments": { "candidateId": "candidate-example" }
}
~~~

工程命令的去重键为 (projectId, requestId)，记录位于对应 project.sqlite。工作区级命令使用 (workspaceId, requestId) 和 workspace.sqlite。每个键对应固定 command、commandVersion、作用域、前提和输入摘要。工程编辑必填 expectedRevision 和 expectedStateHash，草稿控制使用 expectedDraftVersion，历史导航另核对 expectedHistoryVersion，任务控制使用 expectedJobVersion，外部操作使用目标绑定身份和控制世代。

写入回执的公共字段为 operationId、requestId、command、commandVersion、scope、status、inputHash、result、artifactRefs 和对应事件游标。scope 标明实际操作对象。工程模型编辑增加 beforeRevision、afterRevision 与 stateHash，创建完成后返回新 projectId、initialRevision 与 stateHash，候选准备完成后返回 candidateId 及来源修订和状态身份。任务受理返回 jobId 和 jobVersion，后续任务结果按 jobId 查询。各类回执按所属作用域的 Schema 校验。

请求身份通过对应数据库的唯一约束认领。同步工程编辑的认领、变更与回执在同一写事务内完成。工作区创建在登记 creating 意图的事务中认领。后台任务在同一事务中建立操作、job 和 status=accepted 的受理回执，提交后再派发。并发重投等待认领事务提交或回滚，提交后读取原操作，回滚后才可重新竞争认领。等待超时的调用继续使用原请求身份核对结果。

重试查询先于陈旧修订判断。同请求同输入返回原回执，同请求异输入返回 REQUEST_ID_REUSED，新请求旧修订返回 REVISION_CONFLICT。已受理的任务重投仍返回原 jobId 和受理回执。受理后、派发前中断时，调度器按原 jobId 接续。

HTTP、MCP、CLI 和 SDK 使用同一个受验封套与回执。不以新 requestId 自动重试结果未知的写入。工程操作去重记录至少与该工程的可恢复历史同寿命。备份恢复按[恢复屏障与身份接替](project-format.md#backup-recovery)处理旧任务和授权，再开放对应写入。

候选必须绑定完整来源身份、生成器版本、输入、保护约束及 ChangeSet。应用前再次核对来源和所有对象，不跨修订盲目重放操作。多操作编辑在内存副本上完成校验，写入事务中重新检查前提，再一次提交。失败时工程修订、对象和事件均不产生成功编辑。

<a id="draft-persistence"></a>

### 草稿保存与应用

草稿记录 projectId、draftId、editorId、baseRevision、baseStateHash、draftVersion、editGeneration、draftStatus、ChangeSet、按手势分组的草稿操作与逆操作、草稿历史游标及素材引用。editorId 绑定发起编辑会话，新建编辑会话默认使用独立 draftId。显式打开同一 draftId 时按其版本保存，读取其他会话草稿后也可另存新草稿。草稿保存属于 prepare，丢弃属于 maintenance，应用属于 apply。

创建使用 expectedDraftVersion=0，成功后的 draftVersion 从 1 开始，状态为 editing，并保留可用基线修订和素材。草稿的后续保存、应用与丢弃要求 draftStatus=editing。保存与丢弃使用当前 expectedDraftVersion，由同一工程事务比较版本、保存内容与引用、递增 draftVersion，并提交回执和事件。editGeneration 使用安全整数，以读到的确认代次为起点递增，新保存严格推进代次，重复发送使用原 requestId。草稿可以保存旧模型基线上的编辑，模型应用前按当前工程前提重新校验。

每个编辑会话为其当前草稿保留一个在途保存请求，后续输入更新本地 editGeneration，待前次回执确认后保存最新完整编辑内容。保存回执的 result 包含 editorId、draftId、draftVersion、draftStatus 和已确认 editGeneration，以 requestId、editorId、draftId 与代次关联本次确认。较旧回执完成原请求的核对，界面保存状态由当前本地代次与已确认代次比较得出。版本冲突保留本地编辑和服务端版本，读取差异后重新准备或另存新草稿。

交由模型应用的草稿版本暂停该编辑会话对原草稿的后续保存，新增预览输入在原结果确认后另存新草稿。应用固定的草稿版本时，候选绑定 draftId 与 draftVersion，项目应用事务同时核对草稿版本和模型前提，提交模型、逆操作与回执，并把该版本标记为 applied。丢弃标记为 discarded。两种终结均递增草稿版本，保留终结标记和请求去重记录。后续编辑建立新草稿，终结草稿的重新保存返回 REVISION_CONFLICT 和终结版本，迟到保存按原身份返回回执或版本冲突。

<a id="undo-history"></a>

### 撤销重做与手势聚合

工程采用跨 Web、MCP、CLI、SDK 共享的线性撤销历史。模型操作日志持续追加，撤销组及历史游标作为独立元数据保存。每组记录 undoGroupId、editorId、gestureId、有序操作引用及封口状态，工程保存单调 historyVersion。组创建、追加、封口和历史游标变更在各自提交事务中将该版本递增一次。

普通模型编辑自动形成一个已封口组。采用连续聚合时提供已登记的 editorId、gestureId 与 expectedHistoryVersion，将同一手势紧接的模型提交聚合到当前未封口组。请求携带 undoGroupId 时核对该组仍可聚合，新组身份由服务返回。手势结束、不属于该组的模型编辑或服务重启时封口已有组。跨入口编辑发生在两次提交之间时，后续提交使用新的组，原手势关联保持可查。显式聚合、封口和历史导航核对 historyVersion，普通独立编辑沿用既有工程前提。

撤销或重做请求明确选择当前可撤销或可重做组，并提供 expectedHistoryVersion 及工程前提。撤销在事务中封口目标组，按逆序验证并执行整组逆操作。重做复用原组的正向操作和已登记素材。模型修订、操作日志、历史游标、historyVersion、回执与事件共同提交，冲突时保留原状态并返回当前历史前提。

撤销和重做作为历史导航移动游标。新普通模型编辑建立当前分支并使游标后的重做组退出可用集合，原历史记录按既定保留策略保存。模型编辑回执的 result 返回实际 undoGroupId 与 historyVersion，并保留既有模型修订字段，重复请求复用原回执。

<a id="queries-and-events"></a>

## 3. 查询与事件

- 读列表遵循[列表版本与游标](#collection-pagination)，按实际集合维护续页前提。
- GET /api/v1/projects/:id、POST /api/v1/commands、GET /api/v1/projects/:projectId/operations/:id、GET /api/v1/jobs/:id、GET /api/v1/events 构成 HTTP 主入口。工程操作另可按 GET /api/v1/projects/:projectId/operations?requestId=… 查询。创建响应丢失时，用 GET /api/v1/workspaces/:workspaceId/operations?requestId=… 查询原创建操作。
- 每个工程事件流使用自身单调序号，并携带 projectId、revision、operationId 和事件类型。业务提交与该工程事件同数据库事务登记。工作区登记事件使用独立流；跨工程订阅携带每个流的游标，不承诺跨数据库的全局提交顺序。
- 工程状态重建查询在同一 SQLite 读事务内取得模型状态、revision 和对应流的 eventCursor。客户端从该游标之后订阅，服务按持久序号连续读取事件，实时通知用于唤醒续读。读取与订阅之间发生的编辑进入重放范围，重放赶上实时进度后仍从同一事件序列续读。工作区流分别取得其状态与游标。
- 事件至少一次传递，客户端按流和序号去重。游标超出保留窗口时重新取得一致的状态与游标，再从新游标续接。
- 画面拖动和播放时间可以使用不持久的高频预览通道；保存关键点仍提交受保护编辑。慢客户端合并预览帧，不丢失工程编辑事件。
- 大素材与报告按已登记 ArtifactRef 分块获取；接口默认返回引用，不把整幅图像塞入工具文本。

<a id="collection-pagination"></a>

### 列表版本与游标

每个列表响应包含作用域、集合名称、collectionVersion、items 和 nextCursor。条目带覆盖其持久表示的单调 recordVersion，既有对象版本能覆盖完整条目时复用该版本，其余使用实际变更序号。实时采样通过所属运行通道提供，界面计时由登记的时间字段计算。CommandSpec 声明可用的登记字段筛选与排序，以稳定对象 ID 补足同值顺序。

所有持久条目表示变化均推进 recordVersion。成员增删、可筛选字段或可排序字段变化另在所属数据库事务中递增 collectionVersion，单纯展示值更新沿用当前集合版本。覆盖完整集合前提的既有单调版本可复用，例如模型修订或 historyVersion。候选、草稿、任务、评审和历史集合分别维护自己的前提。跨数据库聚合返回分来源的列表响应，按来源续页并校验各自版本与游标。

游标绑定当前服务世代、授权作用域、集合、collectionVersion、规范化筛选与排序、页大小及末项排序键，服务校验其完整性。每页重验当前权限，并在同一读事务中核对版本、读取条目及其版本、生成续页游标。格式或完整性校验错误返回 INVALID_INPUT，服务世代、集合或查询前提变化返回 CURSOR_INVALIDATED 并给出当前集合版本。

调用方从首页重建该次查询。自动重查共享本次查询期限与重试预算，版本持续变化且预算耗尽时，以 CURSOR_INVALIDATED 结束本轮整体读取并返回最后观察到的版本。完成集合读取的条件是同一查询前提下读到 nextCursor 为空。

集合事件携带实际 collectionVersion 和 recordVersion。客户端以查询世代、作用域和集合版本接纳页面，按条目版本接纳值更新。旧查询的迟到响应失效，成员或排序前提变化后重读相关列表。单纯展示值更新保留当前续页前提。

<a id="local-ipc"></a>

### 本地 IPC、Worker 与 CLI

端点由持锁实例以平台排他创建方式建立，显式设置当前用户访问控制。已有端点先核对对端与锁归属，再决定连接或重新建立。发现记录由工作区服务在持有系统排他句柄期间发布，包含 workspaceId、规范化工作区引用、endpoint、协议版本、服务进程标识及启动世代。客户端核对发现记录的归属和访问权限，将操作系统提供的实际对端身份与存活的锁持有实例对应，再在握手中核对工作区及启动世代。仅凭 PID、端点名称或启动随机数字符串不建立授权。

首次客户端授权通过受保护的本地启动交接取得短期单次引导凭据。服务核验后签发会话能力，绑定 clientId、workspaceId、启动世代、允许的工程与命令类别、期限，以及工程当前 storageGeneration。引导材料与会话能力均不写入发现记录、工程或日志。已有客户端重连时重新校验当前授权，服务重启、授权撤销或工程恢复接替均使旧能力失效。每次请求及排队步骤产生副作用前重新校验当前授权与目标世代。权限不足返回 PERMISSION_DENIED，并拒绝登记与派发。M1 分平台选定并验证对端核对和引导交接机制，CLI/MCP 自动连接沿用同一授权路径。

本地 IPC 使用 riloom.ipc/1 握手和长度前缀 UTF-8 JSON 帧（32 位无符号小端长度，单帧最多 24 MiB）；大对象通过登记的文件引用获取。消息区分 request/response/event，响应关联 requestId，通知不伪装为请求。协议版本不相容时在接收命令前拒绝。MCP stdio 遵循协商后的 MCP 协议，不使用这套内部帧格式。

Worker 使用独立 riloom.worker/1 协议：hello、start、progress、checkpoint、artifact、result、cancel 和 stopped。每条消息绑定 jobId、stepId 与 leaseEpoch；单帧最多 1 MiB。宿主收到 cancel 的受理响应后继续等待实际停止及资源回收。诊断写 stderr，不污染协议输出。

CLI 的 --json 仅向 stdout 输出契约结果，诊断写 stderr；提交异步任务返回 jobId 和 accepted，--wait 等待实际终态。退出码为 0（已完成查询/同步操作或已受理异步提交）、2（输入错误）、3（冲突）、4（运行条件缺失）、5（执行失败）、130（取消）。机器消费者同时读取结果状态，异步提交的 0 不被记录为任务已完成。

<a id="paint-and-draft-commands"></a>

### 补画与草稿命令

以下命令首版语义版本为 1.0.0，沿用工程作用域、请求认领、后台任务和回执封套，具体制作语义见[补画往返](authoring-and-evaluation.md#paint-roundtrip)和[默认编辑](../design/studio.md#default-edit-flow)。

| 命令 | 类别与必要输入 | 结果 |
| --- | --- | --- |
| riloom.authoring.paint.prepare | prepare，固定 sourceRevision/sourceStateHash、drawItemId、E/P 选区及输出配置 | 新 draftId、draftVersion=1、完整准备及 editImageRef/selectionPreviewRef |
| riloom.authoring.paint.receive | prepare，draftId、expectedDraftVersion、固定 returnAssetRef | 新 draftVersion、Candidate 和最终素材/差异引用 |
| riloom.authoring.paint.run | external，draftId、expectedDraftVersion、提供方绑定、已授权输入与预算 | 原 jobId，完成后按回导事务登记草稿版本与 Candidate |
| riloom.project.prepareDraft | prepare，draftId、expectedDraftVersion 及已保存基线身份 | 绑定该完整草稿版本的 candidateId、差异与诊断，模型修订保持 |
| riloom.project.apply | apply，candidateId 与工程前提，草稿候选另带 draftId、expectedDraftVersion | 模型修订、草稿终结版本、撤销组与原回执 |

补画返回文件先登记为不可变素材引用，回导输入固定该引用，重投时按原请求核对，外部文件再次修改时使用新引用与新请求。prepareDraft 与回导均核对 editing 状态及当前 expectedDraftVersion。prepareDraft 只读取指定的已保存版本，新增输入保存到后续草稿。回导发布、候选登记和草稿版本推进共同提交，失败返回诊断，模型修订保持。提供方发送与费用按既有外部任务合同执行，最终发布再次核对草稿版本及终结状态。

### 编辑操作族

ChangeSet 包含 add/remove/update 对象、replaceMesh、setKeyform、setCurve、setPhysics、setVariantGroup 和 reparent 等有类型操作。每个操作给对象 ID、字段前提和完整新值；重布网把顶点、UV、索引及关键形映射作为一个不可拆的变更组。删除先计算引用闭包；需要级联时在候选差异中列清。逆操作保存原值和前提，应用后验证全部引用与层级不变量。

## 4. 错误与取消

| 机器代码 | 语义 | 调用方动作 |
| --- | --- | --- |
| INVALID_INPUT | 输入不符合契约 | 修正具体字段 |
| PERMISSION_DENIED | 会话、作用域或当前服务/存储世代未获授权 | 按当前工作区和工程重新取得相应授权 |
| REVISION_CONFLICT | 工程、草稿、历史或任务前提与预期不符 | 保留当前输入，读取对应对象与差异后重新准备 |
| CURSOR_INVALIDATED | 列表集合或查询前提已变化 | 按当前集合版本从首页重建查询 |
| REQUEST_ID_REUSED | 原请求身份对应不同输入 | 核对调用逻辑，不覆盖原回执 |
| UNSUPPORTED_VERSION | 注册表不支持指定命令版本 | 查询支持的准确版本，重新准备请求 |
| UNSUPPORTED_FEATURE | 适配器不能表达指定能力 | 查看对象和具体特性，选择兼容处理 |
| RESOURCE_LIMIT | 当前预算不足以完整执行 | 调整预算或任务范围后创建新候选 |
| RESOURCE_BUSY | 资源删除结果正在核对 | 查询原维护操作，核对完成后重试对应访问 |
| RESOURCE_GONE | 旧引用指向已按计划回收的资源 | 重建可重建产物或重新导入对应素材 |
| TARGET_CHANGED | 外部目标绑定身份、控制世代或安装目录内容与预期不符 | 核对当前目标、控制归属或安装内容，重新绑定或准备安装计划 |
| TARGET_BUSY | 目标正在使用或安装文件被占用 | 释放占用后核对原操作及当前目标，准备后续请求 |
| EFFECT_UNRESOLVED | 外部效果或备份截止后的原操作需要核对 | 查询外部目标或原操作 |
| CANCELLED | 取消已生效，执行停止且自有资源已回收 | 查看已提交步骤、保留产物与外部效果 |
| DATA_CORRUPT | 存储完整性校验失败 | 进入只读恢复流程 |

UI 将这些信息转换为对象名称、具体原因和可执行动作，错误码、堆栈及文件路径保留在技术详情与受限日志。应用错误与 MCP/HTTP 传输错误分别表达。

取消受理回执表示取消意图已持久保存，实际停止状态按 jobId 查询。本地任务的最终发布与取消登记按所属数据库的事务提交顺序判定。最终发布事务核对取消世代，将结果引用、最终步骤结果及 succeeded 终态与该步骤产生的候选或工程编辑一起提交。

取消先提交时，最终发布被拒绝，任务停止并完成资源回收后进入 cancelled。最终发布先提交时，任务保持 succeeded，后到取消只返回已有终态。取消命令携带陈旧 expectedJobVersion 时按 REVISION_CONFLICT 处理，调用方读取当前任务。多步骤任务取消后保留此前已提交步骤的回执、产物和外部效果，只停止剩余步骤。

## 5. 持久任务与步骤

~~~mermaid
stateDiagram-v2
  [*] --> queued
  queued --> reconciling: 备份恢复且含外部步骤
  failed --> reconciling: 备份恢复且允许续作
  queued --> running
  running --> succeeded
  running --> failed
  running --> reconciling
  running --> cancelling
  queued --> cancelled
  cancelling --> cancelled
  cancelling --> reconciling
  reconciling --> succeeded: 无取消意图且全部步骤成功
  reconciling --> queued: 显式恢复且效果与费用前提有效、无取消意图
  reconciling --> failed
  reconciling --> cancelled
  failed --> queued: 显式恢复且前提有效、无取消意图
~~~

任务记录 jobId、rootOperationId、输入身份、执行器语义版本、步骤 DAG、期限、预算、尝试次数、leaseEpoch、检查点及取消世代。步骤结果写入后发布检查点，禁止指针先于结果存在。

从 cancelling 进入 reconciling 的任务保留取消意图。核对原外部效果后进入 cancelled 或 failed，核对过程只补充实际结果。无取消意图的任务按实际步骤结果完成。仍有后续步骤时，在效果、费用及原执行前提有效后允许显式恢复。取消前已持久完成的任务返回原成功结果，恢复读取当前终态与取消世代。

- 无外部副作用的步骤可按固定输入和版本重算；输入相同且产物完整的成功步骤直接复用。
- 恢复者使用条件更新领取新 leaseEpoch，宿主接收结果时拒绝旧 epoch。租约超时与旧进程退出分别确认。
- 同存储服务中断后，执行中的外部步骤先进入 reconciling。固定原目标及 operationId 进行核对。备份恢复还需对含外部步骤的可恢复任务设置[恢复屏障](project-format.md#backup-recovery)，完成事实与授权核对后再允许显式恢复。
- 取消先持久记录并停止派发，再请求自有 Worker 退出；超过宽限期终止自有进程树。迟到结果可补充外部事实，不能重新启动已取消任务。
- 外部 API 没有去重或查询能力时，保留未决状态与具体核对入口，禁止自动重发具有重复副作用的动作。
- 任务恢复继承原期限、已用预算、在途费用预留与重试次数。指数退避有总上限，所有层的重试预算归任务调度器统一管理。
- 客户端断开不改变任务目标；用户的取消与恢复通过显式命令提交。

Worker 启动参数采用固定可执行文件和参数数组。stdout 为协议帧，stderr 为日志；大小、频率、超时及产物路径均受宿主管理。

## 6. 插件接口

<a id="plugin-results"></a>

插件按已协商的 capabilityKind 声明输入/输出 Schema。宿主按实际扩展点检查结果类型、来源和引用，文件产物另核对专属输出目录、内容身份与工程不变量。

| 扩展点 | 返回类型与宿主处理 |
| --- | --- |
| 导入器、制作工位 | Candidate，包含完整 ChangeSet、来源、素材和诊断，按候选事务应用 |
| 检查器 | CheckResult，包含判据、对象、姿态/时刻和诊断，可引用另行校验的修复候选，由应用服务登记检查项 |
| 导出器 | DeliveryResult，包含 profile、文件清单、产物引用及转换诊断，经交付校验登记 |
| 追踪源 | TrackingStream，连续提供已授权输入的参数帧，由运行求值消费 |

工程修订由候选的显式应用推进，检查与交付结果分别登记到所属元数据域，追踪流更新运行输入。

任务型插件取得本次只读输入引用和专属输出目录，返回对应类型的结果、可选产物及任务检查点，复用 Worker 的任务身份与退出契约。类型不符、坏引用或越界产物使本次能力调用失败，并给出具体字段诊断。

### 追踪流、背压与断连

流消息沿用长度前缀 JSON 分帧与 stdout/stderr 分离约定，单帧最多 1 MiB。流启动登记 sourceId、输入目录、时钟锚点、deliveryMode、maxPendingFrames、maxBackpressureMs 与 sampleTimeoutMs，宿主分配 streamId 与 controlEpoch。缓冲上限为正整数，两类超时为正数并使用宿主单调时钟。输入目录说明每个 inputId 的单位、范围和 continuous/discrete 类型。

每个 sample 包含 streamId、controlEpoch、sequence、time 和本次授权输入集合的完整 values。time 是相对本流单调时钟零点的非负有限秒数，并按接收序号单调不减，锚点将其对齐到模型时间。sequence 为从 1 开始的安全整数。宿主校验输入授权、Schema、有限数值、时间顺序和序号，启用已授权的录制配置时按实际消费顺序登记模型时间与参数帧。

- latest 模式用于全为 continuous 的输入集合，宿主将待消费帧合并为最新完整帧，并记录实际消费序号。接收序号严格递增，消费序号允许跨过已合并帧。
- ordered 模式按连续序号保留完整帧，适用于包含 discrete 输入的集合。队列达到容量时暂停继续读取并向源施加背压，等待达到 maxBackpressureMs 或本流资源预算耗尽时以 RESOURCE_LIMIT 停止该流，返回最后完整消费位置。
- 显式停止、协议错误、预算停止、进程退出、断连、采样超时或卸载时停止接收该流，释放其输入拥有权并重新求值当前有效贡献。停止与资源释放均可查询。
- 重连验证当前授权，建立新的 streamId、controlEpoch 与时钟锚点，接收完整首帧后接入求值。播放时钟重定位时重建输入世代与锚点。旧流迟到帧按世代拒绝，恢复轨迹使用记录的原消费顺序。

声明式配方仅支持有类型参数、显式 DAG、已注册工位、有限条件和预算；禁止 shell 字符串与动态 eval。代码插件首次安装展示来源、版本、可用权限与许可；工程文件中的插件名称只形成依赖请求。旧任务恢复固定执行器语义版本，相容性由明确迁移规则提供。
