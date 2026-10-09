// game-core.js 单元测试
import { Game, BOARD_DEF, BOARD_SIZE, DISTRICTS, START_CASH, SALARY,
         BAIL_COST, JAIL_TURNS, HOSPITAL_FEE, HUB_BUILDINGS, INSURANCE_PAYOUT,
         GAS_BOOST, HOTEL_STAY, cellGridPos } from "./game-core.js";

let pass = 0;
function ok(cond, msg) { if (!cond) { console.error("❌ FAIL:", msg); process.exit(1); } pass++; }

function autoPlay(seed, maxTurns = 6000) {
  const g = new Game(seed);
  let turns = 0;
  while (g.winner === null && turns < maxTurns) {
    const pidx = g.turn, p = g.players[pidx];
    if (g.autoSkip(pidx)) { g.nextTurn(); turns++; continue; }
    let again = true, guard = 0;
    while (again && guard++ < 10 && g.winner === null && turns < maxTurns) {
      again = false;
      const r = g.roll();
      ok(r.d1 >= 1 && r.d1 <= 6 && r.d2 >= 1 && r.d2 <= 6, "双骰子范围");
      ok(r.total === r.d1 + r.d2 && r.doubles === (r.d1 === r.d2), "双骰子一致性");
      const cell = g.movePlayer(pidx, r.total);
      let res = g.resolveLanding(pidx, cell);
      const wentJail = res.action === "jail_choice" || !!res.jailed;
      let gd = 0;
      while (res.action && gd++ < 6) {
        const c = res.cell;
        if (res.action === "buy") { if (g.aiBuy(pidx, c)) ok(g.buy(pidx, c), "AI买地"); }
        else if (res.action === "buy_hub") { const b = g.aiHubBuilding(pidx); if (b) ok(g.buildHub(pidx, c, b), "AI建中转站"); }
        else if (res.action === "upgrade") { if (g.aiUpgrade(pidx, c)) ok(g.upgrade(pidx, c), "AI升级"); }
        else if (res.action === "jail_choice") { if (g.aiBail(pidx)) ok(g.payBail(pidx), "AI保释"); else g.serveJail(pidx); }
        if (g.aiUseFrame(pidx)) ok(g.useFrame(pidx), "AI用嫁祸卡");
        res = { action: null };
      }
      ok(!p.bankrupt || g.winner !== null, "破产必有赢家");
      // 双骰奖励：点数相同且未进监狱 → 再掷一次（进监狱则奖励作废）
      const forfeited = wentJail || p.jail > 0;
      if (r.doubles && g.winner === null && !p.bankrupt && !forfeited) again = true;
      turns++;
    }
    if (g.winner !== null) break;
    g.nextTurn(); turns++;
  }
  return g;
}

// 1. 棋盘
ok(BOARD_DEF.length === 28, "28格");
const kinds = BOARD_DEF.map(r => r[0]);
ok(kinds.filter(k => k === "land").length === 16, "16块地");
ok(kinds.filter(k => k === "chance").length === 4, "4个机会");
ok(kinds.filter(k => k === "hub").length === 2, "2个中转站");
for (const d of Object.keys(DISTRICTS))
  ok(BOARD_DEF.filter(r => r[2] === d).length === 4, `国家${d}有4城`);
// 城市名检查（用户点的：洛杉矶/旧金山等世界城市）
const names = BOARD_DEF.map(r => r[1]).join("");
for (const city of ["纽约", "洛杉矶", "旧金山", "芝加哥", "北京", "上海", "东京", "伦敦"])
  ok(names.includes(city), `有城市${city}`);

// 2. 网格映射
const pts = Array.from({ length: 28 }, (_, i) => cellGridPos(i).join(","));
ok(new Set(pts).size === 28, "格子不重叠");
ok(pts.every(s => { const [r, c] = s.split(",").map(Number); return r >= 0 && r < 8 && c >= 0 && c < 8; }), "8x8内");

// 3. 30种子完整对局
for (let s = 0; s < 30; s++) {
  const g = autoPlay(s);
  ok(g.winner !== null && [0, 1, "draw"].includes(g.winner), `seed${s}有赢家`);
  ok(g.players.every(p => p.cash >= 0), `seed${s}现金非负`);
}
console.log("30种子对局 ✓");

