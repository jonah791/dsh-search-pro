<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 深度检索插件——23 个 search_*/fetch_*/archive_*/lookup_*/enum_* 工具覆盖三层检索（L1 表层多引擎 / L2 深网与 OSINT / L3 Tor 与被墙抓取）+ 反爬四通道降级，统一输出外壳 {ok,count,results,error?,note?}；每次调用落一行自证轨迹
  inject: 'tools'
  tools: search_build_query,search_web,search_serp,search_site,search_academic,search_patent,search_github,search_community,lookup_whois,enum_subdomains,lookup_dns_history,search_shodan,archive_search,archive_restore,fetch_page,fetch_tor,fetch_robust,search_share,search_code,search_darkweb,search_leaks,search_quota,search_cache
  runtime: host-only（无 npm 运行时依赖：Node 原生 fetch；反爬/Tor 通道经 WSL curl）
  envDeps: 出网；可选 API key（tavily/serper/shodan/securityTrails/github/jina，均可不配）；可选 WSL(Ubuntu)+tor daemon（仅 fetch_tor）；可选 Chrome/Edge（仅 fetch_robust 的 headless 通道）
  boundary: 只做取回与结构化，不做内容判断、不管凭据生命周期；**能力面 ≠ 权限边界**（无沙箱）；反爬通道不用于付费墙/认证/入侵
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-search-pro

<p align="center">
  <a href="https://github.com/jonah791/dsh-search-pro"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-40%20passed-brightgreen" alt="tests">
</p>

**一句话**：23 个检索/抓取工具的三层工具面——L1 表层多引擎（DDG/Brave/Bing + Tavily/Serper 补强 + 查询改写 + 站内定向）、L2 深网与 OSINT（学术/专利/GitHub/社区/WHOIS/子域/DNS/Shodan/网页档案/分享资源/代码敏感信息/暗网索引/泄露自查）、L3 Tor 与被墙抓取（含反爬四通道降级）。

**为什么值得用**：公开检索的失败模式不是「搜不到」，而是**静默降级**——被限流返回挑战页、被墙返回空数组、`fetch` 抛一个看不出原因的错。本插件把这些变成可解释的信号：统一外壳 `{ok, count, results, error?, note?}`（空 ≠ 错，缺 key 显式拒绝而不是静默空结果）、`fetch_robust` 返回命中的**通道名**与**反爬诊断类型**、每次调用落一行轨迹记录「走到哪一级 / 聚合去重后剩多少条 / 耗时」。免费方案即可起步（多数源无需 key）。

## 能力

三层 + 九组，工具名与源码逐字一致。

