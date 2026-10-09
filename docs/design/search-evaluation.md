# 中文校园检索离线评估（合成开发集）

## 范围与诚实边界

这是独立开发工具，不接入搜索 runtime，不建立索引，不读取环境变量或凭据，
不调用模型、网络或生产数据库。现有权限证明、帖子/评论/回复的可见性与导航语义
仍以 [COMMUNITY_SEARCH.md](../COMMUNITY_SEARCH.md) 为准。

`packages/fixtures/search-eval-campus-zh-v1.json` 包含 **36 条完全合成内容、12 个查询**：
12 个帖子、12 个根评论、12 个回复。每个查询对全部 36 条内容有显式 0–3 标注，
包含一个无相关结果的查询。地点、课程和对话都是虚构的；没有真实账号、学校目录、
联系方式或私有生产文本。这个小集适合检查集成错误和定向退化，**不能据此宣称真实用户
效果、生产效果或模型优劣**。没有提交任何模型实测结果或虚构模型排行榜。

先使用用户选定的 Qwen3-Embedding-8B + Qwen3-Reranker-8B 开发；后续可将
Voyage 4 large / Cohere 4 pro 的输出转换为同一导入格式。实际模型 ID、revision、
支持的维度和请求参数必须由运行方核验、记录，本工具不验证供应商产品能力。
模板中的 4096 只是可编辑的配置初值，不是本工具测得的模型规格。

## 运行

仅需仓库要求的 Node 24，无额外依赖，无 API 请求：

```sh
node --test scripts/search-eval.test.mjs
node scripts/search-eval.mjs validate packages/fixtures/search-eval-campus-zh-v1.json
node scripts/search-eval.mjs template packages/fixtures/search-eval-campus-zh-v1.json > /tmp/search-run.json
# 在本地编辑 /tmp/search-run.json：填写准确 profile，并导入已有的模型检索输出。
node scripts/search-eval.mjs evaluate packages/fixtures/search-eval-campus-zh-v1.json /tmp/search-run.json > /tmp/search-report.json
# 多个 profile 只生成独立报告，不合并评分。
node scripts/search-eval.mjs evaluate packages/fixtures/search-eval-campus-zh-v1.json /tmp/qwen-run.json /tmp/other-run.json
```

模板只有空 hits，不生成任何模型结果。保留 `REPLACE_` 占位符会被拒绝评估。
根 `npm run check` 在 `stats:test` 之后运行 `search:eval:test`；也可单独执行
`npm run search:eval:test`。
CLI 默认 k 为 1、5、10；模块导出 `evaluate(dataset, run, [1, 3, 10])` 支持自定义
互不重复的正安全整数 cutoff。输入出错会返回非零退出码，不输出部分评估结果。

## 数据与标注

- `documents[].id` 是命中本体的唯一标识，而非统一折叠为父帖 ID。
- `kind` 为 `post|comment|reply`。帖子 `postId=id, rootCommentId=null`；
  根评论 `rootCommentId=id`；回复必须指向同一父帖的根评论。
- `text` 是该条内容本身。默认只对这一字段建模，不拼入同线程子内容或标注。
  如研究父级上下文拼接，应另建 profile、记录规则；不得把 qrels/rationale 输入模型。
- 每个查询的 `judgments` 覆盖整个语料，没有隐式的“未标注就是不相关”。
  修改文本、顺序、标签或标注会改变 SHA-256；所有比较必须使用同一摘要。
- 3 表示直接满足需求；2 表示实质相关但不完整；1 表示同一问题的弱帮助内容；
  0 表示不满足查询。每个查询 `rationale` 解释关键取舍。任何正分都计入二元 Recall/MRR。
- 命中按内容计数：同一线程中两条均有价值的内容可分别相关；父帖相关不使子内容自动相关。
  q03 仅回复相关，q07 仅根评论相关，用来捕捉只查帖子或错误抬升祖先的实现。
- 标签覆盖中文同义词、口语、否定/排除、缩写、精确课号/地点、混合语言、同词异义。
  难负例包括已售/在售、出租/出售、电动车/普通单车、新车/二手、
  CS101/CS110、J2-204/J2-240、东图/西图、素但辣、机场/高铁站、苹果水果/电脑。

