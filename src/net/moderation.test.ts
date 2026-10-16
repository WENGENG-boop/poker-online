import { describe, expect, it } from 'vitest';
import { checkText, containsBlocked } from './moderation';

describe('聊天审核', () => {
  it('放行正常短语', () => {
    for (const t of ['好牌', '快点啊', '再来一局', 'gg', '666', '谢谢你', '操作失误', 'nice']) {
      expect(checkText(t).ok, t).toBe(true);
    }
  });

  it('拦截辱骂、拼音缩写与变体写法', () => {
    for (const t of ['傻逼', '傻 逼', 'S.B', 'ｓｂ', 'nmsl', '你个垃圾', '去死吧', 'f u c k', 'Fuck', '尼 玛', '草泥马', '卧槽']) {
      expect(containsBlocked(t), t).toBe(true);
      expect(checkText(t).ok, t).toBe(false);
    }
  });

  it('拦截广告引流与联系方式', () => {
    for (const t of ['加微信', 'vx123', '13800138', 'qq群', 'www']) expect(checkText(t).ok, t).toBe(false);
  });

  it('限制长度与字符', () => {
    expect(checkText('一二三四五六七').ok).toBe(false);
    expect(checkText('🖕').ok).toBe(false);
    expect(checkText('好😀').ok).toBe(false);
    expect(checkText('   ').ok).toBe(false);
  });
});
