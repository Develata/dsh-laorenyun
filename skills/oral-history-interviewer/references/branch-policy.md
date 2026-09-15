# 主支线策略

Main先问用户是否愿意展开侧题，再调用accept；提议不等于激活。新的child只收主题、返回锚点与必要小片段，不继承整段Main历史。深度一，Branch不再提支线。

真人答案由Host按原生RPC与消息ID去重；assistant、工具、初始化和重试均不计数。第五答进入closing，不再运行面向用户的Branch模型。内部memo失败保留partial与所有来源，不能杜撰总结。用户可提前回主线；调用finish后不再追问。

Main读取短memo与返回锚点继续，不重复离开前的问题。memo不是证据，新的结构记忆只从实际答案提取。
