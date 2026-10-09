// game-core.js 单元测试
import { Game, BOARD_DEF, BOARD_SIZE, DISTRICTS, START_CASH, SALARY,
         BAIL_COST, JAIL_TURNS, HOSPITAL_FEE, cellGridPos } from "./game-core.js";

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
        else if (res.action === "upgrade") { if (g.aiUpgrade(pidx, c)) ok(g.upgrade(pidx, c), "AI升级"); }
        else if (res.action === "jail_choice") { if (g.aiBail(pidx)) ok(g.payBail(pidx), "AI保释"); else g.serveJail(pidx); }
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
ok(kinds.filter(k => k === "chance").length === 6, "6个机会");
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

// 5. 垄断：收全区租金
{
  const g = new Game(2);
  const uk = g.cells.filter(c => c.district === "uk");
  ok(uk.length === 4, "英国4城");
  uk.slice(0, 3).forEach(c => g.buy(0, c));
  ok(!g.monopoly(0, "uk"), "3城不垄断");
  g.buy(0, uk[3]);
  ok(g.monopoly(0, "uk"), "4城垄断");
  // A档租金[900,2100]，0级每块900，4块=3600
  ok(g.rentOf(uk[0]) === 900 * 4, "垄断收全区租金=" + g.rentOf(uk[0]));
  g.upgrade(0, uk[0]);
  ok(g.rentOf(uk[1]) === 900 * 3 + 2100, "升级后计入全区租金");
  // 非垄断仍是单块租金
  const g2 = new Game(3);
  const usa = g2.cells.filter(c => c.district === "usa");
  g2.buy(0, usa[0]);
  ok(g2.rentOf(usa[0]) === 3000, "非垄断单块租金");
  // 实际收租：对手踩中垄断区，扣全区租金
  const idx = g.cells.indexOf(uk[1]);
  g.players[1].pos = idx;
  const cashBefore = g.players[1].cash, ownerBefore = g.players[0].cash;
  const rr = g.resolveLanding(1, uk[1]);
  const expectRent = 900 * 3 + 2100;
  ok(rr.paidRent === expectRent, "实收全区租金=" + rr.paidRent);
  ok(g.players[1].cash === cashBefore - expectRent, "对手扣钱");
  ok(g.players[0].cash === ownerBefore + expectRent, "房主收钱");
}
console.log("国家垄断收全区租金 ✓");

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
console.log(`全部通过（${pass}断言）`);
