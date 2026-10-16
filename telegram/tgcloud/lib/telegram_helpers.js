import { api } from 'sdk';

/**
 * Safely send a message, ensuring text never exceeds Telegram's 4096 character limit.
 */
export async function safeSendMessage(params) {
  const safeParams = { ...params };
  if (typeof safeParams.text === 'string' && safeParams.text.length > 4000) {
    safeParams.text = safeParams.text.slice(0, 3950) + '\n\n<i>[Text truncated to fit Telegram limit]</i>';
  }
  return await api.sendMessage(safeParams);
}

/**
 * Safely edit a message, ensuring text never exceeds Telegram's 4096 character limit.
 */
export async function safeEditMessageText(params) {
  const safeParams = { ...params };
  if (typeof safeParams.text === 'string' && safeParams.text.length > 4000) {
    safeParams.text = safeParams.text.slice(0, 3950) + '\n\n<i>[Text truncated to fit Telegram limit]</i>';
  }
  return await api.editMessageText(safeParams);
}
