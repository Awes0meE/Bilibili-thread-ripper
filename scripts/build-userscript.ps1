$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$utf8 = New-Object System.Text.UTF8Encoding($false)
$manifest = [System.IO.File]::ReadAllText((Join-Path $projectRoot "manifest.json"), $utf8) | ConvertFrom-Json
$version = [string]$manifest.version
$repository = "https://github.com/MrTangLuyao/Bilibili-thread-ripper"
$scriptUrl = "https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper/main/user_scripts/bilibili-thread-ripper.user.js"

function Read-Source([string]$file) {
  return ([System.IO.File]::ReadAllText((Join-Path $projectRoot $file), $utf8).TrimStart([char]0xFEFF) -replace "`r`n", "`n").TrimEnd([char]10)
}
function Add-Source([System.Text.StringBuilder]$builder, [string]$file) {
  [void]$builder.Append("`n/* $file */`n").Append((Read-Source $file)).Append("`n")
}

# 页面里运行的部分：和扩展同一份代码、同样的顺序，外加扩展侧边栏的设置页。
$pageFiles = @("user_scripts/adapter/storage-shim.js") + @($manifest.content_scripts | ForEach-Object { $_.js })
$sitePatterns = @($manifest.content_scripts | ForEach-Object { $_.matches } | Where-Object { $_ -ne "https://*.bilibili.com/*" } | Select-Object -Unique)
$popupHtml = [regex]::Match((Read-Source "popup/popup.html"), "(?s)<main>.*</main>").Value
if (-not $popupHtml) { throw "popup/popup.html 里没有找到 <main>。" }

$header = @(
  "// ==UserScript==",
  "// @name         $($manifest.name)",
  "// @namespace    $repository",
  "// @version      $version",
  "// @description  $($manifest.description)",
  "// @author       MrTangLuyao",
  "// @license      MIT",
  "// @homepageURL  $repository",
  "// @supportURL   $repository/issues",
  "// @updateURL    $scriptUrl",
  "// @downloadURL  $scriptUrl"
)
$header += $sitePatterns | ForEach-Object { "// @match        $_" }
$header += @(
  "// @run-at       document-start",
  "// @grant        GM_registerMenuCommand",
  "// @grant        GM_addElement",
  "// @grant        unsafeWindow",
  "// @sandbox      JavaScript",
  "// @inject-into  content",
  "// @noframes",
  "// ==/UserScript==",
  "",
  "// 这个文件由 scripts/build-userscript.ps1 生成，不要直接修改。"
)

$body = New-Object System.Text.StringBuilder
[void]$body.Append(($header -join "`n") + "`n(function () {`n`"use strict`";`n`nfunction pageCode() {`n`"use strict`";`n")
[void]$body.Append("if (document.documentElement?.hasAttribute(`"data-btr-userscript`")) return;`n")
[void]$body.Append("document.documentElement?.setAttribute(`"data-btr-userscript`", `"`");`n")
foreach ($file in $pageFiles) { Add-Source $body $file }
[void]$body.Append("`n/* popup/popup.html, popup/popup.css */`n")
[void]$body.Append("const POPUP_HTML = " + (ConvertTo-Json -InputObject $popupHtml -Compress) + ";`n")
[void]$body.Append("const POPUP_CSS = " + (ConvertTo-Json -InputObject (Read-Source "popup/popup.css") -Compress) + ";`n")
[void]$body.Append("`n/* popup/popup.js */`nfunction runPopup(document, chrome, window) {`n").Append((Read-Source "popup/popup.js")).Append("`n}`n")
Add-Source $body "user_scripts/adapter/settings-panel.js"
[void]$body.Append("}`n")
Add-Source $body "user_scripts/adapter/loader.js"
[void]$body.Append("})();`n")

$output = Join-Path $projectRoot "user_scripts\bilibili-thread-ripper.user.js"
[System.IO.File]::WriteAllText($output, $body.ToString(), $utf8)
Write-Output "油猴脚本: $output"
Write-Output "安装链接: $scriptUrl"