| 组 | 工具 | 用途 |
|----|------|------|
| A 查询准备 | `search_build_query` | 意图 + 关键词 → 多组查询变体（原词/短语/核心词/问题式，可注入 site:/filetype: 语法），去重后 ≤8 条 |
| B 表层检索 | `search_web` | 多引擎聚合（DuckDuckGo/Brave/Bing 免费 + 可 Tavily/Serper 补强），支持 `timeRange` 时间过滤（只对 DDG 生效）找新资源 |
| | `search_serp` | 专业 SERP API 补强/保底（Tavily 带正文摘要 / Serper = Google 实时），需对应 key |
| | `search_site` | 站内定向搜索（`site:` 语法封装，多引擎） |
| C 深网与 OSINT | `search_academic` | 学术文献（Semantic Scholar / arXiv / Crossref / OpenAlex，可指定源或全源并行） |
| | `search_patent` | 专利检索（Google Patents 定向，走 SERP/Bing；配 serperKey 更准） |
| | `search_github` | GitHub 代码/仓库/issue 检索（**code 搜索必须配 githubToken**） |
| | `search_community` | 社区定向：Reddit / Hacker News / 4chan（`board`）/ Telegram 公开频道（`channel`） |
| | `lookup_whois` | 域名注册情报（RDAP）：注册商/状态/时间线/名称服务器 |
| | `enum_subdomains` | 子域名枚举（crt.sh 证书透明日志） |
| | `lookup_dns_history` | DNS 历史 A 记录时间线（需 securityTrailsKey） |
| | `search_shodan` | 暴露服务/设备检索（需 shodanKey） |
| D 档案还原 | `archive_search` | Wayback 快照清单（CDX API）：某 URL/域名有哪些历史快照（找回被删/改版页面） |
| | `archive_restore` | 取快照并提取正文（可指定时间戳，可配 archive.today 兜底） |
| E 内容处理 | `fetch_page` | 正文提取：URL → 可读正文（三级降级：Jina Reader → 自抓启发式），可返回原始 HTML |
| | `fetch_tor` | 经 Tor 抓取 `.onion` / 被墙内容（需 WSL 内 tor daemon） |
| | `fetch_robust` | 反爬绕过抓取：指纹伪装 → cookie 预热 → 退避重试 → headless Chrome 四通道降级，返回正文 + 命中通道 + 反爬诊断 |
| F 系统管理 | `search_quota` | 通道配额/健康：本会话各通道调用计数、缓存规模、Tor 可达性 |
| | `search_cache` | 结果缓存管理：`list` 查看 / `clear` 清空（可带关键词过滤） |
| G 分享资源 | `search_share` | 网盘（百度/阿里/夸克 site 定向 + 学霸盘索引）+ 磁力（Torlock Torznab + The Pirate Bay + BTDig 三源按 infohash 去重） |
| H 隐秘信息 | `search_code` | 代码敏感信息搜索（Sourcegraph 免费流式 API）：搜公开仓库里的硬编码密钥/内部域名/空口令占位等 |
| | `search_darkweb` | 暗网索引搜索（Ahmia clearnet 版，**无需 Tor**）：Tor 隐藏服务标题/描述 → 真实 `.onion` 地址 |
| | `search_leaks` | 泄露口令自查（HIBP Pwned Passwords，k-anonymity：本地算 SHA-1 只传前 5 位前缀） |

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-search-pro": "link:<工作区>/self-plugins/dsh-search-pro"
```

**2) 挂组合**（agent 预设行；key 留空也能用——大部分工具走免费无 key 源）：

```yaml
- insert:
    - id: agent-search-pro
      name: dsh-search-pro
      config:
        tavilyKey: ''
        serperKey: ''
        githubToken: ''
        defaultLang: zh
        cacheTtlMinutes: 60
