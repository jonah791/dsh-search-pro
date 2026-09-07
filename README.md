<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 深度搜索插件：三层检索（表层多引擎/深网挖掘/Tor代理）+ 18 工具六组
  inject: 'tools'
  tools: search_*
  runtime: host-only
  envDeps: 可选 API key（tavily 等，可配置）
  boundary: 无特殊授权边界
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-search-pro


<p align="center">
  <a href="https://github.com/jonah791/dsh-search-pro"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
</p>
深度搜索插件：三层检索（表层多引擎 / 深网挖掘 / Tor 代理）+ 23 工具九组。零运行时依赖（Node 原生 fetch + WSL curl），免费方案起步。

## 能力分层

| 层 | 说明 | 状态 |
|----|------|------|
| L1 表层 | DuckDuckGo/Brave/Bing 多引擎 + Tavily/Serper 补强 + 查询改写 + 站内定向 | ✅ |
| L2 深网 | 学术(SS/arXiv/Crossref/OpenAlex) / 专利 / GitHub / 社区 / OSINT(WHOIS/子域/DNS/Shodan) / **分享资源(网盘+磁力)** | ✅ |
| L2.5 隐秘 | **代码敏感信息(Sourcegraph) / 暗网索引(Ahmia) / 泄露密码自查(HIBP)** | ✅ 免费无 key |
| L2.6 反爬 | **fetch_robust：指纹伪装/cookie 预热/退避重试/headless Chrome 四通道降级抓取** | ✅ 免费无 key |
| L3 Tor | 经 WSL 内 tor daemon 抓取 .onion / 被墙内容 | ⚠️ 需网络环境支持（网桥或代理） |

## 工具面（23 · 九组）

- **A 查询准备**：`search_build_query`
- **B 表层检索**：`search_web`（支持 `timeRange` 时间过滤搜新资源）`search_serp` `search_site`
- **C 深网挖掘**：`search_academic` `search_patent` `search_github` `search_community` `lookup_whois` `enum_subdomains` `lookup_dns_history` `search_shodan`
- **D 档案还原**：`archive_search` `archive_restore`
- **E 内容处理**：`fetch_page` `fetch_tor` `fetch_robust`
- **G 分享资源**：`search_share`（网盘百度/阿里/夸克 + 磁力链接 Torlock/TPB 多源聚合）
- **H 隐秘信息**：`search_code` `search_darkweb` `search_leaks`
- **F 系统管理**：`search_quota` `search_cache`

## search_code 详解（代码敏感信息 · Sourcegraph）

免费流式 API（`sourcegraph.com/.api/search/stream`，SSE 协议，无需 key）搜 GitHub 等公开仓库代码：
- 支持 Sourcegraph 查询语法：`lang:Python` `repo:` `archived:yes` `fork:yes` 等
- 返回仓库 / 文件路径 / 命中行号 / 命中行内容 / star 数
- 典型用途：搜硬编码密钥（`aws_secret_access_key`）、私钥（`BEGIN RSA PRIVATE KEY`）、内部域名、空密码占位（`password=""`）等
- 命中行可直链 Sourcegraph blob 查看上下文

## search_darkweb 详解（暗网索引 · Ahmia）

Ahmia（Tor 隐藏服务公开索引）clearnet 版搜索，**无需 Tor**：
- 先 GET 首页取 CSRF token（hidden input），再带 token 搜索（Ahmia 无 JS 版本，纯 GET 无结果）
- 返回真实 .onion 地址 + 标题 + 描述
- 边界：只返回公开索引信息，不协助非法内容

## search_leaks 详解（泄露密码自查 · HIBP）

HIBP Pwned Passwords API（k-anonymity 设计，免费无需 key）：
- 本地算 SHA-1，只传前 5 位前缀查询，服务端返回匹配后缀+出现次数
- 用于安全自查（自己的密码/测试密码），明文不落盘不上传
- 返回泄露次数 + 完整 SHA-1（本地计算）

## fetch_robust 详解（反爬绕过 · 多通道降级）

**用途**：搜索引擎/公开站对自动化访问设限（DDG anomaly、429 限流、Cloudflare challenge 滑块/验证页）时，绕过去抓取公开内容。边界：不用于付费墙/认证/入侵。

