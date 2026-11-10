# 架构决策

记录影响运行结构、数据格式、扩展和交付的技术取舍。每项决定说明背景、选择、代价、更换条件及关联需求。

<a id="adr-001"></a>

## ADR-001 本地服务与模块化单体

**背景**

多个操作入口需要共享修订、草稿、任务和外部目标状态。

**决定**

一个工作区一个服务实例，应用核心统一协调。Web、MCP、CLI、SDK 为适配入口。工程以真实路径与本机身份锁保持唯一可写所有者。客户端连接绑定服务及存储世代，并取得当前作用域授权。重计算使用受管理进程。

**选项比较**

每个入口独立持久化会产生并发与状态歧义；微服务增加部署和跨服务事务成本。当前单机工作流适合单体模块边界。

**代价与更换条件**

服务生命周期需要独立管理。若明确新增跨机器多人协作，重新设计身份、同步与部署，保持领域和命令契约。关联需求为 [REQ-09](../product/requirements.md#req-09)、[REQ-10](../product/requirements.md#req-10)、[REQ-12](../product/requirements.md#req-12)。

<a id="adr-002"></a>

## ADR-002 平台无关工程与共享求值

**背景**

自由制作需要独立于目标软件参数命名与内部格式，预览与导出又要保持对应。

**决定**

自有版本化工程格式；纯 evaluation 与 renderer 复用于工作台及离线播放器；目标软件通过显式映射转换。

**选项比较**

直接把某目标格式作为核心会继承其对象、许可和能力限制；各入口分别求值会产生行为分叉。

**代价与更换条件**

维护转换一致性套件和可表达能力报告。若某目标特性无法表达，扩展对应语义并迁移格式，不能隐藏损失。关联需求为 [REQ-03](../product/requirements.md#req-03)、[REQ-04](../product/requirements.md#req-04)、[REQ-05](../product/requirements.md#req-05)、[REQ-06](../product/requirements.md#req-06)、[REQ-07](../product/requirements.md#req-07)、[REQ-08](../product/requirements.md#req-08)、[REQ-15](../product/requirements.md#req-15)、[REQ-17](../product/requirements.md#req-17)、[REQ-22](../product/requirements.md#req-22)。

<a id="adr-003"></a>

## ADR-003 SQLite 与不可变文件

**背景**

编辑、回执、任务和事件需要一起提交，素材又需要大文件和高效复用。

**决定**

SQLite 作为元数据权威。SHA-256 内容寻址文件存大对象。先发布完整文件再提交引用。一致性备份保留固定读视图及资源闭包，恢复接替工程登记并建立新存储世代，旧外部任务先核对实际效果。

**选项比较**

单个 JSON 全量覆盖难以表达多表事务和查询；将所有纹理放数据库会放大备份和读写成本。SHA-256 在拟用语言与平台具备广泛实现。

**代价与更换条件**

孤立 blob 清理、SQLite 驱动分发和一致性备份需要专项验证。备份截止后的外部事实通过原操作和提供方核对，可用外部预算在核对期间受恢复屏障限制。多机并发需求或实际规模超限时，保持存储端口并另作迁移。关联需求为 [REQ-01](../product/requirements.md#req-01)、[REQ-09](../product/requirements.md#req-09)、[REQ-10](../product/requirements.md#req-10)、[REQ-22](../product/requirements.md#req-22)。

<a id="adr-004"></a>

## ADR-004 候选与应用分离

**背景**

自动绘制和复杂算法可能失败，创作者需要保护已完成工程并检查画面。

**决定**

工位读取固定来源，生成 Candidate，应用通过单一事务提交 ChangeSet。默认直接编辑自动保存草稿，由“应用草稿”提交当前会话完整修改。补画采用全画框 PNG 外部往返，提供方为可选路径，保护区按源像素组装，派生素材只替换选定绘画引用。

**选项比较**

工位直接逐项改工程会留下部分结果；把每次编辑都强制变成长审批流程影响创作。草稿、预览和手势聚合提供可用的交互尺度。

**代价与更换条件**

候选需要存储和失效管理。轻量操作可以直接形成可立即应用的候选，但保留相同前提与撤销契约。关联需求为 [REQ-02](../product/requirements.md#req-02)、[REQ-03](../product/requirements.md#req-03)、[REQ-04](../product/requirements.md#req-04)、[REQ-09](../product/requirements.md#req-09)、[REQ-11](../product/requirements.md#req-11)、[REQ-13](../product/requirements.md#req-13)。

<a id="adr-005"></a>

## ADR-005 插件与第三方能力分离

**背景**

导入器、图像服务和目标软件具有不同许可、版本、资源和副作用。

**决定**

有限插件扩展点、能力协商、宿主校验和独立进程。声明式配方使用受限组合；代码插件显式信任。

**选项比较**

任意动态脚本会扩大工程文件的执行权限；把所有 SDK 打包进核心会影响纯核心构建及分发。

**代价与更换条件**

进程通信与版本维护增加成本；支持不可信插件前需平台级隔离。插件边界不改变第三方许可本身。关联需求为 [REQ-14](../product/requirements.md#req-14)、[REQ-15](../product/requirements.md#req-15)、[REQ-16](../product/requirements.md#req-16)、[REQ-18](../product/requirements.md#req-18)、[REQ-20](../product/requirements.md#req-20)。

<a id="adr-006"></a>

## ADR-006 工程格式、命令与插件分别版本化

**背景**

文件保存、工具调用和扩展运行具有不同生命周期。

**决定**

软件用 SemVer；工程和插件拥有独立主版本；命令登记语义版本，恢复任务固定原执行器身份。

**选项比较**

只跟随应用版本会让旧工程、旧任务和插件的兼容条件不清楚；每个内部函数独立版本又产生维护负担。

**代价与更换条件**

需维护 Schema、迁移和兼容矩阵；公开契约改变时执行明确升级，内部无契约变化可随软件发行。关联需求为 [REQ-10](../product/requirements.md#req-10)、[REQ-12](../product/requirements.md#req-12)、[REQ-14](../product/requirements.md#req-14)、[REQ-20](../product/requirements.md#req-20)、[REQ-22](../product/requirements.md#req-22)。

<a id="adr-007"></a>

## ADR-007 制作工程与运行交付分离

**背景**

使用者需要独立运行作品，工程也需要继续编辑。

**决定**

编辑工程、Web 运行包、目标软件包三种产物，分别建立 manifest 与内容允许集合。

**选项比较**

复制整个工作目录会夹带服务依赖、凭据和临时文件；只交运行文件又丢失可编辑来源。

**代价与更换条件**

维护依赖闭包和各格式独立运行测试。新目标生态新增 profile，不扩张已有包的隐含依赖。关联需求为 [REQ-17](../product/requirements.md#req-17)、[REQ-18](../product/requirements.md#req-18)、[REQ-20](../product/requirements.md#req-20)。

<a id="adr-008"></a>

## ADR-008 显式颜色转换与合成边界

**背景**

源颜色编码、分组透明度与嵌套遮罩会改变同一素材的最终画面，导入、预览和转换需要共享可比较语义。

**决定**

原始文件与解码像素独立保留，首版工作副本统一 sRGB。超色域输入默认要求明确处理选择，选定转换随素材保存。Normal 隔离组先合成再施加组透明度，遮罩源使用自身遮罩处理后的覆盖率，并显式区分祖先透明度作用范围。细则集中在[图像与合成契约](../reference/project-format.md#color-management)。

**选项比较**

直接改写原始像素会丢失后续重新转换的来源。把组透明度分发给子项会改变重叠区 Alpha。从未经自身遮罩的源采样会改变嵌套覆盖范围。

**代价与更换条件**

需要保留原始与工作素材、管理隔离组渲染目标并验证遮罩依赖图。新增工作色域或合成算法时升级对应配置与求值语义，并检查旧工程和目标适配。关联需求为 [REQ-01.2](../product/requirements.md#req-01-2)、[REQ-08](../product/requirements.md#req-08)、[REQ-15](../product/requirements.md#req-15)。

<a id="adr-009"></a>

## ADR-009 确定性制作算法

**背景**

控制、关键形、重布网和物理需要在 Studio、离线求值及目标转换之间保持明确语义。

**决定**

首版几何使用 riloom.deformation/1，采用刚性 Rotate、固定对角线三角片 Warp、规则多线性和显式单纯形插值。重布网默认要求覆盖与完整控制链的精确保留证明，采样容差方式由制作者显式选择。有根粒子链使用 riloom.particle-chain/1 的半隐式预测与单向长度投影，保存默认配置、单位和预热进度。公式与边界集中在[制作算法](../reference/authoring-and-evaluation.md#deformation-algorithms)。

**选项比较**

固定分片 Warp 便于表达控制边界与重布网证明，双线性 Warp 的分片内曲率需要另一套保留规则。显式单纯形使稀疏支持域和公共面由工程数据确定。粒子链以固定计算顺序表达根部驱动、阻尼、回正和链长。

**代价与更换条件**

分片边界具有梯度变化，精确保留的区间检查存在计算开销，目标适配需匹配实际算法。算法结果、边界或回退变化时使用新版本和转换候选，按独立算例与预算选择具体实现。关联需求为 [REQ-03](../product/requirements.md#req-03)、[REQ-04](../product/requirements.md#req-04)、[REQ-07](../product/requirements.md#req-07)、[REQ-08](../product/requirements.md#req-08)、[REQ-15](../product/requirements.md#req-15)。
