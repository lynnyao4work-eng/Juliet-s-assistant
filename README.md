# Discord Mod Tracker

一个 Discord 机器人：**自动记录指定频道的所有消息**，并在你输入 `/check` 时，
用 AI 把「上次 check 到现在」的聊天内容总结成一份中文纪要，只有你自己能看见。

---

## 目录

1. [它长什么样](#1-它长什么样)
2. [整体架构](#2-整体架构)
3. [部署前准备（只需要做一次）](#3-部署前准备只需要做一次)
4. [第一步：Supabase 建表](#第一步supabase-建表)
5. [第二步：申请 DeepSeek API Key](#第二步申请-deepseek-api-key)
6. [第三步：Discord 开发者后台设置](#第三步discord-开发者后台设置)
7. [第四步：把代码传上 GitHub](#第四步把代码传上-github)
8. [第五步：在 Render 部署](#第五步在-render-部署)
9. [第六步：配置保活监控](#第六步配置保活监控)
10. [第七步：限制只有指定的人能使用 /check](#第七步限制只有指定的人能使用-check)
11. [怎么用](#怎么用)
12. [环境变量速查表](#环境变量速查表)
13. [以后怎么改（加频道 / 加关注成员 / 改命令名）](#以后怎么改)
14. [出问题了怎么办](#出问题了怎么办)

---

## 1. 它长什么样

你在 mod room 频道里输入：

```
/check
```

机器人只会回复给你自己（其他人看不到）：

```
📋 #mod-room · 消息总结
**统计区间**：2026/09/20 15:51 → 2026/09/21 10:46（18 小时 55 分钟）
**消息总数**：123 条 · **参与成员**：5 人
**发言排行**：alice(45)、bob(30)、carol(28)…
────────────────────

## 一句话总览
……

## 主要讨论主题
- **XXX 的处理**：……

## 关键结论 / 已决定事项
- ……

## 待办 / 需要跟进
- ……

## 风险 / 争议 / 违规事件
- ……

## 各成员发言要点
- **alice**：……
```

> 上面是默认的中文输出（`SUMMARY_LANGUAGE=Chinese`）。把 `SUMMARY_LANGUAGE` 改成 `English`，
> 机器人外壳仍为中文，但 AI 总结正文会变成英文（小节标题变为 `## TL;DR` 等）。
> 这条回复通过 **Discord 私信 (DM) 发给你**，mod room 里只剩一行 `✅ 已通过私信发送。` 的小提示，其他人看不到任何内容。

下一次 `/check` 会自动从**上一次的结束时间**继续，不会重复总结。

---

## 2. 整体架构

```
Discord mod room 频道
        │  （机器人实时监听每条消息）
        ▼
   Bot 程序（跑在 Render）──────►  Supabase 数据库（存消息 + check 记录）
        │
        │  /check 时读取区间消息
        ▼
   DeepSeek API（生成中文总结）
        │
        ▼
   以「仅自己可见」的形式回复到 Discord
```

- **Render**：免费 Web Service，负责 24 小时跑程序。免费实例闲置 15 分钟会休眠，所以需要下面的保活。
- **保活**：用 UptimeRobot / Better Stack 每分钟隔几分钟访问一次 Render 的网址，让它永远不休眠。
- **Supabase**：免费 PostgreSQL 数据库，存聊天记录和每次 check 的时间点。
- **DeepSeek**：国产大模型，接口兼容 OpenAI 格式，中文强、价格极低、对敏感内容较宽容。

> **⚠️ 为什么不能在你自己电脑上跑？**
> `discord.com` 在中国大陆网络下无法直连（实测连接超时），而机器人必须连上 Discord 才能工作。
> Render 的服务器在新加坡，可以正常访问 Discord，所以**必须部署到 Render**，本机只能用来改代码。

---

## 3. 部署前准备（只需要做一次）

你需要准备好这 6 样东西：

| # | 东西 | 在哪拿 |
|---|---|---|
| 1 | Discord Bot Token | Discord 开发者后台（已有，见第三步核对） |
| 2 | Discord Client ID | Discord 开发者后台 → General Information |
| 3 | mod room 频道 ID | Discord 客户端右键频道 → 复制频道 ID |
| 4 | DeepSeek API Key | platform.deepseek.com |
| 5 | Supabase URL + service_role Key | Supabase → Project Settings → API |
| 6 | GitHub 仓库 | github.com |

---

## 第一步：Supabase 建表

1. 打开 https://supabase.com ，进入你已创建的项目（本项目用的是 `lkgkqaqhxitpkemekgre`）。
2. 左侧菜单点 **SQL Editor** → **New query**。
3. 用文本编辑器打开本项目里的 `supabase/schema.sql`，**全选复制**，粘贴进 SQL 编辑框。
4. 点右下角 **Run**（或按 `Cmd + Enter`）。
5. 看到 `Success. No rows returned` 就成功了。
6. 左侧点 **Table Editor**，应该能看到 `messages` 和 `check_records` 两张表。

> 这个脚本可以重复执行，不会报错也不会丢数据。

**同时请确认你的 Supabase URL 和 Key：**
- 左侧 **Project Settings** → **API**
- `Project URL` → 形如 `https://xxxx.supabase.co`（**末尾不要带 `/rest/v1/`**）
- `Project API keys` 里的 **`service_role`**（点 Reveal 显示）——注意不是 `anon` 那个

---

## 第二步：申请 DeepSeek API Key

1. 打开 https://platform.deepseek.com ，注册并登录（需要手机号）。
2. 左侧 **API keys** → **创建 API key** → 命名随意（比如 `discord-bot`）→ 创建。
3. **立刻复制这串 key**（形如 `sk-xxxxxxxx`），页面关掉就再也看不到了。
4. 左侧 **充值**（Top up），充 **10 元**就够用很久（本场景大概每百万字消耗 1 块钱量级）。

---

## 第三步：Discord 开发者后台设置

打开 https://discord.com/developers/applications ，选中你那个 Application。

### (1) 开启「读取消息内容」权限（**必做，漏了机器人收不到任何消息**）
左侧 **Bot** → 往下找到 **Privileged Gateway Intents** → 打开 **MESSAGE CONTENT INTENT** → Save Changes。

### (2) 核对 Token 和 Client ID
- **General Information** → 复制 `APPLICATION ID`（就是 Client ID）
- **Bot** → `Token` → 如果忘了就点 **Reset Token** 重新生成一次（**旧 Token 会立刻失效**）

### (3) 把机器人邀请进你的服务器
把下面这行里的 `你的_CLIENT_ID` 替换成你的 Application ID，然后在浏览器打开：

```
https://discord.com/oauth2/authorize?client_id=你的_CLIENT_ID&scope=bot%20applications.commands&permissions=84992
```

本项目的 Client ID 已经填好，可以直接用：

```
https://discord.com/oauth2/authorize?client_id=1551412653367369738&scope=bot%20applications.commands&permissions=84992
```

选好服务器 → 授权。

> `permissions=84992` = 查看频道 + 发送消息 + 嵌入链接 + 读取消息历史。
> 如果 mod room 是**私密频道**，还需要在频道权限设置里单独把机器人加进去（或给它所在身份组开权限）。

---

## 第四步：把代码传上 GitHub

代码文件夹**已经初始化好 git 并暂存了所有文件**（`.env` 和 `node_modules` 已自动排除），
你只需要把提交推到 GitHub 上。

### 先在网页上建仓库

打开 https://github.com/new ，仓库名填 `discord-mod-tracker`，选 **Private**（私有），
**不要**勾选 Add a README / .gitignore（我们已经有自己的了），点 Create repository。

### 方式 A：用 GitHub Desktop（图形界面，推荐给非程序员）

1. 下载安装 https://desktop.github.com ，用你的 GitHub 账号登录。
2. 菜单 **File → Add local repository** → 选择文件夹 `/Users/linyao/Desktop/discord bot`。
3. 左下角 Summary 填 `init: discord mod tracker`，点 **Commit to main**。
4. 顶部点 **Publish repository** → 取消勾选 "Keep this code private" 如果你想公开，否则保持勾选 → Publish。

### 方式 B：用终端

打开「终端」，逐行执行（把 `你的用户名`、`你的邮箱` 换成你自己）：

```bash
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"

cd "/Users/linyao/Desktop/discord bot"
git commit -m "init: discord mod tracker"
git remote add origin https://github.com/你的用户名/discord-mod-tracker.git
git push -u origin main
```

> 推送时会要求登录 GitHub，用账号密码或个人访问令牌（PAT）即可。

**⚠️ 上传前请确认 `.env` 没有被提交**（`.gitignore` 已经排除它了）。
执行 `git status` 检查：列表里**不应该**出现 `.env`。

---

## 第五步：在 Render 部署

### 方式 A：用 Blueprint（推荐，最省事）

1. 打开 https://dashboard.render.com/ ，注册/登录（用 GitHub 账号登录最方便）。
2. 点 **New** → **Blueprint** → 选择刚才那个仓库 → **Connect**。
3. Render 会自动读取 `render.yaml`，并弹出要求你填写的密钥。逐个填入：

| 变量名 | 填什么 |
|---|---|
| `DISCORD_TOKEN` | 你的 Bot Token |
| `DISCORD_CLIENT_ID` | 你的 Application ID |
| `AI_API_KEY` | DeepSeek 的 `sk-xxxx` |
| `SUPABASE_URL` | `https://lkgkqaqhxitpkemekgre.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase 的 service_role key |
| `ALLOWED_USER_IDS` | 允许使用 `/check` 的用户 ID（如 Juliet 的 ID），多个用英文逗号分隔 |

4. 点 **Apply** / **Create Resources**，等待构建完成（大约 2–5 分钟）。

### 方式 B：手动创建

1. **New** → **Web Service** → 连接仓库。
2. 配置：
   - Language: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
   - Region: **Singapore**
   - Health Check Path: `/health`
3. 展开 **Environment Variables**，按上面那张表逐个添加，
   并额外补上这些（照抄）：

| 变量名 | 值 |
|---|---|
| `NODE_VERSION` | `22` |
| `AI_BASE_URL` | `https://sub2apis.ruobin.dev/v1`（见下方「切换 AI 供应商」） |
| `AI_MODEL` | `gpt-5.6` |
| `TRACK_CHANNEL_IDS` | `1419607085821333634` |
| `ALLOWED_USER_IDS` | Juliet 的用户 ID（见下方「限制只有指定的人能用」） |
| `SUMMARY_LANGUAGE` | `Chinese`（命令界面固定英文，这个只控制 AI 总结正文语言） |
| `TIMEZONE` | `Asia/Shanghai` |
| `RETENTION_DAYS` | `7`（超过 7 天的旧消息和 check 记录自动删除，`0`=永久保留） |
| `MAX_SUMMARY_MESSAGES` | `3000` |

4. **Create Web Service**。

### 验证部署成功

打开 Render 服务页面，切到 **Logs** 标签，应该能看到：

```
======== 运行配置 ========
监控频道      : 1419607085821333634
...
[HTTP] 监听端口 10000（/health 用于保活，/status 用于监控）
[机器人] 登录成功：YourBot#1234
[命令注册] /check 已注册到服务器 xxxxx
[补齐] 频道 1419607085821333634 完成：扫描 xx 条，新增 xx 条
[自检] AI 接口连通正常
```

看到这些就说明一切正常。

---

## 第六步：配置保活监控

Render 免费实例闲置 15 分钟会休眠，休眠期间机器人掉线、消息会漏（重启后会自动补齐最近 3000 条，但最好别让它睡）。

### 用 Better Stack（你说的那家）

1. 打开 https://uptime.betterstack.com ，注册登录。
2. **Monitors** → **Create monitor**
   - Monitor type: **HTTP(s)**
   - URL: 你的 Render 地址 + `/health`，例如 `https://discord-mod-tracker-xxxx.onrender.com/health`
   - Check frequency: **3 minutes**（免费版支持）
   - Alert contacts: 填你的邮箱
3. 保存。

### 用 UptimeRobot（同理，免费版最快 5 分钟一次，也够用）

Monitor Type 选 `HTTP(s)`，URL 填 `.../health`，Interval 选 5 minutes。

> 想同时在机器人掉线时收到邮件？再建一个监控，URL 指向 `/status`。
> 机器人在线时返回 `200`，掉线时返回 `503`，这样就会触发告警邮件。

---

## 第七步：限制只有指定的人能使用 `/check`

限制分两层，**两层都做才最稳**。

### 第 1 层（代码层，强制生效）：`ALLOWED_USER_IDS` 白名单

只要这个变量不是空的，就只有名单里的用户能触发命令；其他人即使打了命令，
也只会收到一条「You are not authorised」的私密提示（别人看不到），同时在 Render 日志里留下记录。

**怎么拿某个人的用户 ID：**

1. Discord 客户端 → 左下角齿轮（用户设置）→ **高级（Advanced）** → 打开 **开发者模式（Developer Mode）**
2. 回到服务器成员列表，**右键**目标用户 → **复制用户 ID（Copy User ID）**
3. 得到一串 18~19 位数字，例如 `234567890123456789`

**填到哪里：**

- Render 控制台 → 你的服务 → **Environment** → **Add Environment Variable**
- Key：`ALLOWED_USER_IDS`，Value：用户 ID（多个用英文逗号分隔，**不要加空格和引号**）
- 保存后 Render 会自动重新部署

> 启动日志里会打印一行 `命令使用者 : 234567890123456789`，可以据此确认有没有生效。
> 如果留空，日志会打印一条黄色警告「未设置 ALLOWED_USER_IDS」——说明此时所有人都能用。

### 第 2 层（界面层，让命令对别人不可见）

Discord 本身支持按成员/角色控制命令是否**显示**在命令列表里，这一步在 Discord 客户端里做，不需要改代码：

1. 服务器名称 → 右键 → **服务器设置（Server Settings）**
2. 左侧找 **整合 / Integrations（Integrations）** → 找到你的 bot → 点 **管理（Manage）**
3. 找到 `/check` 命令 → 展开权限设置
4. 先给 **@everyone** 设为 **❌ 拒绝**，再单独添加目标成员（Juliet）设为 **✅ 允许**
5. 保存

这样普通成员在输入 `/` 时**根本看不到**这条命令；而 Juliet 能正常看到并使用。

> ⚠️ 注意：Discord 的命令权限只支持按「成员 / 角色 / 频道」来设，没有「代码里写死某个用户 ID 就自动隐藏」这种接口。
> 所以「看不见」靠第 2 层（界面设置），「用不了」靠第 1 层（代码白名单）——两者互相兜底。

### 关于语言

按需求，**命令名称、参数说明、机器人所有回复** 都是英文。
AI 生成的总结内容语言由 `SUMMARY_LANGUAGE` 控制：

| 值 | 效果 |
|---|---|
| `English`（默认） | 总结正文也用英文 |
| `Chinese` | 总结正文用中文（命令界面仍然是英文） |

---

## 怎么用

在**任意频道**（通常就是 mod room）输入：

```
/check
```

**总结结果会自动通过 Discord 私信（DM）发给你**，不在频道里留下任何消息。
频道里只会显示一条只有你自己看得到的小提示：「✅ Summary sent to your DMs.」

如果你的 DMs 是关闭的（很少见），会自动回退为频道内私密回复，不会丢失内容。

> ⚠️ 必须先在 Discord 设置里允许服务器的 bot 给你发 DM，否则收不到总结。
> 测试方法：随便发一条消息给 bot，如果能送达就说明 DMs 正常。

### 可选参数

| 参数 | 作用 | 示例 |
|---|---|---|
| `hours` | 不看"上次 check"，改为只看最近 N 小时 | `/check hours:24` |
| `limit` | 最多总结多少条消息（默认 3000）。**超限时保留最新的 N 条**，并在开头提示 | `/check limit:500` |
| `raw` | `True` = 不做 AI 总结，只导出原始消息列表；`False`（默认）= 正常调 AI 总结 | `/check raw:True` |
| `channel` | 指定要总结的频道，**只能选已监控的频道**（默认当前频道） | `/check channel:#mod-room` |

> 建议：日常用 `/check`；想只看某个时间段用 `/check hours:12`；
> AI 总结出问题时用 `/check raw:True` 看原始记录。
>
> ⚠️ 关于 `channel`：它只能在**已监控**的频道里挑一个出来总结。想让机器人追踪**新频道**，
> 必须去 Render 的 Environment 里把新频道 ID 加进 `TRACK_CHANNEL_IDS`（多个用英文逗号分隔），
> 并在 Discord 里给机器人开通该频道的 **查看频道 + 读取消息历史** 权限——只给权限是不够的，
> 不在监控列表里的频道，消息根本不会被存进数据库。

### 其余命令一览

| 命令 | 用途 | 典型场景 |
|---|---|---|
| `/status` | 查看机器人运行状态（在线时长、保存消息数、最近错误、AI 配置） | "bot 还活着吗？" |
| `/lookup <user> [hours] [limit]` | 查某成员最近 N 小时的发言，**返回最新的 limit 条**（默认 50） | "昨天 22 点 Alice 到底说了什么" |
| `/search <keyword> [hours] [limit]` | 按关键词搜索消息（内容 + 用户名），**返回最新的 limit 条匹配**（默认 50） | "上次讨论 NSFW 政策是什么时候" |
| `/recent [hours] [limit]` | 查看**最近**的原始消息（不带 AI 总结，默认 6 小时 / 30 条） | AI 抽风时看实时情况 |

> 这三个命令的 `limit` 都是**取最新的 N 条**（不是最早的）。如果命中的消息总数超过 `limit`，
> 结果里会有一行提示告诉你"另有 X 条更早的消息未显示"。

**所有命令的输出都通过 DM 发给你**，频道里不留任何痕迹。命令都受同一份 `ALLOWED_USER_IDS` 白名单控制。

### 关于「上次 check 之后」的边界

每次 `/check` 成功后，会把**执行的那一刻**记入数据库。
下次 `/check` 就从那一刻开始取消息 —— 所以在两次 check 之间发生的所有消息都会被覆盖，不会漏。

---

## 环境变量速查表

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | — | Bot Token |
| `DISCORD_CLIENT_ID` | ⬜ | — | Application ID，仅用于日志 |
| `AI_API_KEY` | ✅ | — | DeepSeek 等 AI 的 Key |
| `AI_BASE_URL` | ⬜ | `https://api.deepseek.com` | 任何 OpenAI 兼容接口；中转站地址要带 `/v1` 结尾 |
| `AI_MODEL` | ⬜ | `deepseek-chat` | 模型名 |
| `AI_MAX_TOKENS` | ⬜ | `4000` | 单次输出上限 |
| `AI_TEMPERATURE` | ⬜ | `0.3` | 越低越稳定 |
| `AI_CHUNK_CHARS` | ⬜ | `24000` | 超长日志的分段阈值 |
| `SUPABASE_URL` | ✅ | — | 项目地址，末尾**不要**带 `/rest/v1/` |
| `SUPABASE_SERVICE_KEY` | ✅ | — | `service_role` 密钥 |
| `TRACK_CHANNEL_IDS` | ✅ | — | 监控频道 ID，逗号分隔 |
| `WATCH_MEMBERS` | ⬜ | 空 | 重点关注成员，逗号分隔，填了会多输出一节 |
| `CHECK_COMMAND_NAME` | ⬜ | `check` | 命令名，改成 `sum` 就是 `/sum` |
| `ALLOWED_USER_IDS` | ⬜ | 空 | 允许使用 `/check` 的用户 ID，逗号分隔。**留空 = 所有人都能用** |
| `SUMMARY_LANGUAGE` | ⬜ | `Chinese` | AI 总结正文语言：`Chinese` / `English`（命令界面固定英文） |
| `TIMEZONE` | ⬜ | `Asia/Shanghai` | 影响日志里显示的时间 |
| `RETENTION_DAYS` | ⬜ | `0` | 消息保留天数，`0`=永久；当前已设 `7`（每 24 小时自动清理一次） |
| `MAX_SUMMARY_MESSAGES` | ⬜ | `3000` | 单次总结读取上限 |
| `PORT` | ⬜ | `3000` | Render 会自动注入，本地才需要改 |

---

## 以后怎么改

### 加一个监控频道

**不用改代码**。到 Render → 你的服务 → **Environment** → 编辑 `TRACK_CHANNEL_IDS`，
用逗号隔开多个频道 ID：

```
1419607085821333634,1234567890123456789
```

保存后 Render 会自动重启服务，机器人重启时会自动把新频道最近的消息补齐。

> 记得把机器人邀请到新频道 / 给它新频道的查看权限，否则补齐会失败（日志里会有提示）。

### 加「重点关注的成员」

到 Render → Environment → 编辑 `WATCH_MEMBERS`：

```
J,Juliet,张三
```

填用户名或服务器昵称都行。填了之后，每次总结会多出一节 **「需要重点关注的成员发言」**，
逐条列出这些人的关键发言。留空就是普通的整体总结（当前默认状态）。

### 改命令名

改 `CHECK_COMMAND_NAME`，比如改成 `q` 就是 `/q`。保存后自动重新注册。

### 减少数据库占用（定期清理）

`RETENTION_DAYS=7` 表示**机器人会自动删除超过 7 天的旧消息和 check 记录**，
释放 Supabase 存储空间（免费版只有 500 MB）。

清理时机：**每次启动时 + 之后每 24 小时一次**（服务长期不重启也会持续清理）。
想保留更久就改大（如 `30`、`90`），设 `0` = 永久保留（不建议，存储会一直涨）。

> 注意：被清理掉的旧消息不再能被 `/lookup` `/search` 查到，`/check` 也只总结保留期内的消息。

### 切换 AI 供应商

任何 **OpenAI 兼容接口**都可以，只需改 3 个环境变量（Render → Environment），代码零改动：

| 供应商 | `AI_BASE_URL` | `AI_MODEL` |
|---|---|---|
| DeepSeek（默认） | `https://api.deepseek.com` | `deepseek-chat` |
| 中转站（当前） | `https://sub2apis.ruobin.dev/v1` | `gpt-5.6`（也支持 `gpt-6`、`gpt-5.6-terra` 等） |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` 等 |

改完把 `AI_API_KEY` 换成对应供应商的 Key，Save 即可。**注意中转站的地址要带 `/v1` 结尾**。

---

## 自检工具（排查问题的第一选择）

项目自带一个自检脚本，会逐项检查**配置 → Supabase 连库/建表/读写 → AI 接口 → Discord 登录与频道权限**，
并明确告诉你哪一步有问题、怎么修。

```bash
cd "/Users/linyao/Desktop/discord bot"
npm run selftest
```

输出示例：

```
✅ 环境变量加载
❌ messages 表是否存在
   表还没建。请打开 Supabase → SQL Editor，粘贴 supabase/schema.sql 的全部内容并 Run。
✅ AI 接口连通
✅ Discord 登录
   已登录为 MyBot#1234（1234567890）
✅ 监控频道 #mod-room
   类型 0 · 所属服务器 My Server
```

> 注意：因为本机连不上 discord.com，**在你电脑上跑这一步时 Discord 那几项一定会失败**，这是正常的。
> 部署到 Render 之后，同样的问题在 Render 的 Shell 里跑就能全部通过。

---

## 出问题了怎么办

### ❌ 机器人不回复 `/check`
1. Discord 开发者后台 → Bot → **MESSAGE CONTENT INTENT** 是否开启？
2. Render 的 Logs 里有没有 `[机器人] 登录成功`？
3. 服务器里能看到这个机器人成员吗？没看到就用第三步的邀请链接重新邀请。
4. 换个频道试试，可能是频道权限问题。

### ❌ `/check` 提示「不在监控列表中」
`TRACK_CHANNEL_IDS` 里没有这个频道。要么加进去，要么用 `/check channel:#频道名`。
如果监控列表只有 1 个频道，机器人会自动用它。

### ❌ 提示 `You are not authorised to use this command`

说明有权限白名单，而当前用户不在名单里。这是**正常行为**。日志里会有 `[权限拦截]` 记录。
如果这是你自己，检查 Render 的 `ALLOWED_USER_IDS` 是否填对了你的用户 ID（纯数字、无空格）。

### ❌ 输入 `/` 时看不到 `/check` 命令

1. 如果给 @everyone 设了拒绝，其他人本来就看不到 —— 这是预期效果。
2. 如果连你也看不到：打开 **服务器设置 → 整合 / Integrations → 你的 bot → 管理**，确认你自己的账号没有被一并拒绝。
3. 命令还没注册成功：确认 Render 日志里有 `[命令注册] /check 已注册到服务器 xxxxx`。
   刚把机器人邀请进服务器时，代码会自动注册；如果没看到，去 Render 点一次 **Restart service**。

### ❌ 收不到 DM 总结
1. 检查 Discord 隐私设置：**用户设置 → 隐私与安全 → 允许来自服务器成员的私信**（要打开）。
2. 测试 DM 是否通：随便打开跟 bot 的私信，发条消息。如果发不出去说明被屏蔽。
3. 如果 DMs 关闭，机器人会自动**回退为频道内私密回复**——内容不会丢，只是不在 DM 里。
4. Render 日志里搜 `[DM 失败]` 可以看到具体原因。

### ❌ 总结里完全没有内容，或者报 AI 错误
1. 先执行 `/check raw:True`，看数据库里到底有没有消息。
   - **有消息** → 是 AI 的问题，看下一步。
   - **没消息** → 是消息没存进去，看下面「消息没有存进数据库」。
2. AI 问题：到 Render → Logs 搜 `[self-check]` / `[自检]`。
   - 出现 `AI 接口异常` → DeepSeek Key 错了 / 余额不足 / 地址写错。
   - 出现 `AI 返回了空内容` → 模型触发了内容安全拦截，见下面「AI 拒答」。

### ❌ AI 拒答（回复「我无法处理此类内容」）
本项目已在提示词里加了审核团队的角色框架，大幅降低拒答率。如果仍然出现：
1. 换更宽松的模型：把 `AI_MODEL` 改成 `deepseek-chat`（默认已是它）。
2. 缩小总结范围：`/check hours:6`，短日志更容易通过。
3. 兜底方案：换用 **OpenRouter**（https://openrouter.ai ），
   把 `AI_BASE_URL` 改成 `https://openrouter.ai/api/v1`，
   `AI_MODEL` 改成 `deepseek/deepseek-chat` 或其他模型，`AI_API_KEY` 换成 OpenRouter 的 Key。
4. 实在不行就用 `/check raw:True` 导出原始记录，自己快速扫一遍。

### ❌ 消息没有存进数据库
1. Render → Logs 搜 `[messageCreate] 保存失败`，看具体报错。
2. 大概率是 Supabase 的 `SUPABASE_SERVICE_KEY` 填错了，或者表没建好（重跑一遍 `schema.sql`）。
3. 常见笔误：`SUPABASE_URL` 末尾带了 `/rest/v1/`（本项目代码会自动去掉，但最好还是别带）。

### ❌ 机器人过一会儿就掉线
保活没配好。用浏览器打开 `https://你的地址.onrender.com/health`，如果第一次打开很慢（10 秒以上），
说明服务在休眠 —— 检查监控任务是否正常在跑、URL 是否写对、有没有被暂停。

### ❌ 部署后 AI 一直报「Connection error」
说明 Render 那台机器连不上 DeepSeek 的接口（极少见，但可能）。
到 Render → 你的服务 → **Shell**，执行 `curl -s -o /dev/null -w "%{http_code}" https://api.deepseek.com`：
- 返回 `401` → 域名通，是 Key 的问题
- 返回 `000` → 域名不通，换一个 AI 供应商：把 `AI_BASE_URL` 改成
  `https://openrouter.ai/api/v1`、`AI_MODEL` 改成 `deepseek/deepseek-chat`、
  `AI_API_KEY` 换成 OpenRouter 的 Key（需外币卡）

### ❌ 想重新生成 Token（Token 泄露了）
Discord 开发者后台 → Bot → **Reset Token** → 复制新 Token →
到 Render → Environment → 更新 `DISCORD_TOKEN` → 保存（会自动重启）。

---

## 本地跑（可选，开发调试用）

需要电脑上装好 Node.js 20+。

```bash
cd "/Users/linyao/Desktop/discord bot"
cp .env.example .env      # 然后编辑 .env，填入真实密钥
npm install
npm start
```

浏览器打开 http://localhost:3000/status 可以看到运行状态。

---

## 文件结构

```
discord bot/
├── src/
│   ├── index.js       # 入口：Discord 事件 + /check 逻辑 + HTTP 服务
│   ├── config.js      # 读取和校验环境变量
│   ├── db.js          # Supabase 读写（消息、check 记录）
│   ├── summarize.js   # 调用 AI 生成总结（含超长日志分段）
│   └── format.js      # 时间格式化、消息转文本、长文本切分
├── supabase/
│   └── schema.sql     # 数据库建表脚本
├── render.yaml        # Render 部署蓝图
├── .env.example       # 环境变量模板
├── .gitignore         # 已排除 .env 和 node_modules
└── README.md          # 本文件
```
