![Riloom brand mark](docs/assets/riloom-mark.svg)

# Riloom · 形织

**A local-first, programmable workbench for 2D character authoring.**

[![Stage: Design](https://img.shields.io/badge/Stage-Design-7C3AED)](#status)
[![Code: Apache-2.0](https://img.shields.io/badge/Code-Apache--2.0-2563EB)](LICENSE)
[![Docs: CC BY 4.0](https://img.shields.io/badge/Docs-CC%20BY%204.0-2563EB)](LICENSE)

[简体中文](README.md) · [Get started](#quick-start) · [Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md) · [Roadmap](docs/project/roadmap.md)

## Overview

Riloom is designed for character artists, model creators, and automation tool developers. It brings layered artwork, mesh rigging, expressions and outfits, motion and physics, and real-time preview into one authoring project. Its first target ecosystem is Live2D.

The design connects two ways of working. Riloom Studio provides a canvas-centered web workbench, while MCP, CLI, and SDK clients expose the same authoring capabilities to automation tools. Direct editing and station recipes share project data and operation rules, so creators can choose a workflow that suits their work.

<a id="status"></a>
## Project status

The project is in the **M0 design stage**. This repository provides product requirements, architecture, data and interface contracts, workbench interaction, test plans, an implementation roadmap, and documentation tooling.

The first version progresses through the project foundation, free-form authoring, expression and repair workflows, and native integration with standalone delivery. See the [roadmap](docs/project/roadmap.md) for each stage and its completion criteria.

## Designed capabilities

- **Artwork and components** — Import PSD and PNG files, organize layers, masks, and selections, and prepare repainting, assembly, and garment-opening separation.
- **Meshes and rigging** — Edit meshes, UVs, parent controllers, and multi-axis keyforms for asymmetric, non-human, and multi-limbed structures.
- **Expressions and motion** — Compose expressions, outfits, mouth shapes, motion curves, and physics while coordinating tracking and idle animation.
- **Shared preview and repair** — Inspect poses, draw order, and trajectories from the same evaluation result, then locate defects and replay repaired scenes.
- **Composition and automation** — Edit project objects directly or combine authoring operations through station recipes, MCP, CLI, and SDK clients.
- **Standalone delivery** — Export editable projects, offline runtime packages, and outputs for target applications.

The first version targets a local, single-user workspace. See [Product and scope](docs/product/overview.md) for the full capability scope and platform targets.

<a id="quick-start"></a>
## Get started

### Read the design

The design documents and project policies are in Simplified Chinese.

1. Read [Product and scope](docs/product/overview.md) for authoring scenarios and first-version goals.
2. Read [Product requirements](docs/product/requirements.md) for expected behavior and acceptance criteria.
3. Use the [documentation index](docs/README.md) to find architecture, interface, interaction, and testing material.

### Check the documentation

Use **Node.js 24 LTS** and run this command from the repository root.

```sh
node scripts/check-docs.mjs
```

The command checks local links, section anchors, JSON, and text format. It exits with code 0 on success and identifies files to correct on failure. See the [contribution guide](CONTRIBUTING.md) for editing and review steps.

## Documentation

| Task | Documentation |
| --- | --- |
| Understand modules and technology choices | [Architecture](docs/architecture/overview.md) · [Architecture decisions](docs/architecture/decisions.md) |
| Look up project data and calling conventions | [Project format](docs/reference/project-format.md) · [Commands and tasks](docs/reference/commands-and-tasks.md) |
| Design authoring and preview interactions | [Authoring and evaluation](docs/reference/authoring-and-evaluation.md) · [Studio interaction](docs/design/studio.md) |
| Integrate applications and deliver work | [Integrations and delivery](docs/reference/integrations-and-delivery.md) |
| Plan security and testing | [Security design](docs/security/design.md) · [Test strategy](docs/testing/strategy.md) |
| Contribute and maintain the project | [Contribution guide](CONTRIBUTING.md) · [Project governance](docs/project/governance.md) |

## Contributing

Submit design proposals and defect reports through repository Issues, and discuss changes through Pull Requests. Read the [contribution guide](CONTRIBUTING.md) and [code of conduct](CODE_OF_CONDUCT.md) before contributing. Contributions use [DCO 1.1](DCO).

Follow the [security reporting process](SECURITY.md) for security issues. Versioning, maintenance, and compatibility policies are described in [project governance](docs/project/governance.md).

## Licensing

| Material | License |
| --- | --- |
| Project-owned source code, scripts, and engineering configuration | Apache-2.0 |
| Project-owned documentation and design data | CC BY 4.0 |
| Project-owned synthetic test assets and minimal examples | CC0 1.0 |

See [LICENSE](LICENSE) for material scopes, complete license texts, and logo permissions. Integration and distribution conditions for target ecosystems are described in [Licensing and distribution](docs/project/licensing.md).
