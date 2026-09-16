# pi-fish

把本地 `.txt` 的当前页显示在 **最新消息下方** 一块 Thought 样式区域里。无背景，不写进 session，不注册 LLM tool，不劫持真实 Thought。

## 用法

```
/read
```

也可以 `/read D:\\books\\foo.txt` 或 `~/novel.txt`。

方向键 / 鼠标选，回车改：

- **Enabled** — 开/关
- **Thought row** — 是否显示消息下那块伪装 Thought；关了只在按住时出现
- **Path** — 地址栏，输入文件夹或 `.txt`；File 跟着变
- **File** — 浏览 Path 所在目录，选文件后 Path 更新
- **Hold key** — 再按一键，按住它显示正文，松开隐藏
- **Lines per page** — 回车循环 4/8/12/16/20/24

`/read 12566` 跳到文件第 12566 行。翻页：按住展开时滚轮。
