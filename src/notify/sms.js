// SMS adapter stub. A sender is (phone, text) => Promise. No SMS provider is contracted yet (e.g. Eskiz, Playmobile),
// so there is none and only Telegram messages go out. Return a sender here to switch SMS on; the notifier already calls it.
export const smsSender = () => null;
