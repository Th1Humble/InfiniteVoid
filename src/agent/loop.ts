import { streamText, type ModelMessage } from 'ai';
import { detect, recordCall, recordResult, resetHistory } from './loop-detection.js';
import { calculateDelay, isRetryable, sleep } from './retry.js';

const MAX_STEPS = 15;
const MAX_RETRIES = 3;

// 预算对象由 index.ts 创建，并跨多轮用户输入持续累计。
// agentLoop 每完成一步模型调用，只把本步 token 用量累加进去。
export interface BudgetState {
  used: number;
  limit: number;
}

export async function agentLoop(
  model: any,
  tools: any,
  messages: ModelMessage[],
  system: string,
  budget: BudgetState,
) {
  let step = 0;

  // 循环检测只关注当前这次用户输入触发的 agent 执行链。
  // 下一次用户输入会重新开始一条链，所以这里清空检测历史。
  resetHistory();

  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    let hasToolCall = false;
    let fullText = '';
    let shouldBreak = false;
    let lastToolCall: { name: string; input: unknown } | null = null;
    let stepResponse: any;
    let stepUsage: any;

    // 关闭 AI SDK 内置 retry，统一用这里的 retry 包住整步调用。
    // 这样日志、退避时间和后续熔断策略都集中在一个地方。
    for (let attempt = 1; ; attempt++) {
      try {
        const result = streamText({
          model,
          system,
          tools,
          messages,
          maxRetries: 0,
          providerOptions: { openai: { parallelToolCalls: true } },
          onError: () => {},
        });

        // fullStream 会按顺序吐出文本、工具调用、工具结果和结束事件。
        // 文本直接流式打印；工具事件用于更新循环检测状态。
        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            case 'tool-call': {
              hasToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              console.log(`  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`);

              // 检测重复调用、无进展调用和 A/B/A/B 乒乓式循环。
              // warning 会提醒模型换思路，critical 会停止当前 agent 链。
              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(`  ${detection.message}`);
                if (detection.level === 'critical') {
                  shouldBreak = true;
                } else {
                  messages.push({
                    role: 'user' as const,
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }
              recordCall(part.toolName, part.input);
              break;
            }

            case 'tool-result':
              console.log(`  [结果: ${JSON.stringify(part.output)}]`);
              // 记录结果 hash，用来判断“同样的调用是否一直得到同样结果”。
              // 如果调用和结果都反复一致，继续推进通常没有意义。
              if (lastToolCall) {
                recordResult(lastToolCall.name, lastToolCall.input, part.output);
              }
              break;
          }
        }

        stepResponse = await result.response;
        stepUsage = await result.usage;
        break;
      } catch (error) {
        // 只重试临时性问题，比如 429、5xx、网络断开。
        // 非临时错误直接抛出，避免把真实 bug 伪装成重试。
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        const delay = calculateDelay(attempt);
        console.log(`  [重试] 第 ${attempt}/${MAX_RETRIES} 次失败，${delay}ms 后重试...`);
        await sleep(delay);
        hasToolCall = false;
        fullText = '';
        shouldBreak = false;
        lastToolCall = null;
      }
    }

    // critical 熔断触发后，不把本步 response 追加到历史。
    // 这可以避免后续继续基于一段已判定异常的工具调用链推理。
    if (shouldBreak) {
      console.log('\n[循环检测触发，Agent 已停止]');
      break;
    }

    // AI SDK 会把本步 assistant/tool 消息整理成下一轮可用的历史。
    // 追加之后，模型下一步才能看到刚才的工具调用和工具结果。
    messages.push(...stepResponse.messages);

    // Token 预算追踪：budget 由调用方持有，跨轮累计
    const inp =
      typeof stepUsage?.inputTokens === 'number'
        ? stepUsage.inputTokens
        : (stepUsage?.inputTokens?.total ?? 0);
    const out =
      typeof stepUsage?.outputTokens === 'number'
        ? stepUsage.outputTokens
        : (stepUsage?.outputTokens?.total ?? 0);
    budget.used += inp + out;
    const pct = Math.round((budget.used / budget.limit) * 100);
    console.log(`  [Token] ${budget.used}/${budget.limit} (${pct}%)`);
    if (budget.used > budget.limit) {
      console.log('\n[Token 预算耗尽，强制停止]');
      break;
    }

    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    // 如果这一轮调用了工具，就再跑一步，让模型读到工具结果后生成最终回答。
    console.log('  \u2192 继续下一步...');
  }

  if (step >= MAX_STEPS) {
    console.log('\n[达到最大步数限制，强制停止]');
  }
}
