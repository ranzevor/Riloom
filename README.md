![Riloom 形织标志](docs/assets/riloom-mark.svg)

# Riloom · 形织

**本地优先、可编程的二维角色制作工作台。**

[![Stage: Design](https://img.shields.io/badge/Stage-Design-7C3AED)](#status)
[![Code: Apache-2.0](https://img.shields.io/badge/Code-Apache--2.0-2563EB)](LICENSE)
[![Docs: CC BY 4.0](https://img.shields.io/badge/Docs-CC%20BY%204.0-2563EB)](LICENSE)

[English](README.en.md) · [开始阅读](#quick-start) · [文档](docs/README.md) · [参与贡献](CONTRIBUTING.md) · [路线图](docs/project/roadmap.md)

## 项目概览

Riloom 面向角色美术、模型制作者和自动化工具开发者，将分层素材、网格绑定、表情换装、动作物理和实时预览组织在同一个制作工程中。首个目标生态为 Live2D。

项目设计围绕两类入口展开。Riloom Studio 提供以画布为中心的 Web 工作台，MCP、CLI 和 SDK 为同一套制作能力提供自动化接口。直接编辑与工位配方共用工程数据和操作规则，创作者可以按作品需要选择制作顺序。

<a id="status"></a>
## 当前阶段

当前处于 **M0 项目设计阶段**。仓库提供产品需求、架构、数据与接口契约、工作台交互、测试方案和实施路线，以及文档协作工具。

首版按“工程底座 → 自由制作 → 表现与返修 → 原生适配与独立交付”推进。各阶段的范围和完成条件见[实施路线图](docs/project/roadmap.md)。

## 设计能力

- **素材与组件制作** — 导入 PSD、PNG，组织图层、遮罩和选区，完成补画、拼接及衣口分层。
- **网格与绑定** — 编辑网格、UV、父控制和多轴关键形，支持非对称、非人形及多附肢结构。
- **表情与动作** — 编排表情、衣装、嘴型、动作曲线和物理，协调追踪输入与待机表现。
- **统一预览与返修** — 在同一求值结果上观察姿态、层级和轨迹，定位缺陷并重放修复场景。
- **自由组合与自动化** — 直接操作工程对象，通过工位配方、MCP、CLI 或 SDK 组合制作流程。
- **独立交付** — 输出可编辑工程、离线运行包及目标软件适配产物。

首版工作区采用本地单机、单用户模式。完整功能范围和平台目标见[产品与范围](docs/product/overview.md)。

<a id="quick-start"></a>
## 快速开始

### 阅读设计

1. 从[产品与范围](docs/product/overview.md)了解制作场景和首版目标。
2. 阅读[产品需求](docs/product/requirements.md)，查看具体行为及验收条件。
3. 按[文档导航](docs/README.md)进入架构、接口、交互或测试方案。

### 检查文档

使用 **Node.js 24 LTS**，在仓库根目录执行。

```sh
node scripts/check-docs.mjs
```

命令检查本地链接、章节锚点、JSON 和文本格式，成功时退出码为 0。出现错误时，按输出定位文件并修正。修改与审阅步骤见[贡献指南](CONTRIBUTING.md)。

## 文档导航

| 任务 | 文档 |
| --- | --- |
| 理解模块与技术选择 | [架构总览](docs/architecture/overview.md) · [架构决策](docs/architecture/decisions.md) |
| 查询工程格式与调用接口 | [工程格式](docs/reference/project-format.md) · [命令与任务](docs/reference/commands-and-tasks.md) |
| 设计制作与预览体验 | [制作与求值](docs/reference/authoring-and-evaluation.md) · [Studio 交互](docs/design/studio.md) |
| 对接软件与交付作品 | [软件适配与交付](docs/reference/integrations-and-delivery.md) |
| 制定安全与测试方案 | [安全设计](docs/security/design.md) · [测试方案](docs/testing/strategy.md) |
| 参与开发与维护 | [贡献指南](CONTRIBUTING.md) · [项目治理](docs/project/governance.md) |

## 参与贡献

设计建议和缺陷报告通过仓库 Issues 提交，修改通过 Pull Request 讨论和审阅。开始前请阅读[贡献指南](CONTRIBUTING.md)和[行为准则](CODE_OF_CONDUCT.md)。贡献采用 [DCO 1.1](DCO)。

安全问题按[安全报告流程](SECURITY.md)提交。版本、维护和兼容安排见[项目治理](docs/project/governance.md)。

## 许可

| 材料 | 许可 |
| --- | --- |
| 自有源码、脚本和工程配置 | Apache-2.0 |
| 自有文档和设计数据 | CC BY 4.0 |
| 自有合成测试素材及最小示例 | CC0 1.0 |

各类材料的覆盖范围、完整许可文本和标志授权见 [LICENSE](LICENSE)。目标生态的接入与分发条件见[许可与分发](docs/project/licensing.md)。