```

**3) 30 秒验证**（无需 key）：

```
search_web query="DeepSeek Harness" pages=1
search_quota
```

期望：`search_web` 返回 `{ok:true, count:N, results:[…]}`（`count` 是聚合去重后的条数）；`search_quota` 返回本会话各通道调用计数。再 `tail -3 "$DSH_HOME/search-trace.jsonl"`，应看到 `boot` 行 + 两次调用的 `call` 行。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | 总开关 |
| `tavilyKey` | `''`（空） | Tavily API（免费额度），`search_serp` 增强；为空时回落到 `<DSH_HOME>/.credentials.yaml` 的 `TAVILY_API_KEY` |
| `serperKey` | `''` | Serper（免费额度），`search_serp`/`search_site`/`search_patent` 增强 |
| `shodanKey` | `''` | Shodan 免费额度（`search_shodan`） |
| `securityTrailsKey` | `''` | SecurityTrails 免费额度（`lookup_dns_history`） |
| `githubToken` | `''` | GitHub code 搜索**必需**（仓库/issue 搜索不需要） |
| `jinaKey` | `''` | Jina Reader 正文提取（可选，免费额度） |
| `defaultLang` | `'zh'` | 查询改写的语言提示 |
| `cacheTtlMinutes` | `60` | 结果缓存 TTL（仅 7 个工具走缓存，见下） |

**缺 key 的行为是显式拒绝**（如 `{ok:false,error:'未配置 shodanKey（Config）'}`），不是静默返回空结果。

## 落盘与自证（出问题时先看这里）

**唯一自有落盘**：`<DSH_HOME>/search-trace.jsonl`（append-only，一行一次 `boot` / 一次工具调用；`DSH_HOME` 缺省 `~/.dsh`）。此外 headless 通道会在系统临时目录建 Chrome 临时 profile（`%TEMP%/dsh-robust-<ts>`）。

| 阶段 | 含义 |
|------|------|
| `boot` | 插件装载（自报配置面与生效面；其余字段用中性值填充以保持列固定） |
| `call` | 每次工具调用一行（**23 个工具的唯一观测收笔点**：收口在 `reg()` 内层包装器，新增工具只要走 `reg()` 即被观测） |

| 字段 | 语义 |
|------|------|
| `atMs` / `build` | 写入时刻 / `<version>@<模块 mtime ms>` |
| `tool` | 工具名（`boot` 行为 `apply`） |
| `params` | 参数摘要（**白名单键 + 脱敏 + 截断 200**，`key=value` 以 `;` 分隔） |
| `count` | **聚合去重后**的结果条数（不被 `attempts` 这类元数据数组污染） |
| `channel` / `attempts` | 反爬通道链命中的级别（未走该链为空串）/ 通道尝试次数（走到了第几级） |
| `durationMs` / `ok` / `error` | 耗时 / 是否成功 / 失败原因（已脱敏 + 截断 500） |

**一条命令答五问**：

```bash
tail -3 "$DSH_HOME/search-trace.jsonl"
# ① 线上跑的是哪个构建 → build = "<版本>@<模块 mtime ms>"
# ② 谁发起 / 用什么参数 → tool + params（白名单脱敏摘要）
# ③ 断在哪一段         → channel + attempts（反爬链走到第几级）；ok:false 时看 error
# ④ 结果质量           → count（聚合去重后条数；0 与 ok:false 是两种不同的坏）
# ⑤ 耗时与预算         → durationMs（配合 search_quota 的通道计数判是否命中缓存）
```

隐私红线：`password` 类参数**永不落盘**（既不在白名单内、又命中密钥黑名单，有端到端尸体测试锁定）；错误文案里的 `Bearer <token>` 形式会被脱敏。观测**绝不反噬**：IO 失败吞错返回 `false`，检索行为不受影响。

## 生效判据与回退

**生效判据**（三选一）：
1. 行为级：`search_quota` 可答（返回本会话通道计数与 Tor 状态）且 `search_web` 能返回 `ok:true`；
2. 轨迹级：`tail -1 "$DSH_HOME/search-trace.jsonl"` 的 `build` 里 mtime **等于** `lib/index.js` 的 mtime ⇒ 进程在跑当前构建；
3. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）的 `live` 含 `dsh-search-pro` ⇒ 同上（机器化版本）。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，**进程启动时间必须晚于产物 mtime** 才算「在跑它」。缺这一条时不得宣称「已生效」。

**回退**：
- 源码级：`git -C self-plugins/dsh-search-pro revert <commit>` → 重新构建 → 预检 → 重启；
- 组合级：预设里给 `agent-search-pro` 行加 `disabled: true`（或移除该行）→ 哨兵重启；
- 运行期：缓存与配额**全在内存**（不落盘，重启即清）；轨迹文件可随时删除；无需数据回滚。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"（跑 lib/ 产物，与运行时同源）
```

**40 例离线测试**（40/40 通过）：

- `tests/util.test.mjs`（20 例）——纯函数与退化输入：非法编码/非法 URL/空值/类型不符一律安全回落；
- `tests/trace.test.mjs`（≈19 例）——轨迹层：路径解析、序列化键序、坏行跳过，以及三条**尸体测试**（父路径是普通文件 → 返回 `false` 且不抛；`search_leaks` 的 `password` 端到端不落盘；含 `Bearer <token>` 的错误文案脱敏），另含两条**真缺陷回归**：`count` 不被 `{attempts:[a,b,c]}` 这类元数据数组污染（实证样本即 `fetch_robust` 返回体）、反爬 `channel`/`attempts` 可直取（取不到给空串，不猜）；
- `tests/esm-contract.test.mjs`（1 例）——断言 `lib/**/*.js` 无裸 `require(` 调用（ESM 契约；**已取得尸体**：在未重建的旧产物上该测试失败）。

