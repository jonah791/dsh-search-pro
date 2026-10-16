# 语义文档：dsh-search-pro（深度搜索 · 三层检索 + 发现/情报层 / 32 工具）

> 能力名：`dsh-search-pro` · 主副本路径：`self-plugins/dsh-search-pro/docs/semantic.md`
> 实现落点：`self-plugins/dsh-search-pro/src/index.ts`（+ `src/engines.ts` `src/deep.ts` `src/robust.ts` `src/share.ts` `src/osint.ts` `src/store.ts` `src/fetch.ts` `src/archive.ts` `src/buildQuery.ts` `src/util.ts` **`src/research.ts`** **`src/discover.ts` `src/discover-fetch.ts` `src/discover-site.ts` `src/discover-search.ts` `src/discover-search-fetch.ts` `src/document.ts` `src/intel.ts` `src/intel-api.ts` `src/intel-store.ts` `src/intel-scan.ts`**）
> 版本：v0.1.0（package.json） · 2026-10-17 复核 · 作者：爱丽丝 · 状态：**implemented**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）

---

## 1 · 定位与反定位

**定位**：给我一套「检索 + 抓取 + **持续发现**」工具面（**32 个**工具），覆盖**五个层次**：

- **L1 表层多引擎**（`search_*`）——含 2026-09-18 新增的无钥匙 `parallel` 与自托管 `searxng`
- **L2 深网与 OSINT**——学术 / 专利 / GitHub / 社区 / WHOIS / 子域
- **L3 Tor 与反爬降级抓取**（`fetch_*` / `archive_*`）
- **L4 发现层**（2026-10-16 新增 · `discover_urls` / `discover_site`）——把能力从「搜一个已知问题」扩到「**系统性发现一个源有什么**」：多源 URL 发现（Common Crawl 128 个月度索引 + crt.sh 证书透明）+ 站点级骨架（robots / sitemap 探测 / 有界 BFS / 附件清单 / 站内搜索探测），带**覆盖度自评**（找到什么 / 缺什么 / 多可信）。核心判据：**发现是瓶颈，不是抽取**（主人 2026-10-16 定调）
- **L5 抽取层 + 情报系统**（2026-10-16/17 新增）——`fetch_document`（附件 → 文本 + 表格，WSL Python 载体，零安装成本）；`intel_*` ×5（监控源 → 定期扫描 → **只报新的** → 结构化沉淀 → 状态主动注入）。判据见 §3 不变量 I6–I10

并统一输出外壳 `{ ok, count, results, error?, note? }`；**`search_deep`** 在其上提供「一句话交付带引用报告」的深研循环。


**反定位（本文不管什么）**：
- 不管**内容判断**（结果该不该信、够不够用）——那是调用者（我）的裁决，本插件只做**取回与结构化**
- 不管**凭据的生命周期**（key 的签发/轮换/落盘）——`config` 与 `.credentials.yaml` 只是**读取方**
- 不管**红队渗透流程**（目录爆破/CVE 匹配/敏感路径）——那属于 `dsh-red-team`（8 个 `red_*` 工具）
- **不做情报推送**（2026-10-17 明确）：情报系统只**准备内容**（`intel_digest` 出文本）与**送达信号**（状态注入），**推送与否归主体裁决**——自动推送会违反 §2.4「机制把信号送达，不代替决策」
- **不是**搜索引擎本体（无自有索引；全是第三方公开端点/HTML 解析的组合）
- **不是**沙箱：工具面 = 能力面，不是权限边界（见 §5）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 三层（L1/L2/L3） | L1 表层多引擎；L2 深网/OSINT（学术/专利/GitHub/社区/WHOIS/子域）；L3 Tor + 反爬降级抓取 |
| 通道（channel） | 反爬抓取的一次尝试路径：`fingerprint` → `prewarm` → `retry` → `headless`；命中即停 |
| 反爬类型（challenge） | `detectChallenge()` 的分类：`none`/`ip-block`/`js-challenge`/`rate-limit`/`waf`/`unknown` |
| 缓存键（ck） | 各工具自拼的字符串键，仅 7 条路径有缓存（见 §4.1） |
| 配额计数（bump） | 每通道调用次数累加，`search_quota` 读出；**仅内存** |
| 输出外壳 | `resultsSchema()` 声明的对象：`ok`(必填)/`count`/`results`/`error`/`note`（**额外属性一律 false**） |

## 3 · 概念模型

```
cordis 组合(.dsh/profiles/web/cordis.patch.yml)
   └─ agent-search-pro → apply(ctx, config)          [src/index.ts:89]
        ├─ 凭据兜底：读 $DSH_HOME/.credentials.yaml   [src/index.ts:92-98]
        ├─ new SearchStore(ttlMs)  ← 内存 Map（无落盘） [src/store.ts:8]
        └─ reg() ×23 → ctx.tools.register(defineTool)  [src/index.ts:100]
                          │
   我(模型) 调工具 ──────► execute(args) ─ safe() ─► 模块函数（engines/deep/robust/share/osint/archive/fetch）
                                    │                        │
                                    ├─ store.get/set(ck)  ◄──┘  (7 路径)
                                    └─ store.bump(通道) → search_quota 可读
```

不变量（invariants）：
1. **I1 工具数恒为 32**：`src/index.ts` 内 `reg({...})` 调用点计数 = 32（2026-10-17 现算：grep `^    name: '` 得 33 命中，减去注入名 `intel-status` 一条）；`apply-test.mjs` 打印 `REGISTERED: N` 可判真假。
2. **I2 execute 不向外抛**：所有 `execute` 经 `safe()` 包裹，失败恒返回 `{ ok:false, error:string }`（`search_quota` 内部 `torStatus().catch` 同款兜底）。
3. **I3 全量内存态**：缓存与配额不落盘——重启 web 后 `search_cache action=list` 必为空（可用一次重启判真假）。⚠ **情报库是例外**（I6–I10 那套落盘在 `<DSH_HOME>/intel/`，跨重启保留——这正是情报系统的存在前提）。
4. **I4 输出必过 schema**：每个工具 `output.schema` 的 `additionalProperties:false` 生效，多字段即校验失败（`schema-test.mjs` 输出 `validate violations: NONE` 可判）。
5. **I5 缺配置即显式拒绝**：`search_serp`(tavily/serper)、`lookup_dns_history`、`search_shodan` 在无 key 时返回固定文案 `未配置 <key>（Config）`，不静默降级。
6. **I6 结构页永远不是情报**（`isStructuralPage`）：拦容器词 `list`/`index`/`default`/`more`/`search`/`column`/`category`/`tag`/`nav`/`menu` **+ 数字/下划线/连字符后缀**（`[\d_-]*`）+ 根路径 + 目录结尾。**扩展名一律通配，不枚举**——⚠ 两次同型漏判都出在这里：① 正则只匹配 `list.htm` ⇒ 分页列表页 `list2.htm` 漏判进库；② 扩展名写死 `htm|html|php|jsp|aspx?|shtml` ⇒ sues 站的 `list222.psp` 漏判进库。**枚举式判据注定在命名空间扩张时静默失效**（容器词是信息架构产物、稳定；扩展名是技术栈产物、层出不穷）。**容器不是内容，与是否基线无关**。
7. **I7 基线扫描只收高价值类**：快照为空（首次扫描）时只有 `attachment` / `paper` / `api` 进库——站点「本来就有这些页面」不是新闻。实测对照：修复前首扫产 118 条页面；修复后另一站首扫产 9 条**全是附件**、零页面。
8. **I8 快照记「全部候选」，worthy 记「其中值得报的」**：两者必须分开——只记 worthy 会让被过滤的那些在下一轮「变成新的」。实测：候选 9→16（多了 7 个页面），新增仍 0。
9. **I9 空与失败必须分型**：`state` 三态（ok / partial / failed）与 `sourceErrors` **正交**——「扫到 0 条」与「源坏了」不许都渲染成 0；源级错误必须带目标归属（`<targetId>: <原因>`）。⚠ 上游 `searchAcademic` 曾一律 `.catch(() => [])` 把源失败吞成空数组（2026-10-17 修：`onError` 回调上抛）。
10. **I10 读数分层**：`shown`（本次列出，受 per-target 限制）与 `filtered`（未读合计）必须分开说——「new 15 条待看」在未读 72 条时会被读成「只有 15 条未读」。
11. **I11 新增 kind 时渲染走单一真源**：`kindTag(kind)` 是标签唯一来源；`index.ts` 里**不得出现硬编码标签字面量**（有结构断言测试拦）。理由：加 `api` kind 时改了一处渲染、漏了另一处 ⇒ 币安公告显示成 `[页面]`，**读数失真而没有任何报错**。
12. **I12 分支返回形状必须与渲染层同步**：同一工具的 `execute` 可能有**多种返回形状**（如 `intel_list` 的「列条目」与「改状态」），渲染层必须**按形状分支**，不能一律按默认形状渲染。⚠ 2026-10-17 一晚两次同型：① `intel_list` 批量改状态返回 `{ok,count,note}` ⇒ 渲染成「0 条 · 无匹配条目」（**执行正确而读数说没找到**）；② `intel_watch` 的 remove/add 同样不返回 `targets` ⇒ 渲染成「（尚无监控目标）」（**读数说数据没了，数据还在**）。判据两条：**note 存在时优先渲染 note**（部分失败时 `ok=false`，若先判 ok 会走 error 分支、note 里的「未找到 N 条」整条丢掉）；**「空」的判据必须是「这是列表响应且为空」**（`Array.isArray(v.targets)`），不能是 `!v.target`——**缺字段 ≠ 空**。
13. **I13 arxiv 查询必须表达式化，且语法字符不得编码**：① `arxivQuery(raw)`——裸空格被 arxiv 当 **OR**（实测 `deep web crawling hidden web` 的 20 条里强相关仅 2 条 / 10%、无关 15 条 / 75%）⇒ 多词逐词 `all:` + `AND` 连接；已含语法（`ti:`/`abs:`/引号/括号/布尔）**原样透传**，代码不替调用者改写意图。② `encodeArxivQuery(q)`——**不能用 `encodeURIComponent`**：`:` 是字段前缀的语法成分，编成 `%3A` 后 arxiv 不认前缀、**回退全文检索**（实测 3/3 返回无关论文）；空格按官方形态用 `+`。依据：官方手册 §5.1（示例 `search_query=au:del_maestro+AND+ti:checkerboard`）。