// 4. 买/租/破产
{
  const g = new Game(1);
  const cell = g.cells[1]; // 纽约 C档
  ok(g.buy(0, cell) && cell.owner === 0, "买地");
  ok(g.players[0].cash === START_CASH - 5000, "扣钱");
  ok(!g.buy(1, cell), "不能重复买");
  ok(g.upgrade(0, cell), "升级");
  const before = g.players[1].cash;
  g.players[1].pos = 1;
  const res = g.resolveLanding(1, cell);
  ok(res.paidRent === g.rentOf(cell), "租金一致");
  ok(g.players[1].cash === before - g.rentOf(cell), "扣租");
  g.players[1].cash = 10;
  const r2 = g.resolveLanding(1, cell);
  ok(r2.bankrupt && g.winner === 0, "破产判负");
}
console.log("买地/租金/破产 ✓");

// 5. 同国租金叠加（不要求垄断）+ 最多升3级
{
  const g = new Game(2);
  const uk = g.cells.filter(c => c.district === "uk"); // A档租金 [900,1800,2700,3600]
  ok(uk.length === 4, "英国4城");
  g.buy(0, uk[0]);
  ok(g.rentOf(uk[0]) === 900, "只有1处时收单块租金");
  g.buy(0, uk[1]);
  ok(g.rentOf(uk[0]) === 1800, "2处房产租金叠加");
  ok(g.upgrade(0, uk[0]) && uk[0].level === 1, "升1级");
  ok(g.upgrade(0, uk[0]) && uk[0].level === 2, "升2级");
  ok(g.upgrade(0, uk[0]) && uk[0].level === 3, "升3级");
  ok(!g.upgrade(0, uk[0]) && uk[0].level === 3, "不能升第4级");
  ok(g.rentOf(uk[1]) === 3600 + 900, "升级后叠加计入");
  const idx = g.cells.indexOf(uk[1]);
  g.players[1].pos = idx;
  const cb = g.players[1].cash, ob = g.players[0].cash;
  const rr = g.resolveLanding(1, uk[1]);
  ok(rr.paidRent === 4500, "实收叠加租金=" + rr.paidRent);
  ok(g.players[1].cash === cb - 4500 && g.players[0].cash === ob + 4500, "双方账目正确");
  // 集齐仍给皇冠
  g.buy(0, uk[2]); g.buy(0, uk[3]);
  ok(g.monopoly(0, "uk"), "4城仍算集齐");
}
console.log("同国租金叠加+3级升级 ✓");

// 6. 监狱/医院/工资/序列化
{
  const g = new Game(3);
  const jail = g.cells.find(c => c.kind === "jail");
  let res = g.resolveLanding(0, jail);
  ok(res.action === "jail_choice", "有钱给选择");
  ok(g.payBail(0), "保释");
  ok(g.players[0].cash === START_CASH - BAIL_COST, "扣保释金");
  g.players[1].cash = 100;
  res = g.resolveLanding(1, jail);
  ok(res.jailed && g.players[1].jail === JAIL_TURNS, "没钱坐牢");

  const hosp = g.cells.find(c => c.kind === "hospital");
  const before = g.players[0].cash;
  res = g.resolveLanding(0, hosp);
  ok(res.hospital === HOSPITAL_FEE && g.players[0].skip === true, "医院");
  ok(g.players[0].cash === before - HOSPITAL_FEE, "扣医药费");

  g.players[0].pos = 26;
  g.movePlayer(0, 5);
  ok(g.players[0].cash >= START_CASH - BAIL_COST - HOSPITAL_FEE + SALARY - 1, "过起点工资");

  const json = g.toJSON();
  const g2 = Game.fromJSON(json);
  ok(g2.players[1].jail === JAIL_TURNS && g2.turn === g.turn, "序列化还原");
}
console.log("监狱/医院/工资/序列化 ✓");

// 7. 双骰子：点数范围、一致性、双骰概率≈1/6
{
  const g = new Game(42);
  let doubles = 0;
  for (let i = 0; i < 600; i++) {
    const r = g.roll();
    ok(r.d1 >= 1 && r.d1 <= 6 && r.d2 >= 1 && r.d2 <= 6, "骰子范围");
    ok(r.total === r.d1 + r.d2, "点数=两骰之和");
    ok(r.doubles === (r.d1 === r.d2), "doubles标记正确");
    if (r.doubles) doubles++;
  }
  ok(doubles > 50 && doubles < 160, `双骰概率≈1/6，实测${doubles}/600`);
}
console.log("双骰子 ✓");

