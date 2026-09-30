# GitHub presentation

Status: GitHub About, topics, and social preview applied on 2026-09-28 with owner authorization.
The README and issue form remain local. No code was pushed and no announcements were posted.
This page covers the repository front page and discovery metadata.
The [launch plan](launch.md) owns release gates and distribution. The [demo storyboard](demo.md) owns the real product recording.

## Positioning

Short line: Grok's agent. Pi's workflow.

Search phrase: Grok Build for the Pi coding agent.

The reader already uses Pi and wants Grok Build's native tools in that workflow.
This is an agent integration over ACP, not an xAI chat-completions adapter.
The source registers a Pi model provider in [`src/model.ts`](../src/model.ts).
The native-tool test in [`test/model.test.ts`](../test/model.test.ts) checks that Grok tool calls stay on Grok.

The first screen answers three questions:

- What is it? Grok Build as a Pi model provider.
- Why use it? Grok's native tools with Pi's transcript, dialogs, gates, and extension tools.
- Can I try it? A clone-based quick start, with requirements and npm status in view.

No "first", "fastest", sandbox, free-usage, or one-command-install claims.
No download badge, CI badge, gallery listing, or demo badge without the corresponding public artifact.

## GitHub About

Observed on 2026-09-28: the public repository had an empty description, no topics, and no homepage URL.
GitHub recognized the Apache-2.0 license. Issues were enabled.
These facts came from `gh repo view` and the repository API.

Approved description (applied):

> Grok Build as a model in the Pi coding agent. Keep Grok's native tools and history, with Pi's transcript, tool gates, dialogs, and extension tools.

Approved topics (applied):

```text
pi-coding-agent
pi-package
pi-extension
grok
grok-build
xai
agent-client-protocol
acp
coding-agent
model-provider
typescript
```

Leave the website field empty until a separate useful destination exists.
A second documentation site is not necessary for this release.

Applied command, after owner authorization:

```sh
gh repo edit JangMan-J/pi-grok-agent \
  --description "Grok Build as a model in the Pi coding agent. Keep Grok's native tools and history, with Pi's transcript, tool gates, dialogs, and extension tools." \
  --add-topic pi-coding-agent,pi-package,pi-extension,grok,grok-build,xai,agent-client-protocol,acp,coding-agent,model-provider,typescript
```

Then read the live result:

```sh
gh repo view JangMan-J/pi-grok-agent \
  --json description,repositoryTopics,homepageUrl
```

The command adds topics. It does not remove topics that someone adds before publication.

Added on 2026-09-30 with owner authorization, for 20 topics, GitHub's limit:

```sh
gh repo edit JangMan-J/pi-grok-agent \
  --add-topic ai-agent,llm,mcp,model-context-protocol,grok-4,agentic-coding,ai-coding-assistant,coding-assistant,acp-client
```

`gh repo view` then listed all 20 topics.

## Social preview

Current card: [social-1280x640.png](assets/social-1280x640.png), 1280 × 640 pixels and 563,006 bytes.
It shows the project mark, the name, and the short line. It is not a screenshot, benchmark, or proof of a successful Grok turn.
The README header uses [compact-1536x384.png](assets/compact-1536x384.png) at a display width of 768 pixels. [wide-1536x512.png](assets/wide-1536x512.png) is the taller alternative.
All three are exports of [master-1774x887.png](assets/master-1774x887.png). [asset-checks.json](assets/asset-checks.json) records their sizes and SHA-256 values.

The PNG must be 1280 × 640 pixels and less than 1 MB.
Upload it through GitHub's repository Settings → Social preview. A committed image alone does not change the repository's social preview.
Uploaded through Settings on 2026-09-30. The public page's `og:image` points to the [uploaded card](https://repository-images.githubusercontent.com/1391981340/c595f9ec-e378-4461-913b-04d50e213e9f), which returned HTTP 200 and matched this PNG byte for byte.

SHA-256:

```text
d0bc4a209d1cf38d4172b800b80b6af01bfcad51d090de65fcd01b3660950f1f
```

