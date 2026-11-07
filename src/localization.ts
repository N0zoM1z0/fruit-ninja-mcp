// English UI for the evaluation builds. The pinned upstream file is verified by SHA-256 first
// and never modified on disk; this exact-phrase table is applied in memory by applyRules, so
// the packaged (builder) and refereed (GUI/MCP play) builds show identical English text.
// Only player-visible text changes: markup, DOM ids, game logic and scoring are untouched.
// Fails closed if the upstream text changes or any Chinese text would remain.

/** [exact upstream source, English]. Applied longest source first. */
export const englishUi: readonly (readonly [string, string])[] = [
  ['<html lang="zh-CN">', '<html lang="en">'],
  // Header, page and accessibility labels
  ["水果忍者 · 再来一刀", "Fruit Ninja · One More Slice"],
  ["水果忍者首页", "Fruit Ninja home"],
  ["水果忍者<small>FRUIT NINJA</small>", "Fruit Ninja<small>DOJO</small>"],
  [
    "生活偶尔复杂，快乐只需一刀。",
    "Life gets complicated. Joy takes one slice.",
  ],
  ["手感设置", "Settings"],
  ["关闭玩法说明", "Close how to play"],
  ["玩法说明", "How to play"],
  ["关闭音效", "Mute sound"],
  ["开启音效", "Unmute sound"],
  ["音效 · M", "Sound · M"],
  ["退出全屏", "Exit full screen"],
  ["全屏游戏", "Full screen"],
  [
    "当前浏览器不支持全屏，请使用浏览器全屏功能",
    "Full screen is not supported here. Use the browser full-screen mode.",
  ],
  ["全屏", "Full screen"],
  ["水果忍者游戏区域", "Fruit Ninja play area"],
  [
    "按住鼠标或滑动手指切开水果，避开炸弹",
    "Hold the mouse or swipe a finger to slice fruit and avoid bombs",
  ],
  // Menu
  ["新鲜出场 · 即刻开切", "Fresh in · Slice now"],
  ["手起，刀落。烦恼切掉。", "Blade down, worries gone."],
  [
    "划出你的刀锋，把平凡的一刻切成满屏痛快。",
    "Swing your blade and turn an ordinary moment into a screenful of joy.",
  ],
  ["开始切水果", "Start slicing"],
  ["你的第一项纪录，等你来创造", "Your first record is waiting"],
  ["一<br>刀<br>入<br>魂", "ONE<br>SLICE<br>ALL<br>IN"],
  ["选个玩法", "Pick a mode"],
  ["游戏模式", "Game modes"],
  ['aria-hidden="true">斩</span>', 'aria-hidden="true">C</span>'],
  ['aria-hidden="true">燃</span>', 'aria-hidden="true">A</span>'],
  ['aria-hidden="true">禅</span>', 'aria-hidden="true">Z</span>'],
  ["经典模式 <small>CLASSIC</small>", "Classic <small>MODE</small>"],
  ["街机模式 <small>ARCADE</small>", "Arcade <small>MODE</small>"],
  ["禅模式 <small>ZEN</small>", "Zen <small>MODE</small>"],
  ["三次机会，挑战你的极限", "Three lives. Push your limits."],
  ["60 秒冲刺，连击火力全开", "60-second sprint. Combos at full blast."],
  ["90 秒，只管享受切水果", "90 seconds. Just enjoy slicing."],
  ["经典模式", "Classic"],
  ["街机模式", "Arcade"],
  ["禅模式", "Zen"],
  [
    "按住鼠标划过水果 · 漏果三次或碰到炸弹即结束",
    "Swipe through fruit · 3 misses or a bomb ends the round",
  ],
  [
    "连切 20 个水果触发狂热 · 炸弹扣 10 分",
    "Slice 20 fruit to trigger Frenzy · Bombs cost 10 points",
  ],
  [
    "没有炸弹，没有漏果惩罚 · 享受每一刀",
    "No bombs, no miss penalty · Enjoy every slice",
  ],
  ["好手感，从第一刀开始", "Great feel starts with the first slice"],
  // The arena watermark is a single calligraphic glyph; the English word needs a smaller font.
  [
    "c.font = `${radius * 1.45}px KaiTi, STKaiti, serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#e5c38e'; c.fillText('斩', cx, cy + 4);",
    "c.font = `italic ${radius * 0.5}px Georgia, serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#e5c38e'; c.fillText('SLICE', cx, cy + 4);",
  ],
  // HUD and banners
  ["游戏状态", "Game status"],
  ["得分", "Score"],
  ["最佳", "Best"],
  ["让水果飞一会儿", "Let the fruit fly"],
  ["剩余三次机会", "Three lives left"],
  ["剩余时间", "Time left"],
  ["暂停游戏", "Pause game"],
  ["暂停 · 空格", "Pause · Space"],
  [
    "按住鼠标划过水果 · 小心炸弹",
    "Hold the mouse and swipe through fruit · Watch out for bombs",
  ],
  ["狂热时刻", "Frenzy"],
  ["双倍得分！", "Double points!"],
  ["连击", "combo"],
  ["按住鼠标拖动 / 手指滑动", "Hold and drag the mouse / swipe a finger"],
  ["水果要切，炸弹要躲。", "Slice the fruit, dodge the bombs."],
  ["小小水果，大大解压", "Small fruit, big relief"],
  // Pause dialog
  ["刀锋稍歇", "Blade at rest"],
  [
    "水果也在等你，准备好就继续。",
    "The fruit is waiting. Continue when you are ready.",
  ],
  ["继续游戏", "Resume"],
  ["返回首页", "Back to menu"],
  // Settings dialog
  ["关闭设置", "Close settings"],
  ["这一刀，听你的。", "Your blade, your way."],
  ["音效音量", "Sound volume"],
  ["切果、连击与漏果报警", "Slices, combos and missed-fruit alerts"],
  ["画面效果", "Visual effects"],
  ["根据设备自动平衡流畅度", "Balances smoothness for your device"],
  ["效果全开", "Full effects"],
  ["流畅优先", "Smoothness first"],
  ["自动", "Auto"],
  ["震动与慢动作", "Shake and slow motion"],
  [
    "连击时轻微震屏，手机支持时振动",
    "Light screen shake on combos; vibration on supported phones",
  ],
  ["刀锋颜色", "Blade color"],
  ["选择你的刀光", "Choose your blade trail"],
  ["薄荷流光", "Mint glow"],
  ["落日金芒", "Sunset gold"],
  ["冰蓝刃影", "Ice blue"],
  ["设置好了", "Done"],
  // Results dialog
  ["这一刀，够痛快。", "What a satisfying run."],
  ["本局得分", "Round score"],
  ["切开水果", "Fruit sliced"],
  ["最高连击", "Best combo"],
  ["历史最佳", "All-time best"],
  ["再来一刀", "Play again"],
  ["换个玩法", "Change mode"],
  ["新纪录，漂亮！", "New record. Nice!"],
  ["热个身，再来一次。", "Just a warm-up."],
  // Help dialog
  ["三招，上手。", "Three moves to get started."],
  ["划过，就切开", "Swipe to slice"],
  [
    "按住鼠标拖动，或在屏幕上滑动手指。水果从底部飞起，抓准时机出刀。",
    "Hold and drag the mouse, or swipe a finger on the screen. Fruit flies up from the bottom; time your strike.",
  ],
  ["一刀多果，连击加分", "Many fruit in one swipe earn a combo bonus"],
  [
    "同一刀快速切开 3 个或更多水果，获得连击奖励。街机模式累计切开 20 个水果，进入 6 秒双倍得分的狂热时刻。",
    "Slice 3 or more fruit quickly in one swipe for a combo bonus. In Arcade, slicing 20 fruit in total starts a 6-second Frenzy with double points.",
  ],
  ["记住你的玩法", "Know your mode"],
  [
    "经典：漏掉 3 个水果或切中炸弹，本局结束。",
    "Classic: missing 3 fruit or hitting a bomb ends the round.",
  ],
  [
    "街机：60 秒冲刺，炸弹扣 10 分，漏果不扣分。",
    "Arcade: a 60-second sprint. Bombs cost 10 points; missed fruit costs nothing.",
  ],
  [
    "禅：90 秒，没有炸弹，没有漏果惩罚。",
    "Zen: 90 seconds, no bombs, no penalty for missed fruit.",
  ],
  ["暂停 / 继续", "Pause / resume"],
  ["音效", "Sound"],
  ["暂停", "Pause"],
  // Footer
  ["为每一次痛快挥刀而生", "Made for every satisfying swing"],
  ["无需下载 · 随时开切", "No download · Slice anytime"],
  // Dynamic messages (JS strings and templates)
  [
    " · 个人最佳 ${records[selectedMode]} 分",
    " · personal best ${records[selectedMode]}",
  ],
  ["剩余 ${Math.max(0,3-misses)} 次机会", "${Math.max(0,3-misses)} lives left"],
  ["狂热进度 ${sliced % 20} / 20", "Frenzy ${sliced % 20} / 20"],
  ["已经切开 ${sliced} 个水果", "${sliced} fruit sliced"],
  [
    "连续命中 ${streak} 个 · 第 ${Math.max(1,wave)} 波",
    "Streak ${streak} · Wave ${Math.max(1,wave)}",
  ],
  ["碰到炸弹了。下一刀，记得躲开它。", "You hit a bomb. Dodge it next time."],
  ["炸弹 −10", "Bomb −10"],
  ["炸弹退场", "Bombs cleared"],
  ["一刀过瘾！", "What a slice!"],
  ["${n} 连击！", "${n}-fruit combo!"],
  ["奖励 +${bonus}", "Bonus +${bonus}"],
  ["漏果了 · 还剩 ${3-misses} 次机会", "Missed one · ${3-misses} lives left"],
  ["漏果三次，本局结束", "Three misses. Round over."],
  [
    "漏掉了 3 个水果。留意底部预警，下一刀接住它。",
    "You missed 3 fruit. Watch the bottom warnings and catch the next one.",
  ],
  [
    "时间到！把这份手感留给下一局。",
    "Time is up! Save that touch for the next round.",
  ],
];

const chinese = /[　-〿㐀-鿿豈-﫿＀-￯]/;
const quoting = /['"`<>]/;

export function localize(html: string): string {
  let result = html;
  for (const [source, english] of [...englishUi].sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    // English text placed inside JS strings or attributes must not change their quoting.
    for (const ch of english)
      if (quoting.test(ch) && !source.includes(ch))
        throw new Error(`Unsafe character ${ch} in translation of ${source}`);
    if (!result.includes(source))
      throw new Error(
        `Pinned game localization anchor changed: ${source.slice(0, 60)}`,
      );
    result = result.split(source).join(english);
  }
  const left = result.split("\n").findIndex((line) => chinese.test(line));
  if (left >= 0)
    throw new Error(
      `Untranslated game text on line ${left + 1}: ${result.split("\n")[left].trim().slice(0, 120)}`,
    );
  return result;
}