// 8. 投降
{
  const g = new Game(9);
  ok(g.surrender(0) && g.winner === 1, "投降后对手获胜");
  ok(g.players[0].bankrupt, "投降算破产");
  ok(!g.surrender(1), "已结束不能再投降");
}
console.log("投降 ✓");

// 9. 中转站：建造/过路费/旅馆3天/公园加成/加油站加速/保险理赔
{
  const g = new Game(11);
  const hubs = g.cells.filter(c => c.kind === "hub");
  ok(hubs.length === 2, "2个中转站");
  const hub = hubs[0], idx = g.cells.indexOf(hub);
  // 未购买时落地 → buy_hub
  let res = g.resolveLanding(0, hub);
  ok(res.action === "buy_hub", "空中转站可购买");
  g.players[0].cash = 100;
  ok(!g.buildHub(0, hub, "hotel"), "没钱不能建");
  g.players[0].cash = START_CASH;
  ok(g.buildHub(0, hub, "hotel") && hub.owner === 0 && hub.building === "hotel", "建造旅馆");
  ok(g.players[0].cash === START_CASH - HUB_BUILDINGS.hotel.cost, "扣建造费");
  ok(!g.buildHub(1, hub, "park"), "不能重复建造");
  // 对手踩中旅馆：付过路费 + 停留3天
  g.players[1].pos = idx;
  const cb = g.players[1].cash, ob = g.players[0].cash;
  res = g.resolveLanding(1, hub);
  ok(g.players[1].cash === cb - HUB_BUILDINGS.hotel.toll, "付旅馆过路费");
  ok(g.players[0].cash === ob + HUB_BUILDINGS.hotel.toll, "店主收钱");
  ok(g.players[1].hotelStay === HOTEL_STAY, "停留3天");
  ok(g.autoSkip(1) && g.players[1].hotelStay === HOTEL_STAY - 1, "第1天跳过");
  ok(g.autoSkip(1) && g.autoSkip(1) && g.players[1].hotelStay === 0, "3天后恢复");
  ok(!g.autoSkip(1), "不再跳过");
  // 店主自己踩：无事发生
  g.players[0].pos = idx;
  const oc = g.players[0].cash;
  res = g.resolveLanding(0, hub);
  ok(res.action === null && g.players[0].cash === oc && g.players[0].hotelStay === 0, "店主自踩无事");

  // 公园：名下房产租金+30%
  const g2 = new Game(12);
  const hub2 = g2.cells.filter(c => c.kind === "hub")[1];
  const uk = g2.cells.filter(c => c.district === "uk");
  g2.buy(0, uk[0]);
  const base = g2.rentOf(uk[0]);
  ok(g2.buildHub(0, hub2, "park"), "建造公园");
  ok(g2.rentOf(uk[0]) === Math.round(base * 1.3), `公园+30%：${base}→${g2.rentOf(uk[0])}`);
  // 对手踩公园：免费
  g2.players[1].pos = g2.cells.indexOf(hub2);
  const c2 = g2.players[1].cash;
  g2.resolveLanding(1, hub2);
  ok(g2.players[1].cash === c2, "公园免费参观");

  // 加油站：过路费+加速
  const g3 = new Game(13);
  const hub3 = g3.cells.filter(c => c.kind === "hub")[0];
  g3.buildHub(0, hub3, "gas");
  g3.players[1].pos = g3.cells.indexOf(hub3);
  const c3 = g3.players[1].cash;
  g3.resolveLanding(1, hub3);
  ok(g3.players[1].cash === c3 - HUB_BUILDINGS.gas.toll, "付加油站过路费");
  ok(g3.players[1].boost === GAS_BOOST, "获得加速");
  g3.turn = 1;
  const r = g3.roll();
  ok(r.total === r.d1 + r.d2 + GAS_BOOST && r.boosted === GAS_BOOST, "掷骰+2");
  ok(g3.players[1].boost === 0, "加速一次性");

  // 保险公司：过路费+3步内出事理赔
  const g4 = new Game(14);
  const hub4 = g4.cells.filter(c => c.kind === "hub")[0];
  g4.buildHub(0, hub4, "insurance");
  g4.players[1].pos = g4.cells.indexOf(hub4);
  const c4 = g4.players[1].cash, o4 = g4.players[0].cash;
  g4.resolveLanding(1, hub4);
  ok(g4.players[1].cash === c4 - HUB_BUILDINGS.insurance.toll, "付保费");
  ok(g4.players[1].insured && g4.players[1].insured.turns === 3, "获得3步保险");
  // 3步内住院 → 理赔
  const hosp = g4.cells.find(c => c.kind === "hospital");
  const cc4 = g4.players[1].cash, oo4 = g4.players[0].cash;
  g4.resolveLanding(1, hosp);
  ok(g4.players[1].insured === null, "理赔后保险失效");
  ok(g4.players[1].cash === cc4 - HOSPITAL_FEE + INSURANCE_PAYOUT, "获赔8000");
  ok(g4.players[0].cash === oo4 - INSURANCE_PAYOUT, "店主赔付");
  // 保险过期：3次掷骰后失效
  const g5 = new Game(15);
  const hub5 = g5.cells.filter(c => c.kind === "hub")[0];
  g5.buildHub(0, hub5, "insurance");
  g5.players[1].pos = g5.cells.indexOf(hub5);
  g5.resolveLanding(1, hub5);
  g5.turn = 1;
  g5.roll(); g5.roll(); g5.roll();
  ok(g5.players[1].insured === null, "3步后保险过期");
  // 序列化保留建筑和buff
  const json = g4.toJSON();
  const g6 = Game.fromJSON(json);
  ok(g6.cells[g6.cells.indexOf(g6.cells.find(c => c.kind === "hub"))].building === "insurance", "建筑序列化");
}
console.log("中转站 ✓");