## 4 · 契约

### 4.1 数据结构与落盘
- **缓存/配额**：`src/store.ts:SearchStore`——`cache: Map<string,{value,expiresAt}>`、`counts: Map<string,number>`；TTL = `config.cacheTtlMinutes`（默认 60）分 × 60_000；`set()` 在 `size > 500` 时清除**已过期**条目。
- **有缓存的键（7）**：`web:<query>:<engines>:<pages>:<timeRange>`、`site:<site>:<query>:<engines>`、`academic:<query>:<source>:<limit>`、`robust:<url>:<skipHeadless>`、`share:<query>:<kind>`、`code:<query>:<limit>`、`darkweb:<query>:<limit>`。其余 16 工具**不缓存**。
- **落盘（2026-09-14 批次 S4-A 更新）**：**新增自证侧车** `<DSH_HOME>/search-trace.jsonl`（§4.4，一行一工具调用，
  全部 IO 失败吞错）——这是本插件**唯一的自有状态落盘**。此前的状态是「不写任何自有状态文件」，
  而代价已实测：headless 临时 profile 泄漏 ~180MB 时**日志一片干净**（§9 第一条）。
  另一处外部写动作仍是 headless 通道的 Chrome 临时 profile（`%TEMP%\dsh-robust-<ts>`）。
- **读取的外部状态**：`$DSH_HOME/.credentials.yaml` 的 `TAVILY_API_KEY`（仅 `config.tavilyKey` 为空时兜底）。
- **失败面**：写失败——本插件无自有落盘；读失败（凭据文件缺失）→ `catch{}` 静默跳过（视为未配置）；网络失败/超时 → 抛错被 `safe()` 收成 `error` 字符串返回。

### 4.2 裁决（纯函数优先）
- `buildQueries({intent,keywords,lang,grammarBoost,site,filetype}) → string[]`：关键词为空 → `[]`；否则输出「原词/短语/核心词/问题式(+grammarBoost 语法变体)」去重后 **≤8** 条。
- `detectChallenge(html, status) → ChallengeType`：`429→rate-limit`；强特征词（`verifying your browser`/`just a moment`/`challenge-platform`/`不是机器人`/`拖动滑块` 等）全文命中 → `js-challenge`；`unusual traffic` 类 → `ip-block`；`security checkpoint` → `waf`；`403/202/503` 且头部含 captcha → `js-challenge`、含 `access denied` → `waf`；`≥400` 其余 → `unknown`；否则 `none`。
- `fetchRobust(url,{skipHeadless})`：命中条件 = `challenge === 'none' && text.length > 100`；四通道全失败 → `channel='failed'`（仍返回正文与轨迹，不抛）。

| 输入状态 | 裁决 | 理由 | 语义依据 |
|---------|------|------|---------|
| 无 tavilyKey/serperKey | `{ok:false,error:'未配置 X（Config）'}` | 显式拒绝优于静默空结果 | I5 |
| torStatus 不可达 | `fetch_tor` 抛「Tor 网络不可达（url）：请确认 WSL 内 tor 已启动」 | 失败必须说清**下一步动作** | §5 失败面 |
| 结果全空 | `{ok:true,count:0,results:[]}`（render 显示 `note/无结果`） | 空 ≠ 错 | I2 |

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| cordis 组合 | `.dsh/profiles/web/cordis.patch.yml:166`（`id: agent-search-pro` / `name: dsh-search-pro` / `config.tavilyKey`，值不落文档） | web 启动装配 |
| cordis 装配 | `src/index.ts:apply(ctx, config)`（`export const inject = ['tools']`） | 插件挂载时 |
| 工具注册 | `src/index.ts:reg()` → `ctx.tools.register(defineTool(tool))` | `apply()` 内同步 **32** 次 |
| 我（模型/会话） | **32** 个 `execute(args)`（`search_build_query` … `intel_prune`） | 每次工具调用 |
| 缓存/配额 | `src/index.ts` 各 execute → `store.get/set/bump`（`src/store.ts:SearchStore`） | 每次工具调用 |
| 凭据兜底 | `src/index.ts:apply` → `readFileSync(join($DSH_HOME ?? ~/.dsh, '.credentials.yaml'))` 正则 `TAVILY_API_KEY` | 仅当 `config.tavilyKey` 为空 |
| WSL + Tor | `src/fetch.ts:fetchTor` / `src/fetch.ts:torStatus`（`wsl.exe -d Ubuntu -- bash -lc curl --socks5-hostname 127.0.0.1:9050`） | `fetch_tor` / `search_quota` |
| WSL curl（BTDig） | `src/share.ts:curlGet`（`-A 'Mozilla/5.0'`，绕 JA3 限流） | `search_share`（kind=magnet/all） |
| headless Chrome | `src/robust.ts:fetchHeadless`（`chrome.exe --headless=new --dump-dom --virtual-time-budget=10000`） | `fetch_robust` 前三通道均未命中时 |
| 密钥消费 | `src/index.ts` → `searchTavily/searchSerper/searchPatent/searchGithub/lookupDnsHistory/searchShodan` | 对应工具执行时 |
| **发现层** | `src/discover-fetch.ts:discoverUrls`（Common Crawl CDX 128 月度索引 + crt.sh）· `src/discover-site.ts:discoverSite`（robots → sitemap 探测 → 有界 BFS → 附件 → 站内搜索探测） | `discover_urls` / `discover_site` |
| **抽取层** | `src/document.ts:fetchDocument` → `scripts/extract_document.py`（WSL `python3`，魔数优先，无 OCR） | `fetch_document` |
| **情报层** | `src/intel-scan.ts:scanTarget/scanAll`（`collect` 按 kind 分派 → `diffNew` → **落盘与快照更新在同一函数**）· `src/intel-api.ts:mapApiItems`（声明式 JSON 映射）· `src/intel-store.ts:IntelStore`（落盘 `<DSH_HOME>/intel/`） | `intel_watch` / `intel_scan` / `intel_list` / `intel_digest` / `intel_prune` |
| **状态注入** | `src/index.ts:ctx.systemPrompt.context({ name:'intel-status', order:850 })`——**无未读时返回空串**（省 token），整体 try/catch（注入层绝不反噬主流程） | 每次模型请求开头物化 |
| **定时扫描** | `src/index.ts:setInterval`（**到期检查**而非直接定时：读 `status.json` 的 `lastScanAt` 比对间隔）· `unref()` · 全程 try/catch | 每 60s 检查一次，到期才扫 |
| **观测收口** | **`src/index.ts:reg()` 内层 `tracedExecute(tool)`** —— **32 个工具的唯一观测落笔点**（一个包装器覆盖全部工具面，见 §4.4） | 每次工具调用 |
| **轨迹落盘** | `src/index.ts:searchTrace(composeSearchEntry(…))` → `<DSH_HOME>/search-trace.jsonl`（boot 行 + 每调用一行） | `apply()` 装载 + 每次工具调用 |

### 4.4 自证轨迹契约（`<DSH_HOME>/search-trace.jsonl`）`[MUST]`

**动机**：本插件有 **32 个工具**，而每次调用的真实经过（走了哪个引擎 / **反爬通道链走到哪一级** / 聚合去重后剩多少条 / 耗时 / 断在哪一段）此前**只写 `ctx.logger`**，宿主 logger **不落盘**。

代价已实测：headless 清理缺陷泄漏 ~180MB **而日志全干净**（§9）——「降级到哪一级、哪一级失败了」当时完全不可见。

- **落盘路径**：`<DSH_HOME>/search-trace.jsonl`（`DSH_HOME` 环境变量优先，缺省 `<homedir>/.dsh`；
  解析走 `src/trace.ts:resolveHome` **单一真源**）。追加式 JSONL，一行一事件。
- **阶段枚举**（`SearchTracePhase`，闭集）：`boot`（`apply()` 进程级构建自报）→ `call`（任一工具的一次调用）。
- **行 schema**（字段固定，`boot` 行用中性值填充，`tail` 后可直接读列）：

  | 字段 | 含义 | 回答哪一问 |
  |------|------|-----------|
  | `atMs` | 写入时刻（ms epoch） | 时间线 join |
  | `phase` | `boot` / `call` | Q2 谁发起 |
  | `build` | `<version>@<模块 mtime ms>` | **Q1 线上跑的是哪个构建** |
  | `op` | 23 个工具名之一（boot 行为 `apply`） | **Q2 哪个工具** |
  | `params` | 参数摘要（**白名单 + 黑名单 + 脱敏 + 截断 200**） | Q2 输入侧 |
  | `count` | **聚合去重后的结果条数**（显式 `count` 优先） | **Q4 结果质量** |
  | `channel` | 反爬通道链**命中的级别**（`fetchRobust` 的 `channel`；未走该链为空串） | **Q3 降级到哪一级** |
  | `attempts` | 反爬通道尝试次数（走到了第几级） | **Q3** |
  | `durationMs` | 调用耗时（ms） | Q5 |
  | `ok` | 成功与否（`ok===false` 或非空 `error` 或抛错 → false） | Q3 |
  | `error?` | 工具 error 文案（**脱敏 + 截断 500**） | Q3 |

- **隐私红线（两层闸 + 一层脱敏）**：
  ① **白名单**（`SUBJECT_KEYS`：query/keywords/url/domain/term/site/board/channel/…）——
     **不在清单里的键根本不进摘要**（如 `pages`、`skipHeadless`）；这是**正面清单**，不是黑名单；
  ② **键名黑名单**（`SECRET_KEY_RE` = `/pass|secret|token|key|cookie|auth|credential|session|nonce|signature/i`）——
     即使白名单里日后加了敏感名也整键丢弃（**双保险**）；
  ③ 值再过 `redactText`（`Bearer`/`sk-`/`ghp_`/`AKIA`/≥32 位高熵串）。
  ⇒ **`search_leaks` 的 `password` 参数永不落盘**（§7 A16 尸体测试端到端验证）。
