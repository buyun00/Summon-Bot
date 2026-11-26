[English](MACOS_SIGNING.md) | [简体中文](MACOS_SIGNING.zh-CN.md)

# macOS Developer ID 签名与公证

GitHub Releases 发布的 macOS Apple Silicon（`arm64`）DMG 使用 **Developer ID Application** 签名与 Hardened Runtime，并由 Apple 公证服务（notarytool）完成公证后将票据（staple）附加至 `.app`。缺少签名材料或公证失败时，正式发布流程会中止。

macOS 端通过 GitHub Releases 分发，Tauri 应用 ID 为 `org.lin0.relay.desktop.tauri`，产品展示名为 `Summon Bot`，无需创建 Mac App Store 应用记录；已安装客户端会自动在后台下载公证新版 DMG，点击头像菜单「安装更新」即可一键替换并重启。

## 1. 申请 Developer ID Application 证书

CSR（证书签名请求）与私钥在本机私有目录管理，仅上传 CSR 文件，私钥始终留在本机：
`C:\Users\win11\.codex\private\summon-macos-signing\Summon-Developer-ID.certSigningRequest`

1. 使用账户持有人身份登录 [Apple Developer](https://developer.apple.com/account/)，切换至团队 `6Y29E7PSVF`。
2. 进入「证书、标识符和描述文件」→「Certificates / 证书」→ 点击「＋」。
3. 选择 **Developer ID Application**；若提示选择证书颁发机构，选择 **G2 Sub-CA**。
4. 点击 Choose File 上传上述 `.certSigningRequest` 文件 → Continue，下载生成的 `.cer` 证书文件（切勿重新生成新的 CSR 或上传 `.key` 私钥）。

参考：[Apple：创建 Developer ID 证书](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)。

## 2. 写入 GitHub Secrets 与触发发布

配置脚本 `scripts/macos/signing.py configure <cer文件>` 会自动核对证书类型、团队 ID、有效期及与本机私钥的匹配关系，封装带随机密码的 PKCS#12，并通过标准输入写入本仓库 GitHub Secrets：

- `SUMMON_MACOS_P12_BASE64`
- `SUMMON_MACOS_P12_PASSWORD`

> 在 PowerShell 中调用该 Python 脚本时，如遇子进程无法读取系统 `gh` 凭据，可临时将 `gh auth token` 的输出注入子进程的 `GH_TOKEN` 环境变量并在结束后清除，不要把 token 打印到终端或日志。

Apple 公证环节直接复用仓库已有的 App Store Connect API 凭据（`SUMMON_ASC_PRIVATE_KEY`、`SUMMON_ASC_KEY_ID`、`SUMMON_ASC_ISSUER_ID`），不使用 APNs 私钥。参考：[Apple TN3147：迁移至最新公证工具](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool)。

配置完成后，可通过以下指令单独触发 macOS 正式构建与发布（或在推送 `release.json` 版本变更时随全平台自动发布）：

```powershell
gh workflow run client-releases.yml --repo buyun00/Summon-Bot --ref main -f platform=macos-tauri
```

GitHub Mac runner 会导入签名证书，构建 Apple Silicon `arm64` Tauri 应用并提交 Apple 公证，公证通过并附加票据后生成并发布 DMG 至 `client-macos-arm64-tauri` 标签。

## 3. 安装效果说明

- 新发布的签名公证 DMG 在 macOS 上直接打开时，不再因“无法验证开发者”而被 Gatekeeper 拦截；系统仍可能按常规显示“从互联网下载，是否打开”确认弹窗。
- 此前下载的未签名旧包不会自动获得签名，需重新下载最新发布的 DMG 手动覆盖安装。