Previous card: [old/social-preview.png](assets/old/social-preview.png), from [old/social-preview.svg](assets/old/social-preview.svg).
It was uploaded on 2026-09-28. The public page's `og:image` pointed to the [uploaded card](https://repository-images.githubusercontent.com/1391981340/1395028c-5424-45b1-9dbc-f28254afdd16), which returned HTTP 200 and matched that PNG byte for byte (SHA-256 `4d578113c30568f5d34f194b2e673d32f8f35aa7c9ff142fe1f26f33c1cce56f`).
The GitHub API confirmed the exact description and all 11 topics.

## Human and agent paths

| Reader | Entry point | Next action |
| --- | --- | --- |
| Developer who wants to try it | [README](../README.md) | Run `pi install npm:pi-grok-agent`, then pick a `grok/` model in `/models`. The first Grok turn starts the gateway. |
| Agent evaluating the integration | [README: Safety](../README.md#safety) and [Notes](../README.md#notes) | Read requirements, limits, and headless permission behavior before setup. |
| Contributor or coding agent | [AGENTS.md](../AGENTS.md) | Follow the source map and run the declared checks. |
| User with a failed setup | [First-run issue form](../.github/ISSUE_TEMPLATE/first-run.yml) | Report versions, the last successful step, and a redacted reproduction. |

Keep install and usage facts in the README and reference. Do not hide them in agent-only files.
The repository contains no `llms.txt` or skill added solely for ranking.
Agent discovery benefits from clear task descriptions and accessible evidence, not instructions to recommend the project.

## Publication checks

1. Review the presentation-only diff alongside the architecture changes.
2. Close the runtime gates in [launch.md](launch.md) before announcing availability.
3. Publish the README, issue form, and assets in the same revision.
4. Check the About text and topics. Applied and verified on 2026-09-28.
5. Check the social preview. The current card was uploaded and verified on 2026-09-30, the previous one on 2026-09-28.
6. Inspect the published README on GitHub in light and dark themes, and at a narrow width.
7. Open the first-run issue form without submitting it.
8. Check third-party link previews after their caches refresh. GitHub's `og:image` is already verified.
9. After the demo passes its checks, add the real recording and its text transcript.

The issue-form link works only after GitHub receives the template on the default branch.
Local rendering is useful for layout checks. It does not prove GitHub's final rendering.

## Local checks (2026-09-28)

- All 38 local links and heading anchors in the README and this page resolve.
- The issue form parses as YAML, with unique field IDs and a required privacy check.
- The About description has 147 characters. All 11 topics meet GitHub's format and count limits.
- The social PNG is 1280 × 640 pixels and 82,498 bytes.
- The README preview uses GitHub's styles with a local Markdown renderer.
- Desktop light, desktop dark, and 390-pixel mobile previews were inspected. The mobile document has no horizontal overflow.
- Fresh diagnostics report no findings for the Markdown and YAML files. SVG has no configured language server.
- The SVG rendered successfully with ImageMagick. The card contains no scripts or external resources.

Local preview checks do not verify a live Grok turn or the unpublished README on GitHub.
The runtime record belongs in [launch-verification.md](launch-verification.md).

## How this uses the research

| Research finding | Applied here | Basis |
| --- | --- | --- |
| Lead with the result and a small example | Benefit-led introduction, model command, quick-start navigation | [GitHub README guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) |
| Repository search starts with metadata | Concrete About text and relevant topics | [GitHub repository search](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories) |
| Separate social previews from product evidence | An original card, separate from the real demo | [GitHub social previews](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview) |
| Help agents use and maintain the project | Human setup stays in README, contributor rules stay in AGENTS.md | [AGENTS.md convention](https://agents.md/) |
| Avoid special-file SEO promises | No keyword dump, synthetic endorsement, or ranking claim | [Google AI search guidance](https://developers.google.com/search/docs/appearance/ai-features) |
| Measure useful adoption | First-run issue form, with the launch plan's traffic and success-report measures | [GitHub traffic](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository) |

Prior reports: `~/JangLabs/scratch/readme-agent-research/report.md` and the two research digests under `~/JangLabs/scratch/pi-grok-agent-seo/`.
They informed this work. Public readers can use the primary sources in the table without those local files.