- **不变量**：① **`count` 不得被元数据数组污染**——`attempts`/`warnings`/`errors`/`queries`/`engines`
  等是元数据数组（`META_ARRAY_KEYS`），不是结果条数（**本批单测首跑抓到的真缺陷**，见 §9）；
  ② **观测绝不反噬主流程**：`appendTraceEntry` 全部 IO 失败吞错并返回 `false`；
     业务异常**原样重抛**；返回值**原样透出**（output.schema 是 `additionalProperties:false`，混入新字段即校验失败）；
  ③ **`channel` 取不到就空串**——不猜（该工具没走反爬链就是没走）。
- **调用点清单**：`src/index.ts:reg()` 内层 `tracedExecute(tool)` —— **唯一收口**。
  `reg` 是 23 个工具的唯一注册入口，故**一个包装器覆盖整个工具面**（不在 N 处手改——漏一处就是新盲区）。
  **新增工具只要走 `reg()` 就自动被观测**；绕过 `reg()` = 制造新的观测盲区。
  合成走 `src/trace.ts:composeSearchEntry`（纯函数，**实现与单测共用同一真源**）。
- **查询方式**：`tail -3 <DSH_HOME>/search-trace.jsonl`（最近三次调用的五问）。

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：工具面只声明「能做什么」；**不防**越权抓取、不防目标站封禁本机 IP、不防把不该搜的内容搜出来——授权与合规由调用者（我）承担。
- **不越界清单**：不绕过付费墙/登录认证（README 与 `fetch_robust`/`search_darkweb`/`search_code` 描述均写明）；`search_leaks` 只查单条密码、只传 SHA-1 前 5 位；`fetch_tor` 只读文本。
- **运行期外部依赖（非 npm 依赖）**：WSL2 Ubuntu + tor daemon（SOCKS5 `127.0.0.1:9050`）、Chrome/Edge 可执行文件（headless 通道）、`$DSH_HOME/.credentials.yaml`。——README 的「零运行时依赖」仅指 Node 包依赖，**不含**这三项。
- **失败面**：`safe()` 统一收口为 `{ok:false,error}`；凭据缺失静默跳过；Tor/headless 缺失给「怎么做」的提示；`SearchStore` 无上限保护（只清过期项）。

## 6 · 与既有机制的关系

