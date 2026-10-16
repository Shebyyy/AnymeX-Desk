import { api } from 'sdk';

export async function safeSendMessage(params) {
  try {
    return await api.sendMessage(params);
  } catch (err) {
    console.error('sendMessage failed:', err.message || err);
    if (params.parse_mode) {
      try {
        return await api.sendMessage({ ...params, parse_mode: undefined });
      } catch (fallbackErr) {
        console.error('Plain sendMessage failed:', fallbackErr);
      }
    }
    return null;
  }
}

export async function safeSendPhoto(params) {
  try {
    return await api.sendPhoto(params);
  } catch (err) {
    console.error('sendPhoto failed, falling back to sendMessage:', err.message || err);
    if (params.caption) {
      return await safeSendMessage({
        chat_id: params.chat_id,
        text: params.caption,
        parse_mode: params.parse_mode,
        reply_markup: params.reply_markup,
      });
    }
    return null;
  }
}

export async function safeEditMessageText(params) {
  try {
    return await api.editMessageText(params);
  } catch (err) {
    if (err.description && err.description.includes('message is not modified')) {
      return null;
    }
    console.error('editMessageText failed:', err.message || err);
    return null;
  }
}
