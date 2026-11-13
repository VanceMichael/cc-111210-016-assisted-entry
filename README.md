# 需要人工验证的浏览器采集接管

本项目用于授权资料接入的单次查看与接收留存，使用 Node.js 22。来源协议见 `docs/source-contract.md`。本地演练服务只绑定回环地址，数据不含真实个人资料或账号。

## 安装与运行

依赖由 `package-lock.json` 固定。首次准备环境运行 `npm ci --ignore-scripts`，浏览器项目使用 Playwright 1.56.1 对应的 Chromium；浏览器及系统库在镜像准备阶段安装，不在业务命令中下载。

```sh
npm run build
npm test
npm run demo
npm start
```

`npm run demo` 启动本地来源和接入服务，实际获取单次查看结果并写入临时接收记录，显示完整 JSON，随后关闭服务并清理临时目录。通常在十秒内结束。`npm start` 启动常驻服务，默认端口3000，可通过 PORT 与 DATA_DIR 修改监听端口和接收目录。设置 SOURCE_URL 可连接另一进程中已启动的本地来源；不设置时自动创建演练来源。恢复演练可先用 `npm run source` 在另一终端启动来源，记下输出地址，保持该进程运行，仅重启设置了 SOURCE_URL 的接入服务。

`npm run rehearsal` 演练人工接管全流程：发起采集后遇到人工确认页会暂停并打印一次性接管入口，经办人在浏览器中打开该入口，于本地操作台手动完成确认，采集随即从停止点继续并输出台账与回执。接管期限由 TAKEOVER_TTL_MS 控制（默认十分钟），HEADFUL=1 可改用有头浏览器。

## 接口与模块

`GET /health` 查看状态，`GET /inspect` 查看来源，`GET /receive?key=sample` 保存单次接收，`GET /receipts/sample` 读取回执。相同key和相同内容可重复接收，不同内容拒绝覆盖。

人工接管接口（协议详见 `docs/takeover.md`）：

- `POST /sessions` 启动采集会话；遇到确认页返回 `paused` 与一次性 `takeover.claimPath`。
- `GET /sessions/:id` 查看会话状态，`POST /sessions/:id/cancel` 取消（须持工作者令牌）。
- `GET /takeovers/:id/claim?token=...` 一次性领取接管并进入操作台；`GET /takeovers/:id` 查看工单状态。
- 操作台：`GET /takeovers/:id/view` 页面视图，`POST /takeovers/:id/input` 转发人工输入，`POST /takeovers/:id/complete` 完成确认并触发恢复核对，`POST /takeovers/:id/abort` 放弃。
- `GET /ledger?session=<id>` 查看台账，actor 字段区分 robot/human/system。

`src/connector.mjs` 解释单次来源响应，`fixtures/source.mjs` 提供可重复启动的本地来源，`src/service.mjs` 组织访问入口，`src/store.mjs` 保存查看结果。`src/collector.mjs` 负责暂停快照与恢复核对，`src/sessions.mjs` 维护会话互斥，`src/takeover.mjs` 管理一次性、有期限、可持久化的接管工单，`src/ledger.mjs` 记录不涉敏的台账，`src/operator-page.mjs` 提供人工操作台页面。`test/connector.test.mjs` 验证协议原语和演练源，`test/service.test.mjs` 验证服务与留存边界，`test/takeover.test.mjs` 验证暂停、过期、互斥与上下文保护（不自动完成确认内容）。

生产接入地址与凭据需由部署配置给出；演练客户端拒绝访问回环以外的地址。文档中的接口不向外提供任意目标代理。异常以明确错误响应返回，接收失败不覆盖原回执。
