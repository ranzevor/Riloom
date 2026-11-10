# 架构与技术选型

面向核心与服务开发者，说明进程结构、模块职责、依赖方向和技术选型。

## 1. 运行结构

采用 TypeScript 模块化单体、一个本地工作区服务和受管理的计算子进程。服务拥有持久状态写入权；界面与协议入口负责输入呈现和传输。高内存转换、图像处理和长计算通过 Worker 协议执行。

~~~mermaid
flowchart TB
  Studio[Riloom Studio] --> HTTP[同源 HTTP 与事件流]
  MCP[MCP stdio 桥] --> IPC[本地 IPC]
  CLI[CLI / SDK] --> IPC
  HTTP --> App[应用服务与命令注册表]
  IPC --> App
  App --> Core[领域核心与制作引擎]
  App --> Store[SQLite 事务与回执]
  App --> Blobs[不可变素材存储]
  App --> Jobs[任务调度器]
  Jobs --> Worker[受管理的计算进程]
  Worker --> Adapters[可选提供方与目标软件适配]
  Core --> Eval[确定性求值器]
  Eval --> Render[WebGL2 视口与便携播放器]
~~~

<a id="workspace-ownership"></a>

工作区服务按真实路径建立独占实例与所有权锁，锁采用操作系统持有的排他句柄并绑定启动随机数，不能仅凭 PID 判断所有权。每个打开的工程也取得真实路径排他锁，并在同一主机、同一用户范围取得 projectId 的系统排他句柄。路径相同或身份相同的副本均只能有一个可写所有者。另一工作区连接该所有者或隔离只读打开。发现与连接按[IPC 身份和会话契约](../reference/commands-and-tasks.md#local-ipc)绑定实际服务及启动世代，工程写入授权另绑定当前存储世代。Studio、CLI、SDK 和多个 MCP 客户端连接同一实例。MCP 标准输入关闭只关闭对应桥。后台任务依照持久任务状态继续或执行明确的取消动作。停止服务先停止派发、保存状态并处理自有 Worker。

计划入口为 riloom studio、riloom mcp、riloom project、riloom job、riloom export。命令可自动连接或启动所指定工作区的服务；Windows 后台进程使用隐藏窗口启动，不抢占输入焦点；不自动启动或操作目标桌面软件。Web 监听回环地址，默认让操作系统分配空闲端口；显式端口占用时返回具体错误。

## 2. 目标仓库结构

~~~text
Riloom/
  apps/
    studio/                 Web 工作台
    service/                本地服务、IPC、HTTP、进程生命周期
    mcp/                    MCP 传输桥与协议映射
    cli/                    命令行入口
  packages/
    contracts/              JSON Schema、协议 DTO、错误码
    core/                   领域对象、不变量、编辑操作
    application/            命令、用例、事务和权限协调
    storage/                SQLite、不可变文件、备份及迁移
    evaluation/             关键形、动作混合、物理与形变求值
    renderer/               WebGL2 渲染及视口交互接口
    authoring/              可组合制作算法和内建工位
    jobs/                   检查点、调度、预算和 Worker 协议
    plugin-api/             插件契约与版本协商
    sdk/                    对外 TypeScript 客户端
  adapters/
    psd/                    PSD 解码及格式能力
    cubism/                 转换、回读与 SDK 预览的独立能力
    vtube-studio/           连接、身份、运行配置和控制
    image-provider/         可选图像提供方
  tests/
    fixtures/               可再分发的合成输入
    contract/ integration/ e2e/ compatibility/ performance/
  docs/
    assets/                 文档图像与品牌标志
    product/                产品范围与需求
    architecture/           运行结构与架构决策
    reference/              数据、命令、求值与适配契约
    design/                 Studio 交互设计
    security/               信任边界与安全设计
    testing/                测试方案与性能预算
    project/                治理、许可方案与实施路线
  schemas/                  发行的工程与插件 Schema
  examples/                 小型可再分发示例
  scripts/                  构建、校验、发行入口
~~~

应用目录随对应功能建立。

## 3. 依赖规则与模块责任

- contracts 使用平台无关类型及 JSON Schema；core 依赖 contracts。
- evaluation、authoring 依赖 core；不得导入 UI、MCP、Node 文件系统或目标软件客户端。
- application 依赖核心和存储、任务、插件的端口接口；具体实现由 service 装配。
- storage 和各 adapter 实现端口，不相互调用宿主入口。adapter 不直接写工程数据库。
- renderer 消费求值结果，管理 GPU 资源；业务状态和表情仲裁归 evaluation。
- Studio 本地即时预览调用相同 evaluation 版本；持久编辑通过 application。前端缓存只保存可重建视图。
- MCP、CLI、HTTP 只映射同一 CommandSpec。任何新增入口必须经过相同校验、权限及事务。
- 使用依赖图检查、包导出清单和禁止跨包内部路径导入规则阻止反向依赖。

这些边界由模块职责决定。只有独立消费者、接口或计算隔离需求形成新的包；小型工具函数保留在所属模块。

## 4. 技术基线

| 对象 | 设计选择 | 理由与约束 |
| --- | --- | --- |
| 核心与服务 | TypeScript 严格模式，Node.js 24 LTS 基线 | 共享领域类型与求值逻辑，首个实现阶段锁定补丁版本 |
| 包管理与构建 | pnpm workspace、锁文件、分包构建 | 依赖与构建可复现；安装脚本显式允许 |
| Studio | React、TypeScript、Vite、CSS 设计变量 | 复杂编辑状态和组件生命周期清楚；渲染循环独立于 React |
| 存储 | SQLite，WAL、外键和持久提交；文件内容寻址 | 真实事务和可恢复任务；大素材不进入状态 JSON |
| 协议源 | JSON Schema 2020-12 + 生成类型/文档 | Web/MCP/CLI 的契约具有唯一来源 |
| 渲染 | 自有 WebGL2 renderer，离线播放器复用 | 核心制作与预览可独立构建 |
| 计算 | 受管理子进程；纯函数可使用 Worker | 隔离崩溃、预算和重任务；Node 进程边界本身不授予沙箱保证 |
| 验证 | Vitest、属性测试、协议驱动、Playwright | 覆盖数值不变量、真实传输和界面任务 |
| 格式与审查 | ESLint、Prettier、中文权威文档 | 明确规则；工具检查与语义审查各负其责 |

具体包版本、SQLite 驱动及原生依赖支持矩阵由 M1 的跨平台验证锁定；随后变更按 ADR 和兼容合同处理。采用原生计算语言的触发条件是已测瓶颈与明确收益，首版不建立额外语言服务。

## 5. 插件与服务生命周期

插件分为数据配方、受信任代码插件和外部服务适配。数据配方只能调用已注册命令；代码插件显式安装后在独立进程运行，通过版本握手与宿主通信。首版代码插件属于用户主动信任的软件，不能加载工程自带的可执行内容。

握手包含 pluginId、version、protocolVersion、capabilities、各扩展点的 input/outputSchema、资源需求、依赖和许可。导入器与工位返回制作候选，检查器返回检查结果，导出器返回交付结果，追踪源提供参数帧流，具体类型见[插件结果与流](../reference/commands-and-tasks.md#plugin-results)。卸载或版本切换先停止新派发、核对在途效果、保存任务状态并释放资源，追踪流按所属世代停止和释放输入。

详细接口见[命令与任务](../reference/commands-and-tasks.md)，安全边界见[安全与资源](../security/design.md)。
