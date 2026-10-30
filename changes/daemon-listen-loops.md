内部
zh: daemon 不再在两种情况下反复读主题：没开保活时，没有新消息的 agent 不再每轮（5 秒）读一次；agent 的窗格被对话框挡住时，等窗格能接收了再读，不再每 10 秒读一次。投递时机不变。
en: The daemon no longer reads a topic over and over in two cases: with keep-alives off, an agent with nothing new is no longer read every 5-second round; while an agent's pane is blocked by a dialog, the topic is read again only once the pane can take text, not every 10 seconds. Delivery timing is unchanged.
