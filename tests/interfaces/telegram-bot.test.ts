import { RonorTelegramBot } from '../../src/interfaces/telegram/bot';
import type { TelegramConfig } from '../../src/interfaces/telegram/config';

function config(userId: number): TelegramConfig {
  return {
    botToken: '123456:' + 'x'.repeat(35),
    mode: 'polling',
    webhookUrl: null,
    webhookSecret: null,
    apiBaseUrl: 'http://127.0.0.1:3000',
    apiKey: 'test-only',
    allowedUserIds: new Set([userId]),
    approverUserIds: new Set([userId]),
    controlChatId: null,
    approvalTtlMinutes: 5,
    maxMessageChars: 3800,
    pollTimeoutSeconds: 1,
    rateLimitPerMinute: 20,
  };
}

describe('Telegram conversational dispatch', () => {
  test('routes authorised plain text through the governed query handler', async () => {
    const bot = new RonorTelegramBot(config(701));
    const cmdQuery = jest.fn().mockResolvedValue(undefined);
    (bot as unknown as { cmdQuery: typeof cmdQuery }).cmdQuery = cmdQuery;

    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 9,
        date: 0,
        chat: { id: 44, type: 'private' },
        from: { id: 701, is_bot: false, first_name: 'Operator' },
        text: '  explain the current state  ',
      },
    });

    expect(cmdQuery).toHaveBeenCalledWith(44, 9, 701, 'Operator', 'explain the current state');
  });

  test('rejects unauthorised plain text before invoking the runtime', async () => {
    const bot = new RonorTelegramBot(config(702));
    const cmdQuery = jest.fn().mockResolvedValue(undefined);
    const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
    (bot as unknown as { cmdQuery: typeof cmdQuery }).cmdQuery = cmdQuery;
    (bot as unknown as { tg: { sendMessage: typeof sendMessage } }).tg = { sendMessage };

    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 45, type: 'private' },
        from: { id: 999, is_bot: false, first_name: 'Unknown' },
        text: 'hello',
      },
    });

    expect(cmdQuery).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test('ignores non-text updates', async () => {
    const bot = new RonorTelegramBot(config(703));
    const cmdQuery = jest.fn().mockResolvedValue(undefined);
    (bot as unknown as { cmdQuery: typeof cmdQuery }).cmdQuery = cmdQuery;
    await bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 11,
        date: 0,
        chat: { id: 46, type: 'private' },
        from: { id: 703, is_bot: false, first_name: 'Operator' },
      },
    });
    expect(cmdQuery).not.toHaveBeenCalled();
  });
});
