/** P3：只检测用户手动导入的卡；不导入、不改卡、不操作 ST 源文件。 */
import type { BridgePage } from './host'

export interface BridgeCard { name: string; avatar: string }

export async function findCard(page: BridgePage, cardName: string, preferredAvatar = ''): Promise<BridgeCard> {
  return page.eval<BridgeCard>(
    `(async () => {
      const name = ` + JSON.stringify(cardName) + `;
      const preferred = ` + JSON.stringify(preferredAvatar) + `;
      const ctx = SillyTavern.getContext();
      const response = await fetch('/api/characters/all', { method: 'POST', headers: ctx.getRequestHeaders(), body: '{}' });
      if (!response.ok) throw new Error('角色列表读取失败：HTTP ' + response.status);
      const all = await response.json();
      if (!Array.isArray(all)) throw new Error('ST 角色列表格式异常');
      const cards = all.filter(card => card.name === name && typeof card.avatar === 'string' && card.avatar.endsWith('.png'));
      if (!cards.length) throw new Error('未找到角色「' + name + '」，请先在酒馆中导入对应角色卡');
      const exact = cards.find(card => card.avatar === preferred);
      if (cards.length > 1 && !exact) throw new Error('ST 中有多张同名角色卡「' + name + '」，请改用唯一的角色卡名称后重试');
      const card = exact || cards[0];
      return { name: card.name, avatar: card.avatar };
    })()`, 'character:find')
}

/** ST 1.19 接收 ctx.characters 的数字索引，不是 avatar 去扩展名。 */
export async function selectCharacter(page: BridgePage, card: BridgeCard, timeoutMs = 60000): Promise<void> {
  await page.eval(`(async () => {
    const card = ` + JSON.stringify(card) + `;
    const deadline = Date.now() + ` + Number(timeoutMs) + `;
    let ctx;
    while (Date.now() <= deadline) {
      ctx = SillyTavern.getContext();
      if (typeof ctx.selectCharacterById === 'function') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (typeof ctx?.selectCharacterById !== 'function') throw new Error('ST 页面缺少 selectCharacterById，请检查 ST 版本');
    if (!ctx.characters.some(item => item.avatar === card.avatar) && typeof ctx.getCharacters === 'function') {
      await ctx.getCharacters();
      ctx = SillyTavern.getContext();
    }
    const index = ctx.characters.findIndex(item => item.avatar === card.avatar && item.name === card.name);
    if (index < 0) throw new Error('ST 页面角色列表中没有「' + card.name + '」，请刷新角色列表后重试');
    await ctx.selectCharacterById(index);
    const current = SillyTavern.getContext();
    const selected = current.characters[current.characterId];
    if (current.groupId != null || selected?.name !== card.name || selected?.avatar !== card.avatar) {
      throw new Error('ST 角色选中校验失败：期望「' + card.name + '」，当前「' + (selected?.name || '未选中') + '」');
    }
    return { name: selected.name, avatar: selected.avatar };
  })()`, 'character:select')
}

export async function assertCharacter(page: BridgePage, cardName: string, avatar = ''): Promise<BridgeCard> {
  return page.eval<BridgeCard>(`(() => {
    const ctx = SillyTavern.getContext();
    const expected = ` + JSON.stringify(cardName) + `;
    const avatar = ` + JSON.stringify(avatar) + `;
    const card = ctx.characters[ctx.characterId];
    if (ctx.groupId != null || !card || card.name !== expected || (avatar && card.avatar !== avatar)) {
      throw new Error('ST 当前角色是「' + (card?.name || '未选中') + '」，与本轮配置的「' + expected + '」不符。请切回「' + expected + '」，或停止 ST 后修改桥接角色再重新打开。');
    }
    return { name: card.name, avatar: card.avatar };
  })()`, 'character:assert')
}
