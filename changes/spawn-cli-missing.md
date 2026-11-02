修复
zh: /spawn 时 agent CLI 没起来（比如 CLI 正在升级，shell 报 command not found），daemon 现在照实说「did not start」并附上屏幕，不再说已启动，也不再把 shell 屏幕当成审批菜单反复开卡；再 /spawn 同名会说上次没起来、pane 还开着。
en: When a /spawn's agent CLI does not come up (for example while the CLI is updating and the shell says command not found), the daemon now says it did not start and shows the screen, instead of saying it started and opening approval cards for the shell screen again and again; a second /spawn of the name says it did not start last time and its pane is still open.