这些是单轮人工合成标注，尚未做双人独立判定、分歧仲裁或真实流量代表性验证。
应把已反复调参的本集视为 development set，不能作为隐藏 test set。
以后扩充数据应保持独立测试集，检查学校、主题、问法和线程泄漏。

## 导入协议与 profile 隔离

运行文件的顶层严格包含：

- `schemaVersion: 1`
- `datasetId` 与完整 `datasetSha256`，由模板生成
- 一个且仅一个 `profile`
- `results`，每个查询恰好一行 `{queryId, hits}`；无结果必须显式 `hits: []`

每条 hit 恰好包含 `documentId` 和数值 `score`。分数必须是有限数，可以是负数；
**越大越好**。若来源是距离或 rank，应由导入方先一致转换方向。按分数降序、
相同分数按 documentId 二进制字符串升序排序；不会信任输入数组顺序。
这是固定 tie-break，而非对同分结果做期望值 nDCG。
重复 ID、未知 ID、重复/缺失查询、字符串分数、NaN/Infinity、额外字段均拒绝。

profile 必须记录 id、embeddingModel、embeddingRevision、dimensions、queryInstruction、
documentInstruction、normalization、distance、rerankerModel、rerankerRevision、pipelineRevision。
无 reranker 时两个 reranker 字段都为 null。有 reranker 时必须同时指定模型和 revision。
`pipelineRevision` 应指向完整可复现配置，包含模型输入预处理、chunk/聚合策略、候选 top-N、
截断长度、embedding-only/reranked 阶段、模型运行精度及参数；不同配置必须不同 revision。
不要在这些字段中写密钥或私人路径。必须填实际执行的 instruction，而非留空掩盖默认值。

同一运行不能包含多个向量空间或 per-query/per-hit profile 覆盖。不同维度、模型、
instruction、normalization 或 reranker 的运行必须使用不同 profile ID；批量导入中
同一 ID 对应不同配置会报错。报告保留完整 profile 与其摘要，仅逐运行计算指标；
不拼接向量、不比较原始分数，也不跨 profile 汇总平均值。
**此工具只验证导入声明，不能从排名反推其向量维度或证明模型真的执行过。**

公平比较时固定语料摘要、查询、qrels、k、候选范围、输入文本、召回数量与 rerank 数量，
分别导出 embedding-only 与 reranked 阶段，不要把只重排小候选集的成绩冒充全库召回。
建议保留每个模型的独立日志/版本证据；本工具不自动运行、不上传日志。

## 指标定义及数学边界

对查询 q，相关集合 R 是 grade > 0 的所有语料 ID；排名为去重且验证过的导入 hits。

- Recall@k = 前 k 个结果中相关内容数 / |R|。
- Reciprocal rank = 第一个 grade > 0 结果排名的倒数；没有则为 0。
  报告 `mrr` 是所有可评估查询的平均 reciprocal rank。
- DCG@k = Σ (2^grade − 1) / log2(rank + 1)，rank 从 1 开始。
- IDCG@k 用**全语料标注**按 grade 降序的理想排名计算，不能只用已召回内容。
- nDCG@k = DCG@k / IDCG@k；仅浮点舍入可能高于 1 时截为 1。
- 所有正相关查询等权宏平均，不按 hits 数或相关项数加权。
- k 超过返回数量时缺失位置贡献 0；Recall 分母仍是完整 |R|。
- 无相关集合时 Recall、reciprocal rank 与 nDCG 为 null，并从宏平均排除；
  同时报告 `emptyRelevantQueryCount` 和该查询 `returnedCount`，保留假阳性排查信号。
  全部查询无相关集合时 macro 为 null，而非 NaN、0 或 1。
- MRR 使用整个导入列表，不是 MRR@10。如果导入仅 top-N，未出现的相关项可能在 N 之后；
  MRR 是截断观察下的值，不能宣称完整全库 MRR。比较时固定 N。
- 不计算置信区间、统计显著性、延迟、成本或空集拒答准确率；本工具缺少这些证据。

测试包含手算的 graded nDCG、理想/零命中/负分/同分、空相关集、宏平均、超长 k、
非法 k、重复 ID、缺失查询、非法分数、跨线程祖先、摘要漂移和 profile/维度混用。
它们证明的是评估器规则，不是模型质量，也不能替代 runtime 的授权安全测试。