- **组合变更纪律（AGENTS.md §5.11）**：改本插件源码 = 改组合 → 重启前必须 `preflight_check`（判据：产物 mtime vs web 进程启动时间）。
- **热重载/守护**：`plugin-mount` → 哨兵 `.hot-reload-flag` → 守护预检 → kill+重启 → 唤醒；重启原语 `daemon_restart`（watch 侧归主人）。
- **语义文档系统（§5.20）**：本文是该能力的主副本；§7 的 `pending` 计入注册表 `acceptance.pending`（`semantic_check` D1–D6）。
- **与 `dsh-red-team` 的关系**：两者共用「crt.sh 子域枚举」语义但**各自实现**（`dsh-search-pro/src/deep.ts:enumSubdomains` 有 certspotter 兜底；`dsh-red-team/src/enum.ts:enumSubdomains` 无）——**不是同语义副本**，无主副本归属问题，但结论可能不一致。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/HTTP） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰为 **32** 个 | `Select-String src/index.ts -Pattern "^    name: '"` 计数 − 1（注入名 `intel-status`）= **32** | 已实测（2026-10-17 现算） |
| A2 | `apply()` 不抛且注册 32 工具 | `node scripts/apply-test.mjs` 输出 `REGISTERED: 32` | 待验收 |
| A3 | 真实 execute 返回值过 schema | `node scripts/schema-test.mjs` 输出 `validate violations: NONE` | 待验收 |
| A4 | 缺 key 时显式拒绝（非静默） | 无 key 调 `search_shodan` → `{ok:false,error:'未配置 shodanKey（Config）'}` | 待验收（源码判据 §4.2） |
| A5 | 缓存命中不重复出网 | 同参二次 `search_web` → `search_quota` 同名通道计数不增 | 待验收 |
| A6 | 缓存/配额不落盘（重启即清） | 重启 web 后 `search_cache action=list` → 0 条 | 待验收 |
| A7 | 反爬轨迹可读 | `fetch_robust` 结果 note 含 `通道: <channel> · 反爬诊断: <type>` 且 `尝试: fingerprint=… → prewarm=…` | 待验收 |
| A8 | Tor 不可达时显式报错且不挂起 | `fetch_tor` 返回含 `Tor 网络不可达（`；`search_quota` 显示 `Tor ❌` | 待验收 |
| A9 | 线上跑的是当前构建 | `(Get-Item lib/index.js).LastWriteTime = 2026-09-06T18:14:31` 晚于 `src/index.ts`（18:14:21），早于 web 进程启动（2026-09-14 10:05:47） | 已实测（2026-09-14） |
| A10 | 产物无裸 `require(`（ESM 契约） | `npm test` → `tests/esm-contract.test.mjs` 断言 `lib/**/*.js` 无裸 `require(` 调用；**已取得尸体**：未重建的旧产物上该测试失败 | 已实测（2026-09-14，20/20 pass） |
| A11 | 纯函数与失败路径有守卫 | `npm test` → `tests/util.test.mjs` 20 例全过；含非法编码/非法 URL/空值/类型不符等退化输入 | 已实测（2026-09-14） |
| A12 | 每次工具调用落一行自证轨迹（五问可一条命令答） | `npm test` → `tests/trace.test.mjs:离线组合` 真写出三行；线上：`tail -3 $DSH_HOME/search-trace.jsonl` 可读 `build/op/params/count/channel/attempts/durationMs/ok` | **待线上验收**（离线已锁；本批不部署，由派发者统一部署） |
| A13 | **反爬通道链走到哪一级可查**（A7 的机器版） | `npm test` → `channelOf`/`attemptsOf` 直取与嵌 `results[]` 两级 + 取不到→空串（不猜）；离线组合断言 `channel='headless'`、`attempts=3` | **已实测（离线）** |
| A14 | **`count` = 聚合去重后条数，不被元数据数组污染** | `npm test` → `resultCount`：显式 `count` 优先；**`{attempts:[a,b,c]}` → 0**（真缺陷回归，实证样本 = `fetch_robust` 返回体）；`warnings` 跳过；`NaN` 不算合法 count | **已实测** |
| A15 | 观测绝不反噬主流程（IO 失败不抛） | `npm test` → `尸体测试：父路径是普通文件 → 返回 false 且不抛`（`assert.doesNotThrow` + `=== false`） | **已实测** |
| A16 | **`search_leaks` 的 `password` 永不落盘**（隐私红线端到端） | `npm test` → `隐私尸体测试端到端`：喂 `{password:'hunter2secret'}` → 断言 `params === ''`；喂 `apiKey`/`token` → 断言摘要里不含键名；喂 error 含 `Bearer <32位>` → 断言落盘原文 `includes(secret) === false`（逐个）；且 `[redacted]` 确实出现、非敏感参数 `query=爱丽丝` 仍可读 | **已实测** |
| A17 | 观测覆盖全部 **32** 工具（无旁路） | 收口在 `reg()` 内层——**32 个工具的唯一注册入口**，故覆盖率为工具数本身；新增工具只要走 `reg()` 即被观测（§4.4 调用点清单） | **待线上验收**（覆盖率由构造保证，非逐点登记） |
| A18 | **`search_deep` 的输出能被人读到**（render 契约） | `dsh-tools` 的 render 必须返回 **`[{ type:'text', text }]`**；2026-09-18 实测：返回裸字符串数组时 **trace 记 `ok:true`/8.6 s 而界面显示为空**（沉默失败）⇒ 修后线上 `search_deep` 输出完整带 `[n]` 引用的报告 | **已实测（2026-09-18，线上 4 源/抓 4）** |
| A19 | **`search_web` 默认引擎组含两条活通道**（抗单点） | `scripts/search-bench-eval.mjs` 的 `engineCoverage`：修复前 **`parallel` 独苗**；把 `searxng` 拉进默认组后 = **`parallel 37/80` + `searxng 13/63`**（⚠ 前提＝SearXNG 容器健康，见 A20 与 §9 的端口冲突坑） | **已实测（2026-09-18）** |
| A20 | **自托管 SearXNG 的 JSON 通道可用** | `curl 'http://127.0.0.1:18788/search?q=…&format=json'` → HTTP 200 / 20~35 条 / `engines_used=[google cse, duckduckgo, …]`；容器需 **代理 env** + **`network_mode: host`** + **`SEARXNG_PORT=18788`**（**端口从 8888 迁走了**，见 A23 与 §9 的事故记录）；恢复法 `docker compose down --remove-orphans` → `up -d`（`--force-recreate` 会留端口僵尸） | **已实测（2026-09-18）** |
| A21 | **带标注评测可给出可辩护的数字**（hit@k/MRR） | `node scripts/search-bench-eval.mjs`（**16 条**弱标注，2026-09-18 第二轮扩样）→ **`hit@3 14/16 · hit@5 15/16 · MRR 0.859`** · `engineCoverage parallel 73/160 · searxng 24/115 · duckduckgo 11/111`（唯一 MISS＝`owasp.org` 的 argon2/bcrypt 条，标签与覆盖待复核）。⚠ **与扩样前的 `8/8 · MRR 0.938` 不可直接比较**：样本 8→16 且新增「安全/语言/工具链」等更难族，分数下降是**样本变了**、不是系统退化。标签自身也被体检过（`docs.readthedocs.**com**`，原标签写 `.io` 会把真命中记成 MISS ⇒ 先修仪器再改系统） | **已实测（2026-09-18）** |
| A22 | **回归基准可复跑** | `node scripts/search-bench.mjs`（12 条固定查询）→ `queryHitRate 12/12 · avgDomains 5.8`；`node --test tests/*.test.mjs` → **68/68** | **已实测（2026-09-18）** |
| A23 | **SearXNG 就绪门：查询前把通道带起来**（探活→冷启 VM→容器健康自愈→轮询；并发单飞） | `node scripts/searxng-gate-proof.mjs 4 8`（**Windows 侧**跑，与宿主同侧语义）→ 逐轮 `ready=true`；`npm test` → `tests/searxng.test.mjs` 11 例（四态 + 单飞 + 预算耗尽 + 保活开关 + **Restarting 自愈**）| **已实测（2026-09-18 第二轮）** |
| A24 | **逐通道读数可读**（`channels[]`：谁出结果 / 谁空手 / 为什么） | 工具结果与 `search-trace.jsonl` 共用同一读数：`channels` 字段形如 `searxng=ok:20@1832ms/direct ; brave=fail:0@900ms(too many requests)`；`npm test` → `channelsOf/formatChannels/composeSearchEntry`（含脱敏 + 键位固定断言）| **已实测** |
| A25 | **领域路由：代码类问题自动带 GitHub、研究类带学术三源** | `search_deep` 报告的「领域路由」行 + 工具参数 `routing=off` 可关；`npm test` → `tests/routing.test.mjs` 5 例（中英双命中/退化输入）| **已实测** |
| A26 | **多引擎交叉验证标记** | `search_deep` 报告每条来源标 `★多引擎一致`（≥2 条通道独立命中同一 URL），并在汇总行给 `多引擎一致 N 条` | **已实测** |
| A27 | **通道「0 条」有现场快照可查**（不猜判据，先让现象自证） | DDG 三次全 0 条 / parallel 四处静默 `return []` 任一发生 ⇒ 追加一行到 `<DSH_HOME>/search-channel-diag.jsonl`（`engine/shape/query/elapsedMs/features`）；`npm test` → `tests/channel-diag.test.mjs` **15 例**（DDG 五形状 + parallel 四形状各一份**尸体样本** + 显式 home 优先 + 不可写返回 false 且不抛 + 「仅泛化词不判 anomaly」精确性）；**线上触发实测（2026-10-08 08:34）**：`duckduckgo=ok:0@8739ms` ⇒ 侧车 1 行 `shape=anomaly`、`len=14235`、`blocks=0`，并已取回原页确认是反爬页（`cc=botnet` / `anomaly-modal`） | **已实测**（离线 15/15 + 线上现场 1 行 + 原页地面真相） |
| A28 | **结构页永远不进情报库**（I6） | `npm test` → `isStructuralPage` 真实线上样本（含 `list2.htm`/`list231.htm` 分页列表页）+ 尸体样本「list.htm 必须被拦」；线上互证：`intel_prune` 干跑命中 **76** = 独立脚本命中 **76**，apply 后注入读数 **41 = 117 − 76** | **已实测（2026-10-17）** |
| A29 | **基线扫描只收高价值类**（I7） | 线上正对照：新登记 ccgp.gov.cn 首扫 → `扫到 9 · 新增 9`，**全部是附件、零页面**（同型首扫在修复前产 118 条页面） | **已实测（2026-10-17）** |
| A30 | **增量判据可证伪**（I8） | 同目标连扫两次：ccgp 第二次 `扫到 16 · 新增 0`（候选涨了 7 条页面而新增仍 0 ⇒ 快照记全部候选 + worthy 过滤**协同**工作）；另三个目标各自第二次扫均为 0 | **已实测（2026-10-17）** |
| A31 | **空与失败分型**（I9） | 线上读数矛盾：`search_academic` 有 5 条结果而 `intel_scan` 报 0 条 ⇒ 修后同查询 `扫到 15 · 新增 13`（849ms）；`npm test` → `summarizeScans` 三态测试（partial 与 ok/failed 不互相掩盖） | **已实测（2026-10-17）** |
| A32 | **渲染走单一真源**（I11） | `npm test` → 结构断言「`index.ts` 不得含硬编码标签字面量」+ `kindTag` 四类映射 + 未知兜底；**该断言已用尸体注入验证有区分力**（注入 `'[附件]'` ⇒ 红；撤销 ⇒ 绿） | **已实测（2026-10-17）** |
| A33 | **声明式 JSON API 源可用**（第 4 类 kind） | 线上：币安公告端点 `扫到 20 · 新增 20`（279ms，`[公告]` 标签正确）；`npm test` → `tests/intel-api.test.mjs` 12 例（**真实响应样本** + itemsPath 配错响亮报错 + 模板字段缺失跳过计数 + 非数组报实际类型 + 跳过与故障分离） | **已实测（2026-10-17）** |
| A34 | **判据升级后存量能跟上** | `intel_prune` 干跑 → apply → 注入读数精确变化（76→41 页面、6→35 页面两次）；工具**软标记可逆**（append `status=dropped` + `meta.droppedReason`，再 append `new` 即恢复） | **已实测（2026-10-17）** |
| A35 | **分支返回形状与渲染层同步**（I12） | `npm test` → `tests/render-intel-list.test.mjs` + `tests/render-intel-watch.test.mjs`，各含**尸体样本**（批量 note / remove note 不得渲染成「0 条」「尚无监控目标」）与**反向锁**（真的空列表必须仍报那句——判据不许修过头）；线上互证：批量 drop 15 条 ⇒ `标记 15/15 条 → dropped`（此前渲染成「0 条 · 无匹配条目」），情报库 85→70 与操作一致；add ⇒ 「已登记 arxiv-deepweb」（此前误报「尚无监控目标」，而 list 仍报 5 个目标） | **已实测（2026-10-17）** |
| A36 | **结构页判据的扩展名通配**（I6） | `npm test` → `isStructuralPage` 线上样本新增 `list222.psp`/`list231.psp`（sues 站实抓）；**反向注入**：旧正则（扩展名白名单）对两条 `.psp` 判 `false`、新判据判 `true`，两条真内容页两者一致 ⇒ 测试有区分力；线上：`intel_prune` 干跑精确命中 2 条，apply 后未读页面 35→33 | **已实测（2026-10-17）** |
| A37 | **arxiv 查询构造**（I13） | `npm test` → `tests/arxiv-query.test.mjs` 8 例（含 3 具尸体样本：裸空格必产 AND / 冒号绝不被编码 / 重复词去重）；线上：错误信息带出构造后的 URL `search_query=all:deep+AND+all:web+AND+all:crawling+AND+all:hidden`（冒号保留、空格 `+`、去重生效）。⚠ **「结果质量」未验证**——限速 429 挡住（见 U18） | **部分实测（2026-10-17）** |
| A38 | **情报时间窗**（推送场景） | `npm test` → `tests/intel-store.test.mjs` 4 例（时间窗 / 尸体样本「foundAt 坏值不算最近新增」/ 与状态·目标过滤 AND 叠加 / 坏值退化不退化成空）；线上：`intel_digest sinceHours=1` ⇒ 全量 110 条 → **16 条**（列出 6），读数含「时间窗：最近 1 小时」 | **已实测（2026-10-17）** |
| A39 | **条目记源侧发布时间**（I14：时效性判据可算） | `npm test` → `tests/intel-api-time.test.mjs` 12 例（**真实语料锚**：币安 `releaseDate: 1791948608368` ⇒ `2026-10-14T03:30:08.368Z`、OKX `pTime: "1792152012457"` ⇒ 同一 ISO；秒级量级判据；**尸体样本**：`'abc'`/`0`/`-1`/`123`/`999999999`/`{}` 一律 `undefined`——**不猜**；`timePath` 配错必须 notes 响亮；不配 `timePath` 不产且不报噪音）；线上：OKX `扫到 20 · 新增 0 · **补写时间 20**`，库里 40 条 api 条目全部带源侧时间；`intel_digest` 新读数 **`时效：最新 6.4h 前 · 最老 24.5d 前 · 时间未知 50 条`** ⇒ 「未读 90 条全高价值」被修正为「真正新鲜（<24h）的只有 2 条」 | **已实测（2026-10-17）** |
| A40 | **读数透传（不手写字段枚举）**（I15） | `npm test` → `tests/render-intel-scan.test.mjs` 6 例（透传 `backfilled` / **未知字段照传**（未来的字段不必回来改）/ 渲染出「补写时间 20」/ **反向**：无 `backfilled` 不得显示「补写时间 0」/ 时效标签 / 「时间未知」）。**该判据已用真实缺陷标定**：改回手写枚举 ⇒ 第 1 条立刻挂（第三次同型事故的形状） | **已实测（2026-10-17）** |
| A41 | **按目标设扫描周期**（I16：快源不被全局拖住） | `npm test` → `tests/intel-due.test.mjs` 6 例（自带周期覆盖全局 / 缺省回落 / **从没扫过立刻到期** / **尸体样本**：`scanMinutes` 为 `0`·负数·字符串一律回落全局、坏 `lastScanAt` 立刻到期 / 边界是 `>=` 而非 `>` / 空列表不炸）；线上：`targets.json` 实测 **11 个目标**（含 02:51–02:52 新增的 `api-binance-maintenance` / `api-upbit-trade`），`api-binance-delisting` = **30 分钟**、`listing`/`okx` = 60、`activities` = 120、慢源保持全局 360；渲染层显形（`每 N 分钟`）。**动机来自信息差实证**：币安下架公告当日 −25%~−29%，全局 360 分钟会错过 | **已实测（2026-10-17）** |
| A42 | **HTTP 错误归因可分辨**（429 ≠ 超时 · I17） | `npm test` → `tests/http-get-attribution.test.mjs` 5 例（**429 ⇒ 报「被限速」**、429 带 `Retry-After` 报出来、**超时 ⇒ 报「请求超时（Nms）」且非裸 `AbortError`**、其他非 2xx 报 `HTTP <code>`、正常返回文本）。**判据的分辨力**：429 与超时**不得同貌**（旧实现两者都表现为裸的 `This operation was aborted`）。线上：修复后 arxiv 失败信息变为 `请求超时（30000ms）for https://export.arxiv.org/api/query?search_query=all:deep+AND+all:web+AND+all:crawling&max_results=15——对端可能限速或响应慢`（此前是裸的 `This operation was aborted`）⇒ **归因正确**，且顺带证明 **AND query 构造正确**（URL 带出来了）。⚠ 新读数：**限速响应耗时已 >30s**（此前 16.2s）⇒ 惩罚与试探次数正相关 | **已实测（2026-10-17）** |

**生效判据**：① `pnpm build`（`tsc -p tsconfig.json`）后 `lib/*.js` mtime 必须晚于对应 `src/*.ts`；② web 进程启动时间必须晚于 `lib/index.js` mtime（旧实例跑旧代码 = 未生效）；③ 行为判据：`search_quota` 能答且工具出现在工具面即装配成功。

**回退**：① 源码级——`git -C self-plugins/dsh-search-pro revert <commit>`（<commit> 用 `git -C self-plugins/dsh-search-pro log --oneline -1` 取当前 HEAD）后重新 build + `preflight_check` + `daemon_restart`；② 配置级——`plugin_stop dsh-search-pro` / 从 cordis.patch.yml 移除 `agent-search-pro` 行 → 哨兵重启；③ 运行期——`search_cache action=clear` 清缓存（不涉及代码回退）。

