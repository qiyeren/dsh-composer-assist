# Fork Notice · 分叉声明

> **本仓库是第三方非官方分叉，不是原作者发布或授权的版本。请务必先读本文件。**

## 来源与原因

- 原仓库：[Lphehe/dsh-composer-assist](https://github.com/Lphehe/dsh-composer-assist)（v0.1.1，`b626b67` / `2aef8fc`）。
- 本分叉：[qiyeren/dsh-composer-assist](https://github.com/qiyeren/dsh-composer-assist)，版本 **0.2.0**。
- 提交给原作者的修复 PR：[#19](https://github.com/Lphehe/dsh-composer-assist/pull/19)（对 2026-10-23 静态审查 13 个 issue 的低风险修复）。
- 分叉原因：原作者自 2026-11-03 起无提交，13 个 issue 与 PR #19 均无回应、无合并。等待上游合并无法让已确认的缺陷（清空数字设置存 0、失败静默、探针常驻、默认直起 git 子进程等）在本机得到修复，故建立可独立安装维护的分叉版本。

## 许可风险（重要，须如实告知）

原仓库 [LICENSE](LICENSE) 第 8 行规定：

> 未经著作权人事先书面许可，不得修改本软件、制作衍生版本或分发修改版本。

本分叉包含对原程序代码的修改，并以 tgz 形式分发修改版本；**目前未见著作权人书面许可的记录**。issue [#10](https://github.com/Lphehe/dsh-composer-assist/issues/10) 正是质疑「禁止修改」与「接受外部补丁」的冲突，原作者尚未回应。

历史补充：上游较早的 [0877c903](https://github.com/Lphehe/dsh-composer-assist/commit/0877c9038fbf2f96869495b18a9ab5751bfdfaa7) 提交使用 MIT 许可；其中部分程序文件与后来的上游版本字节相同，上游 [v0.1.1 发布说明](https://github.com/Lphehe/dsh-composer-assist/releases/tag/v0.1.1)也表示不会撤销此前已合法取得的授权。当前分叉还包含后续修改及改证后的文档；仅凭文件相同或历史许可，不能断定整个分叉的分发权利，具体许可链仍须逐项判断。

因此本分叉的定位与限制：

1. **优先路径仍是 PR**：修复已提交 [#19](https://github.com/Lphehe/dsh-composer-assist/pull/19)，原作者回归后可审阅、cherry-pick 或关闭。是否允许修改、制作衍生版本及分发应由著作权人明确授权；不能将未来合并 PR 视为此前已获得事先书面许可。
2. **本分叉为「自用 + 公开源码备份」**：提供可复现的构建与安装方式，供本机使用及同样受该缺陷影响的用户评估；**不发布到 npm registry**（不占用官方包名版本），仅通过 GitHub Release 附 tgz。
3. **不声称任何授权或背书**：不宣称获得原作者许可、不代表官方、不修改 LICENSE 原文（LICENSE 全文保留，见本仓库根目录）。
4. **若原作者反对**：请通过 [本仓库 Issues](https://github.com/qiyeren/dsh-composer-assist/issues) 或上游 issue 告知，本分叉将停止分发并删除 Release/tgz。
5. **继续使用的判断由安装者自行作出**：如你所在司法辖区或组织对「源码可见但禁止修改」条款的效力有要求，请自行确认；本文件不构成法律意见。

## 本分叉相对 v0.1.1 改了什么

见 [CHANGELOG.md](CHANGELOG.md) 的「0.1.2」「0.1.3」和「0.2.0」节。概要：修复 #11/#12/#6/#13/#7/#8/#9(部分)/#2/#3，新增默认关闭的诊断模式与 Git 上下文开关，为预测失败提示增加关闭按钮，并将润色改为预览后主动复制。

## 安装

从 [Releases](https://github.com/qiyeren/dsh-composer-assist/releases) 下载 `dsh-composer-assist-0.2.0.tgz`，在 DSH 中：

```text
plugin_manager install_bundle  <tgz 的本地绝对路径或 URL>
```

或 CLI profile：

```bash
dsh plugin --profile web add https://github.com/qiyeren/dsh-composer-assist/releases/download/v0.2.0/dsh-composer-assist-0.2.0.tgz
```

安装后建议检查：设置 → 输入框预测 → 「诊断模式」与「在上下文里附 Git 状态」应默认关闭；清空任一数字输入框后预测仍正常；断网或清空模型配置时建议栏应显示失败原因。

## 验证

在源码仓库中运行 `node --check index.js`、`node --check client.js` 和 `node selfcheck.mjs`，并按发布说明运行润色相关回归测试。0.1.3 的 DSH 桌面端真实失败场景尚未完成手动验证；0.2.0 的桌面预览验证状态以发布说明为准。

---

*Upstream: Lphehe/dsh-composer-assist · Fork: qiyeren/dsh-composer-assist · PR: #19 · License caveat above applies.*
