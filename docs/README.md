# Riloom 文档

面向产品设计、开发、测试与项目维护，按任务提供产品需求、技术方案、参考契约和协作入口。

## 从任务进入

- 确定制作能力与用户结果，阅读[产品范围](product/overview.md)和[产品需求](product/requirements.md)。
- 设计模块与持久化，阅读[架构](architecture/overview.md)、[架构决策](architecture/decisions.md)和[数据格式](reference/project-format.md)。
- 接入制作入口与扩展，阅读[命令与任务](reference/commands-and-tasks.md)、[制作与求值](reference/authoring-and-evaluation.md)和[软件适配](reference/integrations-and-delivery.md)。
- 设计工作台与权限反馈，阅读[Studio 交互](design/studio.md)和[安全设计](security/design.md)。
- 编写验证场景与安排实施，阅读[测试方案](testing/strategy.md)和[路线图](project/roadmap.md)。
- 参与修改与维护发行，阅读[贡献指南](../CONTRIBUTING.md)、[项目治理](project/governance.md)、[行为准则](../CODE_OF_CONDUCT.md)、[根许可](../LICENSE)和[安全报告](../SECURITY.md)。

## 文档职责

| 类型 | 负责内容 | 当前正文 |
| --- | --- | --- |
| 产品说明 | 目标用户、场景、能力与支持范围 | [产品与范围](product/overview.md) |
| 需求 | 触发、结果、异常处理与验收关联 | [产品需求](product/requirements.md) |
| 需求关联数据 | 稳定编号、模块、阶段和验收场景 | [requirements.json](product/requirements.json) |
| 架构方案 | 运行结构、模块边界和技术选型 | [架构总览](architecture/overview.md) |
| 架构决策 | 关键取舍、理由、代价和更换条件 | [决策正文](architecture/decisions.md) |
| 数据参考 | 工程对象、坐标、持久化与格式演进 | [数据与工程格式](reference/project-format.md) |
| 命令参考 | 输入输出、回执、错误、任务和插件协议 | [命令与后台任务](reference/commands-and-tasks.md) |
| 制作参考 | 工位、关键形、表现合成、曲线与物理 | [制作能力与求值](reference/authoring-and-evaluation.md) |
| 适配参考 | 导入、目标软件、转换与独立交付 | [软件适配与交付](reference/integrations-and-delivery.md) |
| 术语参考 | 中英文概念、代码标识与适用语境 | [术语表](reference/glossary.md) |
| 交互设计 | 画布、面板、编辑反馈与可访问性 | [Riloom Studio](design/studio.md) |
| 安全方案 | 信任边界、输入处理、隐私与资源控制 | [安全设计](security/design.md) |
| 测试方案 | 输入、预期、反例、故障位置和性能预算 | [测试与验收](testing/strategy.md) |
| 项目规则 | 职责、审阅、版本、发行和维护 | [项目治理](project/governance.md) |
| 许可与分发 | 已采用许可、贡献接收与分发条件 | [许可与分发](project/licensing.md) |
| 实施计划 | 依赖、切片、技术验证和阶段退出条件 | [实施路线图](project/roadmap.md) |
| 贡献指南 | 修改文档、同步关联与提交审阅的步骤 | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| 图像素材 | 项目首页使用的品牌图像 | [Riloom 标志](assets/riloom-mark.svg) |

## 语言与维护

中文正文维护产品与技术含义，[英文首页](../README.en.md)提供对应英文导航。公共接口与代码标识保持稳定英文，文档译名使用[术语表](reference/glossary.md)。

同一规则的变更在负责正文中完成，其他文档通过具名链接引用。移动正文时同步导航、需求关联和读者入口。具体编辑步骤见[贡献指南](../CONTRIBUTING.md)。
