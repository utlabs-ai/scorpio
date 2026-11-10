内部
zh: 接口文档「意外登出」一节写明：只有最新 token 已过期的电脑才走重新登录流程；token 还有效（比如 token 文件丢了）、被撤销或服务端不认识的电脑拿普通 code，谁也不通知，要在那台电脑上跑 `scorpio login`。
en: The API docs on unexpected logouts now say that only a computer whose newest token has expired gets the relogin flow; one whose token is still valid (for example, its token file was lost), was revoked, or is unknown to the server gets an ordinary code, nobody is notified, and the person runs `scorpio login` on that computer.