**离线单测不需要网络、不需要任何 API key、不需要 Tor、不需要 WSL、不需要 Chrome**——用例全程桩化，不发真实请求。**但本插件的真实功能需要出网**：`search_*`/`fetch_*`/`lookup_*` 依赖外网可达，`fetch_tor` 额外需要 WSL 内 tor daemon，`fetch_robust` 的 headless 通道需要本机 Chrome/Edge。离线测试覆盖的是纯逻辑与观测层，不覆盖真实出网链路。

## 设计要点

- **`render` 签名是 `(args, value)`**：第一个参数是**执行参数**，第二个才是 `execute` 返回值。写反了不会报类型错，只会渲染出错误内容——这是本插件最常踩的一处。
- **空 ≠ 错**：`{ok:true,count:0}` 与 `{ok:false,error:…}` 语义分离。把「没搜到」渲染成错误会诱导上层重试，把「缺 key」渲染成空结果会让人以为是网络问题——后者被显式拒绝替代。
- **反爬通道链的命中条件是 `challenge === 'none' && text.length > 100`**：拿到 200 但正文是验证页的情况必须继续降级；四通道全失败返回 `channel='failed'` 且**仍带正文与轨迹**（不抛），因为「被反爬挡住」本身是有价值的诊断信息。
- **反爬诊断分强弱特征扫描**：强特征词（`verifying your browser` / `challenge-platform` / `不是机器人` / `拖动滑块` 等）全文扫描；弱特征词（`unusual traffic` / `anomaly`）只扫 title + 头部——否则正常正文里出现这些词会误判为挑战页。
- **缓存只覆盖 7 个键**（`web` / `site` / `academic` / `robust` / `share` / `code` / `darkweb`），其余 16 个工具不缓存。缓存命中在轨迹里**没有独立字段**（`count` 有值 + `durationMs` 极小属间接证据）——这是刻意的取舍，见 `docs/semantic.md` §10 U5。
- **BTDig 反爬三坑（排障固化）**：Node `fetch`（undici）稳定 429 → 改走 WSL `curl`（TLS 指纹可过）；Chrome 精确 UA 触发 429 挑战页 → 用简单 UA `Mozilla/5.0`；`%20` 编码 URL 触发 429 → 用 `+` 分隔查询词。
- **反爬通道的边界**：只用于公开内容的自动化访问限制（限流/JS 挑战/指纹检测），**不用于付费墙、认证绕过或入侵**。
- **`search_leaks` 只查一次性自查口令**：明文口令作为工具参数必然进入会话事件流（模型可见 ⟺ 已记录）——轨迹侧已闭环（永不落盘），会话侧不在本插件控制范围内，因此**不要用它查主人真实在用的口令**。

### 已知边界

- `web.archive.org` / `crt.sh` 在部分网络环境不可达：`archive` 有 Tor 兜底（未自动启用），子域枚举已加 certspotter fallback；
- Bing 新版 `/ck/a` 加密跳转链接对 agent 不可直接复用，故默认 DDG 主力；
- 网盘搜索站普遍被墙/不稳定，阿里云盘/夸克以 `site:` 兜底（命中率低）；学霸盘的详情页分享链接为 JS 混淆加密，需人工点开；
- 所有工具输出结构统一为 `{ok, count, results, error?}`，经 dsh-tools 的 `output.schema` 严格校验（`additionalProperties:false`）。

### 依赖服务（全部可选）

| 依赖 | 用途 | 装法 |
|------|------|------|
| Tor（L3） | `fetch_tor`、`search_quota` 的 Tor 状态 | WSL2 内 `sudo apt install tor && sudo service tor start`（SOCKS5 `127.0.0.1:9050`）；网络受限环境需网桥或代理 |
| Chrome / Edge | `fetch_robust` 的 headless 通道 | 本机已装即可，无需额外配置 |
| API key | 增强类工具 | 见「配置」表；全部可不配 |

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、契约（缓存键 + 状态→裁决表 + 调用点清单 + 轨迹行 schema）、可证伪验收清单（A1–A17）、未决问题（U2–U5） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `public-api-scraping` / `anti-scraping-bypass` / `search-resource-freshness` / `tor-network-troubleshooting` | 公开 API 抓取、反爬诊断与绕过分级、新资源搜索、Tor 排障的方法论 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
