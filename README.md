# 输入框预测 · Composer Assist（社区分叉版 0.2.0）

> ⚠️ **本仓库是 [Lphehe/dsh-composer-assist](https://github.com/Lphehe/dsh-composer-assist) 的非官方分叉**（原作者不活跃，修复 PR [#19](https://github.com/Lphehe/dsh-composer-assist/pull/19) 未获回应）。原 LICENSE 禁止未经书面许可的修改/衍生/分发——**安装前请先读 [FORK_NOTICE.md](FORK_NOTICE.md)**，其中完整说明了许可风险、不发布 npm、以及原作者反对即下架的承诺。

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供下一条消息预测、草稿补全和提示词润色。根据当前对话给出建议，按 **Tab** 填入输入框，由你决定是否发送。

A DeepSeek Harness plugin for next-message prediction, draft completion, and prompt polishing. Press **Tab** to insert a suggestion; you decide whether to send it.

<p align="center">
  <img src="screenshots/composer-bar.jpg" alt="输入框上方的预测建议栏" width="720">
</p>
<p align="center"><sub>预测建议（旧版本示例，不代表 0.2.0 润色界面）· Prediction example from an earlier version</sub></p>

## 功能 · Features

- **预测下一条消息**：回答结束后自动预测，也可手动触发；支持多个候选。
- **补全草稿**：输入时建议自然的后半句。
- **润色提示词**：手动生成预览，检查后主动复制；不自动替换或发送草稿，以免破坏结构化引用。
- **会话与草稿保护**：建议按会话保存，过期结果不会覆盖新的输入。

Predict the next message automatically or on demand, complete a draft, and preview a polished prompt before explicitly copying it. Polishing never overwrites or sends the draft; observed input changes invalidate the preview.

**Tab** 接受建议，**Esc** 隐藏；草稿为空时可用 **← / →** 切换候选。接受只填入草稿，不会自动发送。

**Tab** inserts a suggestion, **Esc** hides it, and **← / →** switch candidates when the draft is empty. Accepting never sends the message.

> **预测功能的现有限制：**本版的结构保护仅针对润色。接受预测或补全仍使用宿主的纯文本整稿替换，可能移除草稿中的 `@` 引用或结构化引用；含此类内容的草稿请勿使用该接受操作。
>
> **Prediction limitation:** the new protection applies to polishing only. Accepting a prediction or completion still replaces the draft as plain text and can remove structured references; avoid accepting suggestions in drafts that contain them.

### 润色预览 · Polish preview

在输入框有草稿时点击「润色」，等待结果并检查原稿与润色稿。预览和复制的是**纯文本**：附件不参与润色，`@` 引用的语义结构也不会随复制结果保留；手动粘贴替换草稿可能丢失引用。插件不会自动改动或发送原稿；点击复制后已经发起的剪贴板写入无法通过关闭预览撤销。界面检测到草稿、附件或会话变化时会隐藏旧结果并提示重新润色；编辑器版本在关键操作时同步复核，但附件或输入阶段若在界面渲染前变化并恢复，可能无法观察到。这些检查并非原子写回保护。若宿主没有提供所需的草稿版本、版本捕获接口或附件状态，润色会保守停用并提示；同一会话同时存在无法对应的多个输入栏时也会暂时拒绝润色。

Click **Polish** to preview the original and rewritten text. Copying yields plain text only: attachments are not sent and structured reference identities are not preserved in the copied result. Manually replacing a draft can therefore discard references; the plugin never changes or sends the original automatically. When an input change is observed, the old result is hidden. The editor revision is rechecked at action time; attachment or phase changes that occur and revert before rendering may not be observed. Hosts lacking the required draft revision, revision-capture action or attachment state disable polishing with an explanation. Ambiguous multiple composers for the same session are also rejected.

## 安装 · Install

在 Harness 中让助手使用 `plugin_manager install_bundle` 安装以下预打包版本，无需构建：

Ask the Harness assistant to install this prepacked bundle with `plugin_manager install_bundle`:

```text
https://github.com/qiyeren/dsh-composer-assist/releases/download/v0.2.0/dsh-composer-assist-0.2.0.tgz
```

普通 CLI profile 也可以使用下列命令；把 `web` 替换为你的 profile 名。Desktop 请使用插件管理器。

For a CLI profile, replace `web` with your profile name. Use Plugin Manager for Desktop.

```bash
dsh plugin --profile web add https://github.com/qiyeren/dsh-composer-assist/releases/download/v0.2.0/dsh-composer-assist-0.2.0.tgz
```

也可以克隆本仓库，然后通过 `plugin_manager install_bundle` 安装克隆目录的绝对路径。

You can also clone this repository and install its absolute directory path with `plugin_manager install_bundle`.

```bash
git clone https://github.com/qiyeren/dsh-composer-assist.git
```

## 设置 · Settings

在 **设置 → 输入框预测** 中选择模式、显示位置、预测模型和超时等选项。接受学习默认关闭；置信度是模型自评，不是经过校准的正确率。

Use **Settings → Composer prediction** to choose the mode, display, model, timeout, and other options. Acceptance learning is off by default. Confidence is a model estimate, not calibrated accuracy.

<p align="center">
  <img src="screenshots/settings.jpg" alt="输入框预测设置页面" width="560">
</p>
<p align="center"><sub>设置页面示例 · Settings example</sub></p>

预测与手动润色都会发起可能计费的模型调用。预测上下文包括近期对话、有限的工具结果和工作区顶层文件名；**默认不含 Git 状态**（可在设置中按需开启）；不会读取工作区文件内容。润色请求只发送草稿与必要指令，不附加会话历史、工作区文件名、Git 状态或学习提示。

Predictions and manual polishing make model calls that may incur charges. Prediction context includes recent conversation, bounded tool results and top-level filenames; **Git status is off by default**. Polishing sends only the draft and necessary instructions, without conversation history, workspace filenames, Git status or learning hints.

## 开发进展 · Development update

自动续接、动态工作流、监控、角色库及新增决策能力正在开发，**不包含在公开的 v0.1.1 安装包中**。它们的表现和验收取决于宿主、会话及模型配置。

Automatic continuation, dynamic workflows, monitoring, roles, and newer decision features are in development and **are not included in the public v0.1.1 bundle**. Their behavior and verification depend on the host, session, and model configuration.

## 自检与反馈 · Self-check and feedback

在源码仓库运行 `node selfcheck.mjs`，以及 `node --test tests/polish-host.test.mjs tests/polish-client.test.mjs` 检查润色逻辑。这些测试使用隔离替身，不调用真实模型；不能替代 DSH 桌面界面实测。问题和建议欢迎加入 QQ 群 **1129389677**。

In the source repository, run `node selfcheck.mjs` and `node --test tests/polish-host.test.mjs tests/polish-client.test.mjs`. These isolated tests do not call a real model and do not replace testing in the DSH desktop UI.

## 设计参考 · Design references

润色预览和草稿过期保护参考了同名社区插件的交互思路，包括 [1321928757/dsh-prompt-polish](https://github.com/1321928757/dsh-prompt-polish/tree/f6d6b28e0ca957a3a46a36bccbbfe7e4d518fa94) 和 [CTX666666/dsh-prompt-polish](https://github.com/CTX666666/dsh-prompt-polish/tree/e038d16ee7cb4ad23cb2fe889bdc5d6a4a6cb46f)；本分叉独立实现，未复制其代码或提示词。它们的许可不改变本分叉的上游许可约束。

The preview and stale-draft safeguards were inspired by the interaction ideas in the two projects above. This fork implements them independently; their licences do not change the upstream licence constraints described below.

## 数据流与隐私 · Data flow and privacy

每次预测发给模型的内容：近期对话文本（有上限）、有限的文本类工具结果、**工作区顶层文件名**；不读取工作区文件内容，凭据形状的文件名会被剔除。默认**不**发送 Git 状态——开启「在上下文里附 Git 状态」后才会为每轮预测启动一次 `git status` 子进程。手动润色仅发送草稿与必要指令；草稿会交给所选模型提供方处理，其数据留存政策由提供方决定。关闭预览会发出取消信号，但无法保证服务商停止处理、计费或撤回已发送内容。预测和润色调用本身不写入会话日志；该行为与宿主文档关于模型可见输入可重建的契约如何衔接仍待核实，插件不会为此擅自把未发送草稿写入日志。

「诊断模式」（默认关闭）用于排查行内预览的对齐问题；关闭时不会有任何诊断上报，Host 也不保留渲染状态。即使开启，上报数据只包含布局数值与阶段标记，**不含草稿文本、候选文本或 ghost 文本**。设置页会显示最近一次预测失败的原因（超时 / 网络 / 其它错误）。

预测失败时建议栏会显示原因，并提供「重试」和「关闭」；关闭只隐藏建议栏，不修改草稿，也不记录忽略反馈。

Predictions send recent conversation text (bounded), limited text tool results, and **top-level workspace file names**; file contents are never read and credential-shaped names are dropped. Git status is **off by default**. Manual polishing sends only the draft and necessary instructions to the selected model provider. Closing the preview signals cancellation, but cannot guarantee that a provider stops processing or billing. Prediction and polish calls are not appended to the session log; how that behavior meets the host's model-input replay contract remains unverified. Diagnostics mode (default off) reports layout/phase data only, never draft, candidate or ghost text.

## 支持的 DSH 版本 · Supported DSH versions

`package.json` 声明 `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`。0.2.1 起 `engines.dsh` 单独决定兼容性并压过 peer 检查；不在此区间的版本安装时会得到明确提示。图标经 `exports["./icon"]` 提供，0.2.0 不识别该形式（故不在支持范围内）。

`package.json` declares `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`. From 0.2.1 `engines.dsh` alone decides compatibility; installing on an unsupported version produces an explicit warning. The icon is exposed via `exports["./icon"]`, which 0.2.0 does not read, so 0.2.0 is out of range.

## 许可证 · License

原创程序代码采用“源码可见、禁止修改”条款，并非开放源代码许可证。允许使用未经修改的版本；未经著作权人事先书面许可，不得修改本软件、制作衍生版本或分发修改版本。完整条款见 [LICENSE](LICENSE)。用户自己的配置、输入、输出和工作流脚本不受本项修改限制。

The original program code is source-available under use-permitted, modification-prohibited terms, not an open-source license. Use of the unmodified software is permitted; modification or derivative versions require the copyright holder's prior written permission. See [LICENSE](LICENSE). These restrictions do not apply to users' own configuration, input, output or workflow scripts.
