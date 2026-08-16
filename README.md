# Discord Roblox Bind Bot

## Render

GitHub 里不要放真实 Token。

Render -> Environment Variables 只需要：

- `TOKEN` = Discord Bot Token

可选：

- `PORT` = Render 提供的端口（程序会自动使用 Render 的 PORT）

## Discord

Bot 启动后会自动创建/复用名为 `roblox-bind` 的文字频道。

指令：

- `/bind Roblox用户名`
- `/unbind`

`/bind` 会通过 Roblox API 查询用户名对应的 UserId。

一个 Discord 账号只能绑定一个 Roblox 账号；同一个 Roblox UserId 也不能绑定多个 Discord 账号。

`roblox-bind` 频道中，普通消息会自动删除，只允许 Bot 的指令交互。

## Roblox

把 `roblox/BindingCheck.server.lua` 放到 `ServerScriptService`。

然后把：

`https://YOUR-RENDER-SERVICE.onrender.com`

改成你的 Render Web Service 地址。

Roblox Studio -> Game Settings -> Security -> Allow HTTP Requests：开启。

## 注意

Discord Token 只放 Render 的 `TOKEN` 环境变量，不要提交到 GitHub。
