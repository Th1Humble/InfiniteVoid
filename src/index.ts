// import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';

import { type ModelMessage } from 'ai';
import 'dotenv/config';
import { createInterface } from 'node:readline';
import { agentLoop, type BudgetState } from './agent/loop';
// import { createMockModel } from './agent/mock-model';
import { calculatorTool, weatherTool } from './tools/utility-tools';
// const qwen = createOpenAI({
//   baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
//   apiKey: process.env.DASHSCOPE_API_KEY,
// });
const anthropic = createAnthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// const model = createMockModel();
const model = anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6');
const tools = { get_weather: weatherTool, calculator: calculatorTool };
const messages: ModelMessage[] = [];
// 预算由调用方持有，跨轮持续累计——agentLoop 只负责消费它
const budget: BudgetState = { used: 0, limit: 15000 };
const rl = createInterface({ input: process.stdin, output: process.stdout });

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;

function ask() {
  rl.question('\nYou: ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!');
      rl.close();

      return;
    }

    messages.push({ role: 'user', content: trimmed });

    await agentLoop(model, tools, messages, SYSTEM, budget);

    ask();
  });
}

console.log('Super Agent v0.3 — Fuses (type "exit" to quit)\n');
console.log('试试输入："测试死循环"、"测试重试"、"测试预算" 看三层防护效果\n');
ask();
