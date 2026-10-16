// 聊天内容审核（服务器端执行，客户端无法绕过）。
//
// 规则：
//  1. 预设短语、预设表情直接通过（只认 id，不接受任意内容）。
//  2. 自定义文字：最多 6 个字，只允许中英文、数字和少量标点，不允许夹带 emoji。
//  3. 规范化后（全角转半角、去空格符号、转小写）匹配敏感词库：辱骂、色情、暴力、歧视、广告引流。
//  4. 拦截连续数字、网址等联系方式。
//
// 注意：词库只能拦截常见说法。正式上线建议在后端同时接入云内容安全服务
// （如阿里云内容安全、腾讯云文本内容安全），在 checkText 中追加调用即可。

export const QUICK_PHRASES = ['快点', '好牌', '厉害', '谢谢', '稍等', '加油', '失误', '再来', '哈哈', '承让', '666', '抱歉'] as const;

export const EMOJIS = ['😀', '😂', '😎', '🤔', '😅', '😭', '😱', '😤', '👍', '👏', '🙏', '💪', '🎉', '🔥', '❤️', '🌹'] as const;

export const MAX_TEXT_LENGTH = 6;

export type ModerationResult = { ok: true; text: string } | { ok: false; reason: string };

/** 词库：均为规范化后的形式 */
const BLOCKED_WORDS = [
  // 辱骂
  '傻逼', '傻b', '傻比', '煞笔', '沙比', '傻叉', '二逼', '逗比', '脑残', '智障', '弱智', '白痴', '蠢货', '蠢猪', '废物', '垃圾', '狗东西',
  '贱人', '贱货', '杂种', '畜生', '人渣', '败类', '滚蛋', '滚粗', '去死', '死全家', '全家死', '狗日', '日你', '尼玛', '你妈', '你妈的',
  '妈的', '他妈', '她妈', '特么', '泥马', '草泥马', '操你', '肏', '艹', '卧槽', '我草', '我操', '握草', '屌', '屌丝', '婊', '鸡巴', '王八蛋',
  '龟孙', '孙子', '狗屎', '吃屎', '妈逼', '骚货', '贱', '菜狗', '菜鸡', '辣鸡', '拉圾', '去你的',
  // 拼音缩写 / 英文
  'sb', 'nmsl', 'cnm', 'nmb', 'tmd', 'mlgb', 'wcnm', 'nnd', 'rnm', 'qnmd', 'nima', 'caonima', 'shabi',
  'fuck', 'fck', 'fuk', 'shit', 'bitch', 'dick', 'cunt', 'asshole', 'bastard', 'damn', 'stfu', 'wtf', 'idiot', 'stupid', 'loser',
  // 色情
  '色情', '约炮', '裸聊', '嫖', '妓', '做爱', '性交', '黄片', '援交',
  // 暴力 / 威胁
  '杀了你', '砍死', '弄死', '打死你', '杀你', '炸死',
  // 歧视
  '黑鬼', '支那', '残废', '娘炮', '死胖子',
  // 赌博 / 广告 / 引流
  '加微信', '加我', '微信', '威信', 'vx', 'wx', 'qq', '扣扣', '企鹅', '代练', '代打', '充值', '返利', '赌博', '赌钱', '下注', '彩票', '博彩',
  '刷单', '兼职', '加群', '私聊', 'http', 'www',
];

/** 包含敏感字但属于正常用语的词，先去掉再检测 */
const ALLOWED_WORDS = ['操作', '体操', '节操', '贱卖', '孙子兵法', '垃圾牌'];

/** 只允许：中文、英文字母、数字、常见中英文标点 */
const ALLOWED_CHARS = /^[一-龥a-zA-Z0-9，。！？、~～!?,. ]+$/;

export function normalize(text: string): string {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      // 去掉零宽字符、空白与常见分隔符，防止"傻 逼""s.b"之类绕过
      .replace(/[​-‏⁠﻿\s]/g, '')
      .replace(/[`~!@#$%^&*()\-_=+[\]{}\\|;:'".,<>/?，。！？、；：“”‘’（）【】《》·…—～]/g, '')
      // 常见字母变体
      .replace(/[0]/g, 'o')
  );
}

export function containsBlocked(text: string): boolean {
  let s = normalize(text);
  for (const w of ALLOWED_WORDS) s = s.split(w).join('');
  if (BLOCKED_WORDS.some((w) => s.includes(normalize(w)))) return true;
  // 去掉数字变体之前的原文：连续 5 位以上数字视为联系方式
  if (/\d{5,}/.test(text.normalize('NFKC').replace(/\s/g, ''))) return true;
  return false;
}

/** 审核自定义文字 */
export function checkText(raw: string): ModerationResult {
  const text = raw.normalize('NFKC').trim();
  if (!text) return { ok: false, reason: '消息不能为空' };
  if ([...text].length > MAX_TEXT_LENGTH) return { ok: false, reason: `最多 ${MAX_TEXT_LENGTH} 个字` };
  if (!ALLOWED_CHARS.test(text)) return { ok: false, reason: '只能发送文字，表情请从表情面板选择' };
  if (containsBlocked(text)) return { ok: false, reason: '消息包含不文明内容，已被拦截' };
  return { ok: true, text };
}
