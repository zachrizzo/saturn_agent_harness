export function cleanTelegramBotUsername(value: string): string {
  const trimmed = value.trim().replace(/^@/, "");
  if (/^https?:\/\/t\.me\//i.test(trimmed)) {
    return trimmed.replace(/^https?:\/\/t\.me\//i, "").split(/[/?#]/)[0] ?? "";
  }
  if (/^tg:\/\/resolve\?/i.test(trimmed)) {
    try {
      return new URL(trimmed).searchParams.get("domain") ?? "";
    } catch {
      return "";
    }
  }
  return trimmed.split(/[/?#]/)[0] ?? "";
}

export function telegramBotUsernameIssue(username: string): string | null {
  if (!username) return "Paste the username from BotFather.";
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
    return "Telegram bot usernames are 5-32 characters and use only letters, numbers, and underscores.";
  }
  if (!/bot$/i.test(username)) {
    return "BotFather-created bot usernames must end in bot, for example saturn_personal_computer_bot.";
  }
  return null;
}

export function telegramWebBotLink(username: string, startParameter: string): string {
  return `https://t.me/${username}?start=${encodeURIComponent(startParameter)}`;
}

export function telegramAppBotLink(username: string, startParameter: string): string {
  const params = new URLSearchParams({ domain: username, start: startParameter });
  return `tg://resolve?${params.toString()}`;
}
