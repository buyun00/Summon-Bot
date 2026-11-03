import { startBot, loadBotConfig, sendMessage, waitForTask } from '@summon/bot';

const bot = await startBot(loadBotConfig(process.argv[2]));
try {
  const contact = { botId: bot.config.botId, url: bot.url, token: bot.config.token };
  const receipt = await sendMessage(contact, { id: 'example-first-message', content: 'Introduce your configured capabilities.' });
  const task = await waitForTask(contact, receipt.taskId);
  console.log(JSON.stringify({ status: task.status, result: task.result, error: task.error }, null, 2));
} finally { await bot.close(); }
