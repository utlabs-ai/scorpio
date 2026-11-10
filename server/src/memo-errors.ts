// New memo errors and their English next sentences, in one replaceable table.
type Values = Record<string, string | number>;
export const MEMO_NEXT = {
  source_required: { en: "from= is the memo's source: a message (#123) or a task (T45).", zh: "from= 是 memo 的出处：消息（#123）或任务（T45）。" },
  source_not_found: { en: "No {source} in this topic. Pick the message or task the memo comes from.", zh: "主题里没有{source}。请选择 memo 所依据的消息或任务。" },
  memo_too_long: { en: "The memo is {count} characters; the limit is 500. Shorten it, or write the rest as a second memo.", zh: "memo 有 {count} 字，上限 500 字；请缩短或把余下的内容写成第二条。" },
  long_too_long: { en: "{slot} is {count} characters; the limit is 3,500.", zh: "{slot} 有 {count} 字，上限 3,500 字。" },
  memo_not_found: { en: "No memo {id} in this topic. List them: scorpio memo topicId={topicId}", zh: "主题里没有 memo {id}。查看列表：scorpio memo topicId={topicId}" },
  memo_gone: { en: "{id} is gone: the retired list keeps the latest 50 memos.", zh: "{id} 已不再保留：已淘汰列表保留最新 50 条 memo。" },
  version_gone: { en: "{slot} version {version} is gone: the latest 10 versions are kept.", zh: "{slot} 的第 {version} 版已不再保留：只保留最新 10 版。" },
  not_in_slot: { en: "{id} is retired ({state}). To bring it back: scorpio memo topicId={topicId} restore={id}", zh: "{id} 已离开短条位（{state}）。捞回：scorpio memo topicId={topicId} restore={id}" },
  already_in_slot: { en: "{id} is already in a slot.", zh: "{id} 已经在短条位里。" },
  version_conflict: { en: "{slot} changed since you read it: now version {version} ({by}, {time}). The current text is in current.text; make your change on it and send version={version}.", zh: "{slot} 在你读后有了修改：当前第 {version} 版（{by}，{time}）。正文在 current.text，请在其上修改并发送 version={version}。" },
  merge_unnamed: { en: "A merge names every merged memo in the text: {missing} is missing. Keep each memo's point with its author and source.", zh: "并入时正文要写出每条 memo 的 M 号：缺少 {missing}。保留要点、作者和出处。" },
  rate_limited: { en: "Too many memo writes; try again in {seconds} s.", zh: "memo 写入过多；请在 {seconds} 秒后重试。" },
};
export function memoNext(code: keyof typeof MEMO_NEXT, values: Values = {}, lang: 'en' | 'zh' = 'en'): string {
  return MEMO_NEXT[code][lang].replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}