**通道链（逐级降级，命中即停）**：
1. **fingerprint**：完整浏览器指纹 headers（Sec-CH-UA/Sec-Fetch-* 全家桶）直连——解决 UA/header 检测与部分限流
2. **prewarm**：先访问同源首页攒 cookie 再带 cookie 请求——解决 cookie 会话型反爬（实测可破 DDG anomaly）
3. **retry**：429/5xx 按 1.5s/4s/8s 退避重试——解决瞬时限流
4. **headless**：Chrome/Edge `--dump-dom` 执行 JS challenge（`--disable-blink-features=AutomationControlled` 反 headless 检测）——解决 JS 验证页（实测可将 Brave 429 转 200）

**返回**：正文（htmlToText）+ `channel`（命中通道）+ `challenge`（诊断：none/ip-block/js-challenge/rate-limit/waf）+ `attempts`（每通道状态轨迹）。

**反爬诊断特征**（detectChallenge）：强特征词（"Verifying your browser"/"不是机器人"/"拖动滑块"/challenge-platform 等）全文扫描；弱特征词（anomaly/unusual traffic）只扫 title+头部防正文误伤。

## search_share 详解（网盘 + 磁力）

**网盘源**：
- **学霸盘**（xuebapan.com）：百度网盘资源索引站——列表页直出标题/文件列表/大小，详情页给提取码 + 下载入口（goto 页面用 JS 混淆加密，真实分享链接需手动点开）
- **site: 定向**：pan.baidu.com 走 DDG（可能反爬，优雅降级返回空）
- 阿里云盘/夸克：搜索站普遍被墙/不稳定，暂以 site: 兜底（命中率低，已知边界）

**磁力源**：
- **Torlock Torznab API**（torlock.com/torznab/api）：免费无 key，标准 RSS——标题/磁力链接/大小/seeders/infohash 全字段
- **The Pirate Bay**（thepiratebay.org）：HTML 兜底源
- **BTDig**（btdig.com）：**DHT 全网索引**——能搜到站点索引不到的冷门/版权资源，结果页直出 magnet（含 infohash）
- 三源并行按 infohash 去重，返回完整 `magnet:` 链接

**BTDig 反爬坑**（v0.5 排障记录）：
- Node fetch（undici）稳定 429 → 走 WSL curl 通道（curl TLS 指纹可过）
- Chrome 精确 UA（`Chrome/124.0.0.0`）触发 429 挑战页 → 用简单 UA `Mozilla/5.0`
- `%20` 编码 URL 触发 429 → 用 `+` 分隔查询词

**用法**：
```
search_share(query="电影名", kind="all"|"netdisk"|"magnet", limit=15)
```

## 配置（Config）

```yaml
tavilyKey: ''        # Tavily API（免费 1000 次/月），search_serp 增强
serperKey: ''        # Serper（免费 2500 次），search_serp/site/patent 增强
shodanKey: ''        # Shodan 免费额度
securityTrailsKey: '' # DNS 历史免费额度
githubToken: ''      # GitHub code 搜索必需（repo/issue 无需）
jinaKey: ''          # Jina Reader 正文提取（可选，免费额度）
defaultLang: 'zh'
cacheTtlMinutes: 60
```

## 依赖服务（可选）

- **Tor**（L3）：WSL2 `sudo apt install tor && sudo service tor start`，SOCKS5 `127.0.0.1:9050`。大陆网络需网桥/代理（torrc 加 `Socks5Proxy` 或 `UseBridges 1`）。
- **SearXNG**（可选增强）：Docker 部署后替换 search_web 引擎源（当前默认 DDG 直连）。

## 已知边界

- web.archive.org / crt.sh 在部分网络环境不可达：archive 走 Tor 兜底（未自动），crt.sh 已加 certspotter fallback。
- Bing 新版 `/ck/a` 加密跳转链接对 agent 不可直接复用，已默认 DDG 主力。
- 所有工具输出结构 `{ ok, count, results, error? }`，经 dsh-tools schema 校验。

## 开发备注

- **render 签名**：`output.render(args, value)`——首参是执行参数，二参才是返回值（踩坑记录见记忆）。
- 构建：`node node_modules/typescript/bin/tsc -p tsconfig.json`（node_modules 为 junction 复用）。
- 测试：`scripts/smoke.mjs`（直调 lib 模块）/ `scripts/apply-test.mjs`（fake ctx 注册）/ `scripts/schema-test.mjs`（schema 校验）。
