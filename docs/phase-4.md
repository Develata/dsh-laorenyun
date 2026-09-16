# Phase 4：长河、纠正与派生阅读版本

Owner：插件实现和确定性测试。发行、实网、浏览器和最终结论由[应用 Phase 4](https://github.com/Develata/laorenyun/blob/main/docs/phase-4.md)拥有。实现与容器验收已完成；具体门禁结论以应用报告为准，Phase2真人硬件仍独立pending。

Phase 2 R2 实体麦克风、R3 真人采访恢复仍 pending。

## 实现

- schema5：correction_intents、derived_generations、derived_active。原图、来源、修订均沿用；仅原有worker导入SQLite。迁移递归覆盖2/3/4，未来版本拒绝。
- 长河有界快照500条，年代聚合/筛选与分页；细节才读取最多10段来源。固定SVG路径由浏览器原生getTotalLength/getPointAtLength计弧长；无需通用曲线库。同月只改视觉法线偏移，不改时间；范围画带，未知独立漂流区。
- 纠正先预览完整新说法，原子建立Source与所选node/revision绑定，进入原生composer。显式发送后仍由正常抽取器产提案、逐字证据/时间/CAS校验；只允许一个目标。追加同ID修订及带新来源的resolved correction Conflict，旧版本保留。未发送/取消不改图。并发旧节点拒绝，不猜测合并。
- Persona/Biography/Export共用一个持久任务生命周期，最多一个任务；内部模型复用与记忆相同实例，合计最多两个内部调用。显式触发，无自动重建。总截止5分钟，模型每步60秒/一次格式修复；export120秒。中断标failed、保留候选及上个发布版本，用户重试创建新不可变generation。
- Persona只读最近最多80段已提交本人证言，每段模型输入最多1200字；五类语言观察有精确引文，未知显式标记。DB快照是唯一权威，不另维护一套磁盘Persona源。画像不进入权限或采访system prompt。
- Biography固定图manifest：最多200当前节点/1000历史修订，超过明确拒绝。Planner必须覆盖所有合格节点恰好一次，最多20章/每章20节点；开放Conflict双方省略并明确告知。Renderer为受限原话编排：完整keySentence逐字不变，只有经Persona引文支持的两种转场可选。家人代述、推测/漂流标记由软件添加。此限制保守，未声称自由文学改写或通用语义校验。无Persona仍生成；WHAT/HOW可以逐字验证。
- 三文件以已发布自传固定manifest生成；UTF-8 Markdown、静态转义HTML（内嵌CSS、CSP禁止网络）、version1 JSON。文件写private staging，fsync/读回hash后rename发布；DB最后切换active。断电遗留staging/未引用目录不自动删除，旧产物保留。没有导入、ZIP、照片或完整备份承诺；media included=false。

## 测试入口

`pnpm check`、`pnpm format:check`、`git diff --check`。`tests/derived.test.ts`覆盖弧长、区间/同月/漂流、纠正取消/新修订、人物语料/引文/禁区、固定manifest、WHAT/HOW、family来源、开放冲突省略、HTML注入/离线链接、发布hash/恢复及共享任务。

实际执行数量、浏览器尺寸及实网耗时在应用报告记录。原Phase1–3测试全部继续运行。

## 容器审查修正与已执行结果

`pnpm check`实际通过42项测试（原有33项 + Phase4 9项）、Host/Client typecheck及build；format/check通过。新增501条规模与open Conflict双方提示测试。

真实模型/浏览器反馈后收紧：不把没有年份写成“我记不清”；样本不足类别转unknown；标题限制为中性集合/来源短语，章节日期由代码排序；2倍布局按可用宽度折行；旧自传出处保持固定revision；旧good生成即使不在最近记录也保留可查询入口。最终实网耗时与浏览器结果仍由应用报告拥有。

资源审查：river在SQL直接投影摘要，不先把500个完整证据正文装入worker内存。生成在读取前检查修订JSON总量≤150万字符，最多500来源、每原件≤100衍生媒体/总≤1000媒体元数据；最终manifest仍≤150万字符。Persona输入manifest不再夹带无关图节点/家人图数据/BranchMemo，仅保留本人文字及其来源。这些限制是显式失败边界，不是静默删减。
