// code-server (self-hosted VS Code in the browser) keeps its User settings
// and chatLanguageModels.json under its User data directory
// (~/.local/share/code-server/User by default, or $CODE_SERVER_USER_DATA_DIR/User).
//
// This descriptor registers code-server on magpie's Agents page. When connected,
// magpie writes the gateway address, token, and picked model into the local
// bridge file (~/.config/magpie-code-server/connection.json). The plugin's
// adapter running in the host will synchronize the model group into
// code-server's chatLanguageModels.json and set chat.defaultModel.

// Official code-server dark/light adaptive vector icon
export const CODE_SERVER_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNDcgMTQ3Ij48c3R5bGU+cGF0aHtmaWxsOiMwOTBCMEJ9QG1lZGlhKHByZWZlcnMtY29sb3Itc2NoZW1lOmRhcmspe3BhdGh7ZmlsbDojRkZGRkZGfX08L3N0eWxlPjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xpcC1ydWxlPSJldmVub2RkIiBkPSJtNDIuNDIxNCwzOS42NTVjLTI0LjQwNTcsMCAtNDIuMTU1NCwxMy4xNzIxIC00Mi4xNTU0LDMzLjg0NWMwLDIwLjU4MTQgMTguNDg5MiwzMy44NDUgNDIuMTU1NCwzMy44NDVjMjMuNjY2MiwwIDM4LjE4MDMsLTExLjYxNzEgMzguNzM0OSwtMjguNzIyNWwtMjEuMDc3NywtMC40NTc0Yy0wLjkyNDQsOS4zMzAzIC05LjEwNTksMTUuMTg0NSAtMTcuNjU3MiwxNS4xODQ1Yy0xMS43NDA2LDAgLTIwLjQzMDYsLTcuNTkyMiAtMjAuNDMwNiwtMTkuODQ5NmMwLC0xMi4yNTc0IDguNjksLTE5Ljk4NjggMjAuNDMwNiwtMjAuMjE1NWM4LjU1MTMsLTAuMTgzIDE2LjkxNzcsNS45NDU3IDE3LjQ3MjMsMTUuMjc2bDIxLjA3NzcsLTAuNjQwM2MtMC40NjIyLC0xNi44MzExIC0xNC4xNDQyLC0yOC4yNjUyIC0zOC41NSwtMjguMjY1MnptNDguODQ0NiwybDU1LjQ2OCwwbDAsNjQuMDMxMWwtNTUuNDY4LDBsMCwtNjQuMDMxMXoiLz48L3N2Zz4="

export const agent = {
  id: "code-server",
  name: "code-server",
  icon: CODE_SERVER_ICON,
  bin: "code-server",
  dir: "~/.local/share/code-server",
  config: "~/.config/magpie-code-server/connection.json",
  format: "json",
  model: "model",
  ua: ["code-server"],
  notice: "magpie's models are in code-server's Chat model picker, under magpie, in each of its profiles. If they don't show, run Developer: Reload Window in code-server.",
}

export function connect({ gateway, model, models }) {
  return {
    enabled: true,
    "gateway.url": gateway.url,
    "gateway.v1": gateway.v1,
    "gateway.key": gateway.key,
    models,
  }
}
