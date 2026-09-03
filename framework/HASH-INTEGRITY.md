# Pharos 哈希完整性机制

## 1. 哈希在流程中的作用

本项目使用 SHA-256 对文件的原始字节计算摘要。摘要不是加密，也不是数学结果；它用于回答一个问题：当前读取的文件，是否仍然是之前登记或冻结的那一份。

完整交接链为：

```text
上传文件
  -> 计算项目源文件 SHA-256
  -> 启动时重新计算并复制到 run/inputs
  -> 为每个 staging 包生成 input_integrity.json
  -> Agent 只能读取权威摘要
  -> Python 执行后框架再次独立计算
  -> manifest 记录交接包文件摘要
  -> Supervisor 复核 manifest 与实际文件
  -> 两次人类审核
  -> 晋级前再次复核
  -> 原子复制到 approved 并冻结
```

## 2. 三类摘要

### 输入文件摘要

上传接口对文件字节计算 SHA-256，并保存到项目文件清单。启动项目时，框架会重新读取项目源文件：

- 源文件已变化：拒绝启动；
- 复制到本次 run 后摘要变化：拒绝启动；
- 两者一致：写入 `run/inputs` 并形成冻结输入基线。

### 输入完整性证据

每个 Agent 包包含框架生成的 `input_integrity.json`。该文件记录每个输入文件的：

- 相对路径；
- 预期 SHA-256；
- 当前实际 SHA-256；
- 是否匹配。

Agent 不能写入、覆盖或决定这个文件。`result_code.py` 中手写的哈希只能算作 Agent 的检查声明，不能取代框架的权威检查。

### 交接包摘要

`manifest.json` 记录四个必需交接文件、额外交付文件以及完整文件树的摘要。Supervisor 和晋级流程会重新读取实际文件并逐个比较。文件内容发生一个字节的变化，摘要就会变化，交接包不能通过。

## 3. 当前 A 题错误的真实原因

当前 A 题阻断包中的输入文件没有损坏。五个输入文件的真实 SHA-256 与运行清单一致。

错误来自 Agent 生成的 `result_code.py`：它把 `result3.xlsx` 的预期摘要抄成了错误字符串。Python 进程返回码仍为 0，但业务输出报告了 `input_hash_check_passed=false`。因此：

- 进程层面：运行成功；
- 证据层面：输入回归失败；
- Supervisor 层面：正确阻断；
- 不是：Excel 被框架自动改写或 SHA-256 算法不稳定。

旧 attempt 必须保留，不能直接改写。修复只能产生新的 attempt。

## 4. 已实施的防护

- 启动时重新计算项目源文件摘要，防止上传后外部修改未被发现；
- 每个包写入框架拥有的 `input_integrity.json`；
- Supervisor 比较实时权威输入检查和包内记录；
- Python 返回码为 0 但 stdout 明确报告哈希/完整性失败时，框架将其标记为失败；
- Python 执行结束后框架再次独立检查输入摘要；
- `manifest.json`、`supervisor_verdict.json`、执行日志和输入完整性文件禁止 Agent 覆盖；
- 阻断状态不能通过暂停/恢复变成人工可审核状态；
- 重试动作互斥，防止连续点击创建多个竞争 attempt；
- 历史 staging、失败日志和 approved 包不删除、不覆盖。

## 5. 人工排查顺序

发生哈希错误时，依次查看：

1. `input_integrity.json`：确认实际摘要与预期摘要；
2. `problem_manifest.json`：确认本次 run 的冻结清单；
3. `inputs/`：确认实际运行输入；
4. `result_code.py`：区分 Agent 写错预期值还是文件确实改变；
5. `execution_log.json`、`stdout.txt`、`stderr.txt`：确认执行版本和业务检查结果；
6. `manifest.json` 与 `supervisor_verdict.json`：确认是否允许进入人工审核。

若 `input_integrity.json` 失败，不能批准，应该保留旧包并重试或终止。只有 Supervisor 通过后，WebUI 才会出现第一审和第二审入口。
