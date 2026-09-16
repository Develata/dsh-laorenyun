# v0.1.0 插件发布加固

Owner：实现/离线验证；最终版本、镜像、浏览器、CI与课程交付结论由[应用release](https://github.com/Develata/laorenyun/blob/main/docs/release-v0.1.0.md)拥有。Phase3/4历史PASS保留；Phase2 R2/R3硬件仍独立pending。

## 审查与修正

- JSON业务请求改用已支持streaming route，最多80,000 bytes/10秒，然后限制20,000字符；不在检查之前完整缓冲未知大小正文。音频仍32MiB/60秒。
- 录音MIME优先MediaRecorder实际值，其次真实chunk类型；未知标application/octet-stream并明确拒绝上传，不伪造WebM出处。
- 大档案GENERATION_LIMIT显示容量原因，不建议无效重试；上一个已发布版本继续可用。
- 修正文档/日志schema5，补充UI云模型处理文字提示。无新运行依赖，无DSH修改。

## 可重复合成演示/规模检查

显式独立CLI `lib/demo.js <empty-root> --confirm-synthetic-demo [--scale]`，必须LAORENYUN_DEMO=true，任何已有DB均拒绝。不注册Host路由，不自动启动，不合并真实卷。输入内容确定，ID/创建时间每次新建；不是逐字节相同的数据库。

通过正常acceptHuman/proposal/validation/revision/branch/derived服务生成8节点、开放冲突、resolved纠正、self/family、漂流、关系、BranchMemo、带fixture标记的静音WAV、Persona/自传/三文件。模型明确为explicit-demo-fixture，不冒充真实LLM。领域seed不伪造原生DSH聊天历史；实时采访另建真实session。

`--scale`使用500当前节点、1051修订/来源；修订分散，保持单节点出处100条上限。记录river/分页/深读/search/scheduler/Persona清单/超限自传以及先前有效导出耗时。大档案超过200当前节点/1000修订明确拒绝；小型已发布快照仍可导出，不声称导出了整个大档案。

## 安全与验证边界

内部模型任务tools=[]；恶意指令样本作为证言保存，Persona可unknown，自传逐句校验，HTML转义。全量回归含WHAT/HOW、开放冲突、五答、CAS、speech。新增AAC/MP4、Ogg/Opus、MP3归一化；实际Safari硬件仍未验证。

CI：一个固定Action SHA工作流，Node24.21.0/pnpm11.7.0、frozen install、check、format；不需要云凭据。最终次数和远端结果见发行owner。