## 8 · 与实现的关系

- **主实现与模块职责**：`src/index.ts`（装配 + **24** 工具 + 渲染器 `renderList/renderContent/renderShare`）；`engines.ts` 多引擎与聚合（含**逐通道读数** `ChannelStat`）｜**`searxng.ts` 就绪门**（`ensureSearxng`/`wslRun`/`searxngSearchUrl`/`parseSearxngResults`/`searxngDiagnostics`/`keepAliveCmd`，2026-09-18 第二轮新增，U10 闭环）｜`research.ts` 深研循环（含**领域路由** `routeIntents` 与多引擎交叉验证标记）｜`deep.ts` 学术/专利/GitHub/社区/WHOIS/子域/DNS/Shodan｜`robust.ts` 四通道反爬 + `detectChallenge`｜`share.ts` 网盘 + 磁力三源｜`osint.ts` Sourcegraph/Ahmia/HIBP｜`archive.ts` Wayback CDX/还原/archive.today｜`fetch.ts` Jina→自抓降级 + Tor｜`buildQuery.ts` 查询改写｜`store.ts` 内存缓存/配额｜`util.ts` HTTP/HTML/URL/去重｜**`trace.ts` 自证轨迹层**（`resolveHome`/`paramsDigest`/`resultCount`/`resultOk`/`channelOf`/`attemptsOf`/**`channelsOf`/`formatChannels`**/`errorOf`/**`composeSearchEntry`**（合成单一真源）+ 薄 IO）｜**`channelDiag.ts` 通道 0 条现场快照**（`classifyDdgZero`/`classifyParallelZero` 纯分类 + `appendChannelDiag` 吞错追加；2026-10-08）。
- **测试**：`tests/util.test.mjs`（20）+ `tests/esm-contract.test.mjs` + `tests/trace.test.mjs`（20）+ **`tests/searxng.test.mjs`（24：就绪门四态/单飞/预算耗尽/保活/Restarting 自愈 + `simplifyQuery` + trace `channels`）** + **`tests/routing.test.mjs`（5）** + **`tests/channel-diag.test.mjs`（14）** = **90 例**（2026-10-08 现算；早前记的 69 是 09-18 快照），`npm test` 一条命令复跑。
- **同语义副本**：无（无跨仓平行语义）。
- **未实现/未验证**：`archive.ts:archiveTodayLookup` **已实现但未接入任何工具**（死代码）；README 提到的 SearXNG 增强**未实现**；`community` 的 `tieba` 平台仅在类型里（`CommunityPlatform`），`COMMUNITY_PLATFORMS` 与工具 enum 均只含 `reddit/hn/4chan`。

## 9 · 实践修订记录

- **2026-10-17 · 情报系统·源侧发布时间（时效性判据从「无从计算」变可算；**第三次同型事故**）**
  - **动机（实测读数驱动）**：digest 报「未读 90 条全部高价值」，而**推送判据里写着「且有**时效性**」却无从计算**——条目只记 `foundAt`（我的扫描时刻）。取证发现：两个 api 源**本来就有**发布时间字段（币安 `releaseDate` / OKX `pTime`），而首扫把 **16–22 天跨度**的条目全报成「新」（现算：OKX 最新 6.09h / 最老 392h；币安最新 62.6h / 最老 586.6h）。
  - **改动**：`intel-api` 加 `timePath` + `parseApiTime`（毫秒/秒/ISO；**解析不出不猜**——编个时间会让判据建在假数上，而假数看起来与真数一样）+ 失败**计数并报出**；`intel` 加 `publishedAt`（与 `foundAt` 语义分离）+ `ageHours`/`ageLabel` + `pickBackfill`；`intel-store` 加 `patchItem`（补写字段，与 `updateStatus` 分开——状态是裁决、字段是事实）；`intel-scan` 传时间 + **存量回填** + `backfilled` 读数；`intel_watch update` 支持 spec 字段级合并（**U19 闭环**）；三处渲染显示时效；digest 加时效读数 + 组内按 `publishedAt` 排序（api 源同批 `foundAt` **完全相同** ⇒ 只按它排等于没排）。
  - **★ 通用缺口（值得单独记住）**：`diffNew` 按指纹去重 ⇒ 已报过的条目**不会重报**，也就**永远不会**带上新字段 ⇒ **任何「给持久化条目加字段」的改动都要配回填机制**。线上验证：OKX `扫到 20 · 新增 0 · 补写时间 20`。
  - **★ 第三次同型事故**：`intel_scan` 的 `outcomes` 是**手写字段枚举** ⇒ 新加的 `backfilled` **静默丢掉**——**回填真的成功了**（库里 20 条已带 `publishedAt`），读数里却只有「扫到 20 · 新增 0」。前两次是 `kindTag` 枚举漂移、分支返回形状没同步渲染层。**⇒ 结构修法**：抽 `toOutcome()` **透传**（只排除 `items`），并把该性质写成**可离线测的纯函数**（A40；改回手写枚举第 1 条立刻挂）。
  - **★ 同类缺陷第二实例（字段在传输链上丢失）**：`deep.ts` 早就取了 arxiv 的 `extra.published`，而 `intel-scan` 的 arxiv 分支只取 `{url,title,source}` ⇒ 36 条论文全「时间未知」。修法：抽 `publishedAtFromExtra()` 具名函数使**接线可测**。**存量回填待 arxiv 限速解除**（U20）。
  - **收益（这才是它的意义）**：digest 新读数 **`时效：最新 6.4h 前 · 最老 24.5d 前 · 时间未知 50 条`** ⇒ **「未读 90 条全高价值」被修正为「真正新鲜（<24h）的只有 2 条」**。
  - **测试 231 → 239**（`intel-api-time` 12 例含真实语料锚 + `render-intel-scan` 6 例含反向案例）。

- **2026-10-17 · 发现层 + 抽取层 + 情报系统（24→32 工具；判据被线上读数修了 5 次）**
  - **动机（主人指令链）**：「继续提升搜索能力，借鉴 github 的优秀项目」（**是优秀项目，不是高 star 的水货**）→「让互联网上的大多数信息都能成为你搜索库的一部分」→「**信息提取反而是容易的，难的是发现**」（这句推翻了我的原诊断）→「搭建情报系统」。
  - **新增三层**：L4 发现（`discover_urls` = Common Crawl 128 个月度索引 + crt.sh；`discover_site` = robots/sitemap 探测/有界 BFS/附件清单/站内搜索探测 + 覆盖度自评 + CRATOR 三指标）· L5 抽取（`fetch_document` → WSL Python 抽 docx/xlsx/pdf/xls/csv/html，零安装成本）· L5 情报（`intel_watch` / `intel_scan` / `intel_list` / `intel_digest` / `intel_prune`）。
  - **★ 五个判据全是线上读数修出来的**（离线全绿时看不见）：
    ① **信噪比**：161 条未读里 118 条是页面 URL，且**全部产自同一次基线扫描** ⇒ 「新 URL 即情报」把站点地图当情报（一个站几千页，无限产噪音）。修法三条必须同时成立：结构页永远不进库 + 基线只收高价值类 + 快照记全部候选。
    ② **`list2.htm` 漏判**：正则只匹配 `list.htm`，而 `list2.htm`/`list231.htm` 是分页列表页 ⇒ 进了库并被读成内容页（**判据比对象宽**）。真实线上样本已进测试。
    ③ **读数歧义**：digest 头部「new 15 条待看」在未读 72 条时会被读成「只有 15 条未读」⇒ `shown`（本次列出）与 `filtered`（未读合计）必须分开说。
    ④ **渲染漏改**：加 `api` kind 时改了 digest 的标签渲染、**漏了扫描读数的** ⇒ 币安公告显示成 `[页面]`，**读数失真而没有任何报错**。处置不是「下次记得改两处」（枚举式判据注定在命名空间扩张时静默失效），而是抽 `kindTag()` 单一真源 + **结构断言测试**（`index.ts` 里再出现硬编码标签即失败）；该断言已用**尸体注入**验证有区分力（注入 ⇒ 红；撤销 ⇒ 绿）。
    ⑤ **空与失败不分型**：`search_academic` 有 5 条结果，而 `intel_scan` 扫同一查询得 0 条——真因是 `searchAcademic` 四个源一律 `.catch(() => [])`，源失败被读成「扫到 0 条 · state=ok」。修：`onError` 回调上抛 ⇒ `sourceErrors`（I9）。**顺带抓出 arxiv 两处**：用 http（走一次重定向，慢且偶发失败）+ 短语裸空格被解析成 OR（`self-improving agent` 实查 `self-improving OR agent`，105746 条，与意图完全不同）。
  - **实测源**：ccgp.gov.cn（首扫 9 条**全是附件**、零页面——基线判据的正对照）· sues.edu.cn（43 附件 + 页面）· arxiv（修复后 15 条 / 849ms）· **币安公告 API**（声明式第 4 类源，20 条 / 279ms，含上币公告）。
  - **声明式 JSON API 源**（`src/intel-api.ts`）：`itemsPath` / `idPath` / `titlePath` / `urlTemplate` 路径映射 ⇒ **加源不写代码**。判据：路径取不到 ⇒ 响亮报错（「0 条」与「路径配错」是两件事）；模板字段缺失的条目跳过并计数（**不产残缺 URL**——残缺 URL 会进快照、污染增量判据，且看起来像「抓到了」）；「跳过 N 条」（数据形状 ⇒ `notes`）与「路径取不到」（结构性失败 ⇒ `errors`）**分开报**。
  - **存量清理原语**（`intel_prune`）：判据会升级，存量不会自动跟上（实测新判据上线后库里仍有 76 条旧判据产的噪音，占未读 47.5%）⇒ 软标记可逆 + 默认干跑 + 原因进 meta。实测：干跑 76 = 独立脚本 76（**工具与脚本互证**）；apply 后注入读数 41 = 117 − 76（精确吻合）。
  - **验收**：`node --test` → **202/202**（+12 api 层 + 若干判据测试，含**真实响应样本**与 6 具尸体样本）；`tsc` EXIT=0；预检通过；6 次重启逐一线上取证（**每次线上验证都抓出离线看不见的真缺陷**——这个节奏本身就是本轮的结论）。

- **2026-10-08 · 通道「0 条」现场快照（诊断埋点 · 工单 t-6bee3fd0 第 1 步）**
  - **动机（读数缺陷）**：基线 v2 里出现过 `duckduckgo=ok:0`（两题，~5.3s）与 `parallel=ok:0`（两题，**~1000ms 秒回**，而成功态是 1099–7778ms）。两者都是**拿不到结果却记为「成功但空」**：DDG 三次尝试全解析 0 条后 `return last`（`[]`），`runChannel` 据此记 `ok:true, count:0` ⇒ 通道可靠性被高估，5.3s 的失败成本不可见。
  - **为什么不直接改行为**：异常页的现场特征**未捕获**（9/9 次复现全部正常：`len` 32–35K、`blocks=42`、`result__a=true`、无 anomaly/challenge 词）。判据必须是实测而非推断（本轮 bing 的两次试错已印证）⇒ **先埋点让现象自证**，等现场样本到齐再写判据、再改读数语义。
  - **新增能力**：`src/channelDiag.ts` —— `classifyDdgZero(html, parsed)`（**五种形状**：`anomaly` / `no-results-text` / `no-blocks` / `blocks-no-anchors` / `all-ads-filtered`）+ `classifyParallelZero(input)`（**四种形状**：`no-text-node` / `text-not-json` / `empty-results` / `all-filtered`）+ `appendChannelDiag`（追加一行到 `<DSH_HOME>/search-channel-diag.jsonl`，**失败即吞并返回 false**）。
  - **语义被补充（判据顺序是判据的一部分）**：`no-results-text` 必须判在 `no-blocks` **之前**——真无结果页本来就没有结果块，后置会把它误判成「结构变了（选择器失效）」，而两者修法完全不同。另补 `all-ads-filtered`：`out` 为空而锚点数 >0 ⇒ 全被判为广告，不是没有结果。
  - **语义被补充（parallel 有三处静默 `return []`）**：① 响应无 `content[0].text` 节点 ② `text` 不是 JSON ③ `results` 为空或全被 `.filter(r => r.url)` 滤掉。②最可疑：请求头带 `accept: text/event-stream`，若服务端回 SSE（`data: {...}` 行）则 `JSON.parse` 必抛 ⇒ 秒回 `ok:0`——`textHead` 就是判这条的现场证据。
  - **⚠ 本次被测试抓出的真缺陷（夹具碰生产）**：`appendChannelDiag` 初版写 `resolveHome(opts.env ?? process.env, opts.home)` —— `resolveHome` 的**第一个参数（env）优先**，于是单元测试传入的临时目录被环境里的 `DSH_HOME` 盖掉，**测试数据写进了生产侧车**（实测 2 行）。修法：`opts.home ?? resolveHome(...)`（显式路径 > 环境推导，与本插件 `searchTrace` 的既有约定一致），并补一条专门的回归测试「显式 home 优先于环境变量」。**教训：优先级不是细节——它决定夹具会不会碰生产。**
  - **本步不改行为**：0 条仍返回 `[]`。「0 条且判为非结果页 ⇒ 抛错」是判据成型后的下一步，且**行为变更前必须先做 call-site 审计**——`deep.ts:94` 与 `research.ts` 也直接调 `searchDuckDuckGo`，改成抛错要确认它们不会因此整体失败（这是本轮**未做**的检查）。
  - **✅ 现场标定成功（2026-10-08 08:34 · 正对照）**：用一个必然无结果的查询（`site:zzq-nonexistent-domain-12345.example hello world`，单通道 ddg）触发 ⇒ 读数 `duckduckgo=ok:0@8739ms`、工具显示「无结果」、侧车**首次写入 1 行**：`{"engine":"duckduckgo","shape":"anomaly","elapsedMs":8726,"features":{"len":14235,"blocks":0,"resultA":0,"parsed":0,"title":"DuckDuckGo","anomaly":true,"noResultsText":false}}`。
  - **把原页取回确认（不再推断）**：`fetch_page … mode=raw` 取同一 URL，页面里含 `action="//duckduckgo.com/anomaly.js?sv=html&cc=botnet&…"`、`<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>`、`Select all squares containing a duck:` ⇒ **这是反爬/CAPTCHA 页，不是「查询无结果」**，分类器的 `anomaly` 判定正确。
  - **判据据此加固（强标记 > 弱信号）**：新增 `DDG_ANOMALY_STRONG_RE`（`anomaly.js` / `anomaly-modal` / `cc=botnet` / `bots use duckduckgo too`）作为 `anomaly` 的**唯一充分条件**；原泛化正则降级为 `anomalyHint`（只记录、不判形状，防页面样板文本误报）；现场快照额外记 `anomalyMarkers[]`（可判读的标记清单）。**实测判别量**：反爬页 `len≈14.2K` vs 正常页 `32–35K`、`blocks=0`、标题泛化为 `DuckDuckGo`（正常页是「‹query› at DuckDuckGo」）。
  - **诚实边界**：这次是**我自己连续请求把 DDG 打到风控**后触发的（同一分钟前的负对照仍是 `ok:10@1654ms`）⇒ 它证明了「反爬页长什么样 + 埋点能否抓到」，**不等于**基线那两次 `ok:0` 的因果已证实（那两次 5.3/5.6 s，本次 8.7 s）；形状一致（短页/无块）的可能性高，但要靠自然复现或更多样本收敛。
  - **验收与回归**：`node --test tests/channel-diag.test.mjs` → **15/15**（含**真实标记**样本 + 一条精确性测试「仅泛化词命中**不**判 anomaly」）；全量 `node --test tests/*.test.mjs` → **91/91**；`tsc` 干净。

- **2026-09-18（第二轮）· U10 闭环 + 逐通道读数 + 领域路由（测试 40→69）**
  - **U10 的最终定性，把我前两轮的判词都推翻了**：既不是「绑定地址不对」，也不是「Windows↔WSL 可达性间歇」。真因两条叠加——
    ① 容器在 8888 上 **crash-loop**：`docker logs` = `RuntimeError: Address already in use (os error 98)`，`inspect` = `status=restarting restarts=7`；
    ② 我的就绪门当时只把「Windows 直连」当就绪判据，**失败就提前 `return []`**——把唯一可用的 **WSL 内 curl** 那条路也掐了。
    **关键取证难点**：WSL `ss -ltn` 与 Windows `Get-NetTCPConnection -LocalPort 8888` **两边都读不到 8888 的持有者**
    （`.wslconfig` 是 `networkingMode=mirrored` ⇒ 端口空间与 Windows 共享，冲突来源不可见）。
    ⇒ 换到 **18788**（低于 Linux 32768-60999 与 Windows 49152-65535 两段临时端口区）后，**3 秒内 200 / 35 条**。
  - **新不变量 ①**：「服务在答」与「Windows 直连能到」是**两个判据**——就绪门不得把后者当前者（否则第二路会被误杀）。
    **新不变量 ②**：容器 `Restarting/Exited` ⇒ 自愈走文档化的 `docker compose down --remove-orphans && up -d`（`--force-recreate` 会留端口僵尸）。
    **新不变量 ③**：聚合类工具必须落 `channels[]` 读数（`engine/ok/count/ms/via/error`），「0 条」与「为什么 0 条」不得分离。
  - **通道的固有边界（如实记）**：**同一查询连打会把上游打到限流**——SearXNG 如实报 `unresponsive_engines:
    [['brave','Suspended: too many requests'], ['duckduckgo','CAPTCHA']]`，此时靠 `google cse` 等仍能出 20+ 条。
    ⇒ **验收必须用真实使用形态（查询是变的）**；缓解三件：空结果**重试一次** + 第二发用**简化查询**（前 4 词）+
    补 `mojeek`/`marginalia` 两条独立索引 + 上游超时 6/10 → **8/14**。
  - **新增能力**：① `src/searxng.ts` 就绪门（探活→冷启 VM→容器健康自愈→轮询→有界保活 120 min；并发**单飞**）；
    ② `search_web` 结果带 `channels`，trace 增 `channels` 字段（脱敏 + 键位固定）；③ 深研**领域路由** `routeIntents`
    （代码类→GitHub 仓库、研究类→学术三源，`routing=off` 可关）；④ 来源标 **★多引擎一致**（≥2 通道独立命中）。
  - **改环境的动作（留痕）**：容器端口 8888 → **18788**（compose + settings + 插件默认 `searxngBase`）；引擎启用 `mojeek`/`marginalia`。
  - **验收与回归**：`node --test tests/*.test.mjs` → **69/69**；`node scripts/searxng-gate-proof.mjs 4 6` → 逐轮 `ready=true`
    （结果条数受上游限流影响，属 U12 边界）；`tsc --noEmit` 干净。

- **2026-09-18 · 检索增强批次（两引擎 + `search_deep` + 评测；工具面 23→24）**
  - **新增能力（语义扩张）**：① 引擎 **`parallel`**（`https://search.parallel.ai/mcp`，**无账号/无 key**；形状＝`objective` + 一次多查询扇出 + 稳定 `session_id`，返回**密集摘录**）；② 引擎 **`searxng`**（自托管 JSON API，默认 `http://127.0.0.1:8888`，配置项 `searxngBase`）；③ 工具 **`search_deep`**（`src/research.ts:deepResearch`）＝ 扇出 → 多引擎并行 → 去重 + 每域≤2 → **相关性 rerank** → **缺口补查 gap fill** → 抓正文 → **带 `[n]` 引用的报告**，并回报 `stats{engineCalls,queries,sources,fetched,callsPerAnswer,rounds,gapFilled}`。
  - **⚠ 行为变更（默认值语义变了）**：`search_web` 默认引擎组由 `duckduckgo+brave` 改为 **`parallel+searxng+duckduckgo+brave`**——**默认延迟与结果集都变了**（单查询结果数 10 → 16~20），且多了一个**本机进程依赖**（SearXNG 容器）。调用方若要求最小延迟应显式传 `engines`。
  - **教训一 · 沉默失败（本轮最贵）**：`search_deep` 首次上线时 **trace 记 `ok:true` / 8.6 s，界面输出为空**。根因＝**render 契约写错**：`dsh-tools` 的 render 必须返回 **`[{ type:'text', text }]`**，我返回了裸字符串数组。**「调用没报错」与「结果被人读到」是两件事**；判据必须落到后者（A18）。
  - **教训二 · 部署面三坑（SearXNG）**：① **容器必须带代理 env**（`HTTP(S)_PROXY=http://127.0.0.1:16888`），否则所有上游引擎 `timeout`（WSL 的出网走 Windows 侧 Clash，容器默认不带）；② **必须 `network_mode: host`**（bridge 下 `host.docker.internal:16888` 到不了 Windows 侧代理）；③ 镜像入口脚本用 **env 覆盖** `server.port`/`bind_address`（改 `settings.yml` 不生效）⇒ 用 `SEARXNG_PORT=8888`。**恢复法**：`--force-recreate` 会留下霸占 host 端口的僵尸 ⇒ 容器进 `RuntimeError: Address already in use` 重启循环 ⇒ 正解 `docker compose down --remove-orphans` 后 `up -d`。
  - **教训三 · 先修仪器再改系统**：带标注评测首跑把 `readthedocs` 判成 MISS，实为**标签写错**（真域名 `docs.readthedocs.**com**`，我写了 `.io`）⇒ 修标签后 `hit@3` 从 7/8 变 **8/8**、MRR 0.813 → **0.938**。**评测工具的错判会伪装成被测系统的缺陷**。
  - **边界如实记（反面结论）**：双通道对**英文技术类深研查询没有增加来源**（同一组 4 条来源全部来自 `parallel`，多出的引擎调用被去重吃掉）⇒ 第二通道的收益是**抗单点与结果多样性**（`engineCoverage`：`parallel 41/80` + `searxng 17/62`），**不是这批查询上的准确率**。不要把覆盖率上升读成质量上升。
  - **验收基线与回归**：`node --test tests/*.test.mjs` **40/40**；`scripts/search-bench.mjs`（12 条）`12/12 命中 · avgDomains 5.8`；`scripts/search-bench-eval.mjs`（8 条弱标注）**hit@3 8/8 · hit@5 8/8 · MRR 0.938**。提交：`jonah791/dsh-search-pro` `5f58959`。

- **2026-09-14 · ESM 契约缺陷（headless 临时 profile 泄漏 ~180MB，已修 + 加机器守卫）**
  - **症状**：headless 通道每次调用泄漏一个 `%TEMP%\dsh-robust-<ts>` 目录（实测 **15 个**，每个约 **12MB**），日志毫无异常。
  - **根因**：本包 `type=module` + tsconfig `module:NodeNext` ⇒ 产物是纯 ESM，但 `src/robust.ts` 的清理写了 `require('node:fs')`——ESM 下 `require` 未定义 → 抛错被 `catch { /* 忽略 */ }` **静默吞掉**。**「清理失败的静默」伪装成了「已清理」。**
  - **修复**：改顶部静态 `import { rmSync } from 'node:fs'`；§10 的 U1 由此闭环。
  - **语义被补充（新不变量）**：**产物不得出现裸 `require(` 调用**——本包是 ESM，任何历史 CJS 写法都会在运行期抛错并被自身 try/catch 吞掉。由 `tests/esm-contract.test.mjs` 机器守卫；**尸体测试**：未重建的旧产物上该测试确实失败（已实测），重建后通过。
  - **语义被补充（测试面）**：`tests/util.test.mjs` 20 例覆盖 `stripTags`/`htmlToText`/`decodeDdgUrl`/`decodeBingUrl`/`normalizeUrl`/`dedupe`/`str`/`num` 的正常路径 + **失败/退化路径**（非法百分号编码、非法 URL、空值、类型不符）。
  - **教训一（写测试的纪律）**：首版把 `decodeDdgUrl` 的失败路径断言成「原串原样返回」——实测是「非法编码 → `decodeURIComponent` 抛错 → 落入协议补全分支 → `//` 补成 `https://`」。**测试必须编码意图行为，不是猜测行为**；断言失败先判「代码错还是预期错」。
  - **教训二（回写技能 `plugin-maintainability`）**：`catch { /* 忽略 */ }` 是缺陷温床——**静默兜底必须配一条「它真的兜住了吗」的观测**，否则失败被伪装成成功。

- **2026-09-14 · 批次 S4-A：自证轨迹层（观测层新增，业务行为零变更）+ 抓到 1 个真缺陷**
  - **语义被补充（新不变量 ①）**：**元数据数组不是结果条数**。`fetch_robust` 的返回体带 `attempts[]`
    （通道尝试记录）却**没有** `results`；「取第一个数组属性」的朴素实现会把「4 次通道尝试」报成
    「4 条结果」——**Q4 读数被污染，而且它看起来完全合理**（这正是这类缺陷危险的地方）。
    修法：`META_ARRAY_KEYS = attempts/warnings/errors/notes/queries/engines/logs/trace` 显式排除。
    **发现方式**：单测首跑红（`composeSearchEntry` 的 `count` 期望 0、实际 2）⇒ 判为**代码错**（不是预期错），
    修代码 + 留回归用例（A14）。**这就是「测试抓到真缺陷」而不是「测试迎合实现」的样子。**
  - **语义被补充（新不变量 ②）**：**观测覆盖必须由构造保证，不靠逐点登记**。23 个工具的收口在
    `reg()` 内层——一个包装器覆盖整个工具面。反面教训来自本仓 §4.3 那种「逐点列调用点」的写法：
    漏一处就是新盲区，而**漏掉的那一处永远不会自己报错**。
  - **语义被补充（隐私两层闸）**：把「凭据不落盘」从承诺升级为**双闸构造**——白名单（正面清单）+
    键名黑名单（`/pass|secret|token|key|cookie|auth|…/i`，即使日后误加进白名单也整键丢弃）+ 值脱敏。
    直接回应 **U4**（`search_leaks` 明文口令）：**轨迹侧已确认永不落盘**（A16 端到端尸体测试）；
    会话事件流侧仍是开放的（那是「模型可见 ⟺ 已记录」的范畴，见 §10 U4 更新）。
  - **语义被修正（原文档的判据升级）**：A7「反爬轨迹可读」原先只能靠**读结果 note 文本**（人眼）；
    现在 `channel`/`attempts` 成了**结构化字段**，可 `grep`/聚合（「哪一级最常命中」「哪一级最常失败」）。
  - **行为变更清单**：**无**——`reg()` 只把每个工具对象**浅拷贝 + 替换 `execute`**；
    包装器返回值原样透出、业务异常原样重抛。`git diff` 核对：`src/index.ts` 的改动仅「导入 + `reg` 定义替换」，
    **23 个工具定义体一行未动**。

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：23 工具、`inject=['tools']`、`SearchStore` 全内存态、输出外壳 `{ok,count,results}`。
  - 语义**被补充**：7 条有缓存的键清单、`.credentials.yaml` 兜底路径与匹配式、WSL/Tor/Chrome 三个运行期外部依赖、`archiveTodayLookup` 为未接入死代码。
  - 语义**被修正**：README「零运行时依赖（Node 原生 fetch + WSL curl）」易被误读为「无外部依赖」——本插件**强依赖** WSL2 curl / tor daemon / Chrome（headless），已在本节与 §5 显式化。
  - 教训（回写技能 `semantic-doc-first`）：文档的「依赖」一节必须区分 **npm 依赖** 与 **运行期外部依赖**（进程/守护/可执行文件），否则语义文档会给出「能跑」的错误信心。

## 10 · 未决问题

- **U13（新，2026-10-17）情报库无上界与轮转**：`items.jsonl` 纯追加（软标记也只增行，`intel_prune` 同样是 append），无上界。当前 189 条无压力，但站点类目标可持续产条目 ⇒ 需要归档策略。⚠ **不能照搬 U6 的按行数裁剪**——情报条目按行丢会丢信息；正解是先按状态归档（`dropped` / 老 `seen`）再考虑物理轮转。
- **U14（新，2026-10-17）站内搜索探测的覆盖边界**：三站实测——上师大 **POST 型**（`action=/_web/_search/api/search.new.rst`，参数 `input=keyword`）· gov.cn **无 action**（JS 驱动）· wikipedia **需组合参数**。论文的「只有 GET 可索引」是硬边界 ⇒ **中国站点大量用 POST/JS，该功能覆盖率有限**。已如实报原因（不假装「这个站没有搜索接口」），**未做**的是 POST 表单的实际提交（需构造 body + CSRF 处理）。
- **U15（新，2026-10-17）「表单之后的深网」无人覆盖**：本轮读的 12 篇论文**没有一篇处理表单提交之后的深网**——那正是 Harnessing the Deep Web（CIDR 2009）的原始命题，也是我缺的那块。当前 `discover_site` 只做 GET 探测。
- **U16（新，2026-10-17）情报推送未实测**：`intel_digest` 出文本 + telegram 发送是**两个独立动作**（推送与否归主体裁决，见 §1 反定位）。判据已写进技能 `deep-web-discovery`（高价值新增 + 有时效性 + 非睡眠时段），但**一次真实推送都没做过**（深夜不宜打扰）⇒ 早间汇总时验证。
- **U17（新，2026-10-17）`.doc` 抽取未验证**：`antiword` 因 apt 依赖冲突未装上，`extract_document.py` **如实报「未验证」**（不假装能读）。老式 `.doc` 在政府/高校站点常见，是覆盖缺口而非已知不可行。
- **U18（新，2026-10-17）arxiv 修复后的「结果质量」未验证**：I13 的编码修复**请求形态已线上验证**（错误信息带出构造后的 URL，冒号保留 / 空格 `+` / 去重生效），但**「返回的论文是否真的相关」没验**——限速 429 挡住了（本机 IP 当晚连打 8+ 次，单次 429 响应耗时 16.2s）。⚠ 附带发现（已登记任务板 `t-2dfb92b5`）：429 响应慢时会**撞 `httpGet` 超时**，于是「被限速」被读成「超时」（`This operation was aborted`）——**归因方向被误导**。⇒ 待限速窗口过后重扫一次，用「新条目相关性」作为判据（旧 20 条的污染率 75% 是基准线）。
- **U19（新，2026-10-17）`intel_watch` 改不了 spec——监控源无法演进**：`action=update` 只改 `note`，改不了 `query` / `url` / `maxPages` / `itemsPath`。想改 query 就只能 `remove` + `add`，而 `add` 会**清快照**（正确，否则增量判据失真）⇒ **代价是丢 `foundTotal` 与历史**。本轮就是这么处理 `arxiv-deepweb` 的（旧 20 条几乎全是垃圾，删了重建反而是净收益）——但那是**运气**，不是判据。⇒ 待做：`update` 支持可选 `spec`（部分合并 + 按 kind 校验必填项），且**改 spec 时显式报出「快照已清」**。已登记任务板 `t-e6ecec0a`。**（2026-10-17 02:2x 已闭环：`update` 支持 spec 字段级合并——辅助字段（`timePath`/`titlePath`/`idPath`/`urlTemplate`/`maxPages`）**不清快照**，取数范围（`url`/`domain`/`query`/`itemsPath`）变了才清并**显式报出**；线上实测 `已更新 api-okx-listing：timePath / note`）**
- **U20（新，2026-10-17）arxiv 源产的是「论文库」不是「情报流」**：digest 里两条 arxiv 论文是 **2016 / 2020 年**的——arxiv API **默认按相关性排序**，不是按提交时间 ⇒ 监控源拿到的永远是「该主题的经典论文」，不是「新论文」。**修法方向**：`sortBy=submittedDate&sortOrder=descending`（arxiv API 标准参数），但**未取证**（02:24 实测仍 `Rate exceeded.`）⇒ 按 §5.9「能力断言先探测」，**未验证的参数不加**。
  ⚠ 同一处还有第二个待办：arxiv 的**存量回填**（36 条论文的 `publishedAt`）也要等限速解除——接线**已上线**（`publishedAtFromExtra`），但**回填必须重扫**，而限速挡着。**实测边界**：限速窗口 **> 32 分钟**（01:51 调用 → 02:24 仍 `Rate exceeded.`，14 字节立即返回，**不是超时**）；每次试探都在延长窗口。

- **U2 缓存淘汰只清过期项**：`set()` 在 `size > 500` 时仅删 `expiresAt` 已过的键；高活跃会话可超 500 条常驻。
- **U3 `SearchStore` 作用域**：实例在 `apply()` 内创建——单 web 进程内多会话是否共享同一实例（→ 缓存/配额是否跨会话串味）待实测确认；确认后回写本节。
- **U4 `search_leaks` 与「凭据不落盘」纪律的张力（2026-09-14 批次 S4-A 部分闭环）**：明文密码作为工具参数
  必然进入会话事件流（模型可见 ⟺ 已记录）。**轨迹侧已闭环**：`password` 既不在 `SUBJECT_KEYS` 白名单、
  又命中 `SECRET_KEY_RE` 黑名单，**永不落盘**（§7 A16 端到端尸体测试）。
  **仍未闭环的是会话事件流侧**——那是 append-only 记录的固有属性，不由本插件控制。
  倾向：文档明示「只查一次性的自查口令，禁止查主人真实在用的口令」。
- **U5（新，2026-09-14 批次 S4-A）缓存命中在轨迹里不可见**：`search_web` 等 7 个工具的缓存
  `store.get(ck)` **藏在各自 `execute` 内部**，而观测收口在 `execute` **外层**——命中时 `count` 有值、
  `durationMs` 极小，但**没有 `cacheHit` 字段**（要靠「耗时异常小」推断，属间接证据）。
  为何不修：加字段需在 7 处 execute 内部埋点（违反「单点收口」），或给缓存返回值加标记
  （**改业务返回形状**，output.schema 是 `additionalProperties:false`，会被校验拒收）。
  倾向：若日后确需，用「`store` 暴露 `hits` 计数、包装器前后取差」实现——**零业务改动且仍是单点**。
  需裁决是否本轮补。
- **U6（新，2026-09-14 批次 S4-A）轨迹文件无轮转**：`search-trace.jsonl` 为纯追加，无上界。
  本插件调用频率**最高**（23 工具 + 多引擎翻页，单轮可达数十次），是四个 S4-A 插件里最需要上限的一个。
  倾向：按 `dsh-plugin-bootreport` 的「有界裁剪（`keepLines + 50`）」加上限，断言写「有界」而非「恰好等于」。
  需裁决是否本轮补。

- **U7（新，2026-09-18）官方 `web-search-deepseek` 配置为空 ⇒ `web_search` 恒 401**：`settings.yaml` 里
  `web-search-deepseek: {}`，其请求打 `https://api.deepseek.com/anthropic/v1/messages`，报
  `HTTP 401 Authentication Fails, Your api key: ****6ilR is invalid`。该工具自述**搜索端点与 chat 分开**、
  可用 `DEEPSEEK_SEARCH_BASE_URL` 或 `web-search-deepseek.baseURL` 改指，并明确 **「Only the user should choose
  or change the endpoint」**。⇒ **归属主人裁决**（换 key / 换端点 / 退役该设置）。本插件已用
  `parallel` + `searxng` 两条**无钥匙**通道替代该能力，故不阻塞。
- **U8（新，2026-09-18）SearXNG 的暴露面与健康未纳入观测**：host 网络下实际监听 **`*:8888`**（非计划的
  `127.0.0.1`）；暴露面限于 WSL NAT + Windows localhost 转发（未对局域网开放），但**偏离了「只绑本机」的设计意图**。
  同时容器健康**没有任何观测**——它 12:31 进重启循环时，插件侧只表现为「searxng 静默返回 0 条」，
  与 `parallel` 正常无差别。倾向：① 把 `unresponsive_engines`/容器健康折进 `search_deep` 报告的「通道健康」段；
  ② 或加一条 `search_quota` 式的 searxng 探针。**需裁决是否本轮补。**
- **U9（新，2026-09-18）真 reranker 未接入**：本轮的「相关性 rerank」只是**词面命中计数**（引擎票数 + 查询词
  在标题/摘录中出现次数），不是学习型 reranker。调研中出现的 **RankLLM MCP（SIGIR 2026，提供
  `retrieve-and-rerank` / `rerank` 两个工具）** 是现成的下一级选项。倾向：先看英文技术类查询的实际痛点是否需要，
  再决定是否引入一个 Java/Python 侧服务（运行期依赖成本高）。
- **~~U10（2026-09-18 · 已闭环 · 第二轮）~~ 宿主是 Windows、SearXNG 在 WSL：`searxng` 在工具路径上等于没接**
  - **最终定性（推翻了两轮猜想）**：既不是「绑定地址不对」，也不是「可达性间歇」——
    **① 容器在 8888 上 crash-loop**（granian `RuntimeError: Address already in use (os error 98)`），
    **② 我自己的就绪门当时只看「Windows 直连」，直连不通就提前 `return []`，把唯一可用的 WSL 内 curl 那条路也掐了**。
  - **证据链**：`docker inspect` → `status=restarting restarts=7`；`docker logs` → `RuntimeError: Address already in use`；
    WSL `ss -ltn` 与 Windows `Get-NetTCPConnection -LocalPort 8888` **两边都读不到持有者**（`.wslconfig` 是
    `networkingMode=mirrored` ⇒ 端口空间与 Windows 共享，冲突来源不可见）⇒ **换到 18788（低于 Linux 32768-60999
    与 Windows 49152-65535 两段临时端口区）后立刻 `Up`**，WSL 侧 3 秒内 200 / 35 条。
  - **修法（已上线）**：`src/searxng.ts` 的**就绪门**——`probe-direct`（便宜）→ `probe-wsl`（**宿主实际走的那条**）→
    `boot-vm`（WSL VM 空闲 ~60 s 自动关机是**另一个**真因，故门要先把它带起来）→ `container-health`
    （`Restarting/Exited` ⇒ `compose down --remove-orphans && up -d` **自愈**）→ 轮询 → 有界保活（120 min）；
    并发扇出**单飞**共享同一次带起；**门失败不再提前返回**（继续走「直连 → WSL curl」两条路）。
  - **验收**：`node scripts/searxng-gate-proof.mjs 4 8`（Windows 侧）逐轮 `ready=true`；`tests/searxng.test.mjs` 11 例离线锁死。
- **U11（新，2026-09-18 · 未闭环）SearXNG 的实际监听面仍是 `*:18788`**：`ss -ltn` 显示 `*:18788`，
  即镜像入口脚本**没吃下** `SEARXNG_BIND_ADDRESS=127.0.0.1`（实测：只改 `settings.yml` 也无效）。
  mirrored 网络下这意味着端口可能与 Windows 侧共享暴露面。**未验证**是否能从局域网 IP 访问
  （`curl --noproxy '*' http://<internal-host>:18788/…` 在 VM 冷启窗口返回 000，证据不足）。
  倾向：下轮先做一次**明确的暴露面取证**（VM 热时从局域网侧试），再决定是否改用
  `bridge + 127.0.0.1:18788:8080` 发布（代价＝容器出网要另配 `host.docker.internal:16888`）。
- **U12（新，2026-09-18 · 通道固有边界）上游引擎会限流**：同一查询连打若干次后，SearXNG 自己会如实报
  `unresponsive_engines: [['brave','Suspended: too many requests'], ['duckduckgo','CAPTCHA']]`，
  此时仍可能由 `google cse` 等引擎给出 20+ 条。**已做**：① 抓取层「空结果重试一次」；
  ② 补两条独立索引（`mojeek`/`marginalia`）当第三条腿；③ 把 `unresponsive_engines` 折进通道读数与报告。
  **仍存**：极端限流下该通道可能整轮空手——报告里会显示为 `0 条（已重试一次；unresponsive=…）`，**不静默**。

## 附 · 快速取证命令

```bash
# Q1–Q5 一条命令（最近三次调用）
tail -3 "$DSH_HOME/search-trace.jsonl"
# 反爬链：各通道命中分布（哪一级最常兜住）
grep -o '"channel":"[a-z]*"' "$DSH_HOME/search-trace.jsonl" | sort | uniq -c | sort -rn
# 失败笔次（Q3 断点 + 原事故的可观测面：日志干净但轨迹不干净）
grep '"ok":false' "$DSH_HOME/search-trace.jsonl" | tail -5
# 按工具聚合耗时（Q5：哪个工具最贵）
grep -o '"op":"[a-z_]*"\|"durationMs":[0-9]*' "$DSH_HOME/search-trace.jsonl" | paste - - | sort -t: -k3 -rn | head -5
```
