# macOS Developer ID 签名与公证

2026-11-05 起，GitHub 的 macOS Apple Silicon（arm64） DMG/ZIP 发布流程要求 Developer ID Application 签名、Hardened Runtime、Apple 公证并将公证票据附加到 App。缺少材料或公证失败时停止发布，不再回退到 ad-hoc 包。Windows、Android、iOS 的签名方式不变。

macOS 继续通过 GitHub Releases 分发，应用 ID 沿用 `org.lin0.relay.desktop`，展示名为 Summon Bot；不需要创建 Mac App Store 应用记录。安装更新仍下载 DMG 手动覆盖。

## 只需补一张证书

现有 iOS Apple Distribution 证书不能用于站外 macOS 分发。需要 **Developer ID Application**；本项目分发 DMG/ZIP，不需要 Developer ID Installer（用于 PKG），也不需要 Mac App Distribution。

证书请求及对应私钥已在本机私有目录准备。只上传下面的 CSR，私钥留在本机：

`C:\Users\win11\.codex\private\summon-macos-signing\Summon-Developer-ID.certSigningRequest`

1. 用账户持有人登录 [Apple Developer](https://developer.apple.com/account/)，选择团队 `6Y29E7PSVF`。
2. 进入「证书、标识符和描述文件」→「证书 / Certificates」→「＋」。
3. 选择 **Developer ID Application**；若先出现 Developer ID 分类，继续后再选 Application。
4. 如果要求选择证书颁发机构，选择当前 **G2 Sub-CA**，用于现代 Xcode 签名。
5. 点击 Choose File，选择上面的 `.certSigningRequest` 文件 → Continue。
6. 下载生成的 `.cer`，保存到下载目录，把路径告诉 Codex 即可。不要重新生成另一份 CSR，也不要上传 `.key` 私钥。

Apple 说明：[Developer ID 证书](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)。

## 证书到位后的自动化

配置入口是 `scripts/macos/signing.py configure <cer文件>`。它核对证书类型、团队、有效期及是否匹配本机私钥，封装带随机密码的 PKCS#12，通过标准输入写入本项目 GitHub Secrets：

- `SUMMON_MACOS_P12_BASE64`
- `SUMMON_MACOS_P12_PASSWORD`

如果从 PowerShell 启动 Python，先把当前 `gh auth token` 的结果放入子进程的 `GH_TOKEN` 环境变量，结束后清除，避免 Windows 子进程无法读取系统凭据。不要输出 token。

公证复用本仓库现有的 `SUMMON_ASC_PRIVATE_KEY`、`SUMMON_ASC_KEY_ID`、`SUMMON_ASC_ISSUER_ID`，不使用 APNs 私钥。[Apple 明确支持上传与公证复用 App Store Connect API Key](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool)。

配置完成后运行：

```powershell
gh workflow run client-releases.yml --repo buyun00/Summon-Bot --ref main -f platform=macos
```

GitHub Mac runner 自动导入签名证书，生成 仅支持 Apple Silicon 的应用（不支持 Intel），签名并提交 Apple 公证，成功后附加票据，再生成并发布 DMG/ZIP。公证未成功不会替换现有公开发行包。首次公证可能需要 Apple 较长时间处理，以实际运行结果为准。

签名后正常从 GitHub 下载的新版应不再因“无法验证开发者”要求到设置里手动放行；macOS 仍可能显示正常的“从互联网下载，是否打开”提示。此前已经下载的旧包不会自动获得签名，需要下载新发布的包。

本次只完成签名与公证接入，不自动改变为应用内静默更新。正式可用状态以新签名包实际完成公证并发布为准。