// 10. 机会新卡：免罚卡/嫁祸卡/特效药
{
  // 采样验证三种卡都会出现
  const seen = new Set();
  for (let s = 0; s < 300 && seen.size < 3; s++) {
    const g = new Game(1000 + s);
    const ch = g.cells.find(c => c.kind === "chance");
    g.players[0].pos = g.cells.indexOf(ch);
    const before = g.players[0].items.length;
    g.resolveLanding(0, ch);
    if (g.players[0].items.length > before)
      g.players[0].items.slice(before).forEach(i => seen.add(i));
  }
  ok(seen.has("jail_free") && seen.has("frame") && seen.has("medicine"), "三种卡都出现：" + [...seen].join(","));

  // 免罚卡：进监狱自动免罪
  const g = new Game(21);
  g.players[0].items.push("jail_free");
  const jail = g.cells.find(c => c.kind === "jail");
  const res = g.resolveLanding(0, jail);
  ok(res.usedCard === "jail_free" && g.players[0].jail === 0, "免罚卡生效");
  ok(!g.players[0].items.includes("jail_free"), "卡被消耗");

  // 特效药：进医院自动痊愈
  const g2 = new Game(22);
  g2.players[0].items.push("medicine");
  const hosp = g2.cells.find(c => c.kind === "hospital");
  const c2 = g2.players[0].cash;
  const res2 = g2.resolveLanding(0, hosp);
  ok(res2.usedCard === "medicine" && g2.players[0].cash === c2 && !g2.players[0].skip, "特效药生效");

  // 嫁祸卡：对手进监狱
  const g3 = new Game(23);
  g3.players[0].items.push("frame");
  ok(g3.useFrame(0) && g3.players[1].jail === JAIL_TURNS, "嫁祸成功");
  ok(!g3.useFrame(0), "卡已用完不能再用");
  // 对方有免罚卡则抵挡
  const g4 = new Game(24);
  g4.players[0].items.push("frame");
  g4.players[1].items.push("jail_free");
  ok(g4.useFrame(0) && g4.players[1].jail === 0, "免罚卡抵挡嫁祸");
  ok(!g4.players[1].items.includes("jail_free"), "抵挡消耗免罚卡");
}
console.log("机会新卡 ✓");

// 11. 起点工资1000
{
  const g = new Game(25);
  g.players[0].pos = 26;
  const before = g.players[0].cash;
  g.movePlayer(0, 5);
  ok(g.players[0].cash === before + 5000, "过起点+5000");
  ok(SALARY === 5000, "SALARY常量=5000");
}
console.log("起点工资 ✓");
console.log(`全部通过（${pass}断言）`);
