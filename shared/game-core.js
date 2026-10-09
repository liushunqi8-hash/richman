// game-core.js — 大富翁纯逻辑（无 DOM），Node / Workers / 浏览器通用
// v3: 世界城市地图 / 初始 5 万 / 街区=国家垄断（收全区租金） / 监狱医院随机事件

export const BOARD_SIZE = 28;
export const GRID_N = 8;
export const START_CASH = 50000;
export const SALARY = 6000;
export const MAX_ROUNDS = 30;
export const JAIL_TURNS = 2;
export const BAIL_COST = 4800;
export const HOSPITAL_FEE = 4800;

export const TIERS = {
  A: { price: 2000,  rents: [900, 2100],  upgradeCost: 1500 },
  B: { price: 3500,  rents: [1950, 4200], upgradeCost: 2500 },
  C: { price: 5000,  rents: [3000, 6600], upgradeCost: 3500 },
};

export const DISTRICTS = {
  usa:   { name: "美国", flag: "🇺🇸", color: "#4da3ff", tint: "rgba(77,163,255,0.16)",  tier: "C" },
  china: { name: "中国", flag: "🇨🇳", color: "#ff6b6b", tint: "rgba(255,107,107,0.16)", tier: "B" },
  japan: { name: "日本", flag: "🇯🇵", color: "#ffa94d", tint: "rgba(255,169,77,0.16)",  tier: "B" },
  uk:    { name: "英国", flag: "🇬🇧", color: "#b197fc", tint: "rgba(177,151,252,0.16)", tier: "A" },
};

// [种类, 名字, 国家]
export const BOARD_DEF = [
  ["start",    "🏁 起点",   null],
  ["land",     "纽约",     "usa"],
  ["land",     "洛杉矶",   "usa"],
  ["chance",   "❓ 机会",  null],
  ["land",     "旧金山",   "usa"],
  ["tax",      "🧾 税务局", null],
  ["land",     "北京",     "china"],
  ["land",     "上海",     "china"],
  ["chance",   "❓ 机会",  null],
  ["land",     "广州",     "china"],
  ["jail",     "🚔 监狱",  null],
  ["land",     "深圳",     "china"],
  ["land",     "东京",     "japan"],
  ["hospital", "🏥 医院",  null],
  ["land",     "大阪",     "japan"],
  ["chance",   "❓ 机会",  null],
  ["land",     "京都",     "japan"],
  ["land",     "札幌",     "japan"],
  ["rest",     "🏖️ 度假村", null],
  ["land",     "伦敦",     "uk"],
  ["land",     "曼彻斯特", "uk"],
  ["chance",   "❓ 机会",  null],
  ["land",     "爱丁堡",   "uk"],
  ["land",     "利物浦",   "uk"],
  ["land",     "芝加哥",   "usa"],
  ["chance",   "❓ 机会",  null],
  ["tax",      "🧾 税务局", null],
  ["chance",   "❓ 机会",  null],
];

const CHANCE_KEYS = ["bonus", "fine", "forward", "back", "lottery", "robbed"];
const CHANCE_WEIGHTS = [3, 3, 2, 2, 1, 1];

// 确定性 RNG（测试用），线上用 Date.now() 做种子
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Game {
  constructor(seed) {
    this.seed = seed === undefined ? (Date.now() % 2147483647) : seed;
    this.rngCalls = 0;
    this.rng = mulberry32(this.seed);
    this.cells = BOARD_DEF.map(([kind, name, district]) => ({
      kind, name, district, owner: null, level: 0,
    }));
    this.players = [
      { name: "玩家1", cash: START_CASH, pos: 0, skip: false, jail: 0, bankrupt: false },
      { name: "玩家2", cash: START_CASH, pos: 0, skip: false, jail: 0, bankrupt: false },
    ];
    this.turn = 0;
    this.round = 1;
    this.winner = null;
    this.lastRoll = null;
    this.log = [];
  }

  _rand() { this.rngCalls++; return this.rng(); }

  // ---- 序列化（DO 存储 / WS 广播） ----
  toJSON() {
    return {
      seed: this.seed, rngCalls: this.rngCalls,
      cells: this.cells.map(c => ({ owner: c.owner, level: c.level })),
      players: this.players.map(p => ({ ...p })),
      turn: this.turn, round: this.round, winner: this.winner,
      lastRoll: this.lastRoll, log: this.log.slice(-150),
    };
  }
  static fromJSON(d) {
    const g = new Game(d.seed);
    for (let i = 0; i < (d.rngCalls || 0); i++) g._rand(); // 快进 RNG，保证骰子不重播
    d.cells.forEach((c, i) => { g.cells[i].owner = c.owner; g.cells[i].level = c.level; });
    g.players = d.players.map(p => ({ ...p }));
    g.turn = d.turn; g.round = d.round; g.winner = d.winner;
    g.lastRoll = d.lastRoll; g.log = d.log || [];
    return g;
  }

  pushLog(msg) { this.log.push(msg); if (this.log.length > 150) this.log.shift(); }

  tierOf(cell) { return cell.district ? DISTRICTS[cell.district].tier : null; }
  priceOf(cell) { const t = this.tierOf(cell); return t ? TIERS[t].price : 0; }
  upgradeCostOf(cell) { const t = this.tierOf(cell); return t ? TIERS[t].upgradeCost : 0; }
  baseRentOf(cell) { const t = this.tierOf(cell); return t ? TIERS[t].rents[cell.level] : 0; }

  districtCells(d) { return this.cells.filter(c => c.district === d); }
  monopoly(pidx, d) {
    const cs = this.districtCells(d);
    return cs.length > 0 && cs.every(c => c.owner === pidx);
  }
  // 垄断某国：踩中该国任意房产，收取该房主在该国所有房子的租金之和
  rentOf(cell) {
    if (cell.owner === null || !cell.district) return this.baseRentOf(cell);
    if (this.monopoly(cell.owner, cell.district)) {
      let total = 0;
      for (const c of this.cells)
        if (c.kind === "land" && c.district === cell.district && c.owner === cell.owner)
          total += this.baseRentOf(c);
      return total;
    }
    return this.baseRentOf(cell);
  }
  assets(pidx) {
    const p = this.players[pidx];
    let total = p.cash;
    this.cells.forEach(c => {
      if (c.owner === pidx) { total += this.priceOf(c); if (c.level) total += this.upgradeCostOf(c); }
    });
    return total;
  }
  ownedCount(pidx) { return this.cells.filter(c => c.owner === pidx).length; }
  monopolyCount(pidx) { return Object.keys(DISTRICTS).filter(d => this.monopoly(pidx, d)).length; }

  // 双骰子：返回 {d1, d2, total, doubles}
  roll() {
    const d1 = 1 + Math.floor(this._rand() * 6);
    const d2 = 1 + Math.floor(this._rand() * 6);
    this.lastRoll = [d1, d2];
    return { d1, d2, total: d1 + d2, doubles: d1 === d2 };
  }

  movePlayer(pidx, steps) {
    const p = this.players[pidx];
    if (p.pos + steps >= BOARD_SIZE) { p.cash += SALARY; this.pushLog(`💰 ${p.name} 经过起点，+¥${SALARY}`); }
    p.pos = (((p.pos + steps) % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE;
    return this.cells[p.pos];
  }

  // 返回 {action: null|'buy'|'upgrade'|'jail_choice', cell, ...extra}
  resolveLanding(pidx, cell, depth = 0) {
    const p = this.players[pidx];
    if (cell.kind === "land") {
      if (cell.owner === null) return { action: "buy", cell };
      if (cell.owner === pidx) return cell.level === 0 ? { action: "upgrade", cell } : { action: null, cell };
      const rent = this.rentOf(cell);
      const mono = cell.district && this.monopoly(cell.owner, cell.district);
      if (p.cash < rent) {
        p.bankrupt = true; this.winner = 1 - pidx;
        this.pushLog(`💸 ${p.name} 付不起 ¥${rent} 租金，破产！`);
        return { action: null, cell, bankrupt: true };
      }
      p.cash -= rent; this.players[cell.owner].cash += rent;
      this.pushLog(`💰 ${p.name} 交租 ¥${rent}${mono ? "（垄断·收全区租金！）" : ""}（${cell.name}）`);
      return { action: null, cell, paidRent: rent };
    }
    if (cell.kind === "chance") return this._chance(pidx, depth);
    if (cell.kind === "tax") {
      const fee = Math.max(1500, Math.floor(p.cash / 10));
      p.cash = Math.max(0, p.cash - fee);
      this.pushLog(`🧾 ${p.name} 缴税 ¥${fee}`);
      return { action: null, cell, tax: fee };
    }
    if (cell.kind === "rest") {
      p.skip = true;
      this.pushLog(`🏖️ ${p.name} 到达度假村，下回合休息`);
      return { action: null, cell, rest: true };
    }
    if (cell.kind === "jail") {
      if (p.cash >= BAIL_COST) return { action: "jail_choice", cell };
      p.jail = JAIL_TURNS;
      this.pushLog(`🚔 ${p.name} 入狱服刑 ${JAIL_TURNS} 回合（交不起保释金）`);
      return { action: null, cell, jailed: true };
    }
    if (cell.kind === "hospital") {
      const fee = Math.min(p.cash, HOSPITAL_FEE);
      p.cash -= fee; p.skip = true;
      this.pushLog(`🏥 ${p.name} 住院，医药费 ¥${fee}，下回合休息`);
      return { action: null, cell, hospital: fee };
    }
    return { action: null, cell }; // start
  }

  _chance(pidx, depth) {
    const p = this.players[pidx];
    const r = this._rand();
    let acc = 0, evt = CHANCE_KEYS[0];
    const total = CHANCE_WEIGHTS.reduce((a, b) => a + b, 0);
    for (let i = 0; i < CHANCE_KEYS.length; i++) { acc += CHANCE_WEIGHTS[i] / total; if (r <= acc) { evt = CHANCE_KEYS[i]; break; } }
    const done = (event) => ({ action: null, cell: this.cells[p.pos], event });
    if (evt === "bonus") { p.cash += 4800; this.pushLog(`❓ ${p.name}：📈 股市大涨，+¥4800`); return done(); }
    if (evt === "fine") { p.cash = Math.max(0, p.cash - 3000); this.pushLog(`❓ ${p.name}：🧾 收到罚单，-¥3000`); return done(); }
    if (evt === "lottery") { p.cash += 9000; this.pushLog(`❓ ${p.name}：🎰 彩票中奖！+¥9000`); return done(); }
    if (evt === "robbed") { p.cash = Math.max(0, p.cash - 4800); this.pushLog(`❓ ${p.name}：🥷 深夜被抢，-¥4800`); return done(); }
    const steps = evt === "forward" ? 3 : -3;
    const label = evt === "forward" ? "🍀 好运降临，前进 3 格" : "🍌 踩到香蕉皮，后退 3 格";
    this.pushLog(`❓ ${p.name}：${label}`);
    const cell = this.movePlayer(pidx, steps);
    const res = { action: null, cell, event: label };
    if (depth < 2) res.chained = this.resolveLanding(pidx, cell, depth + 1);
    return res;
  }

  buy(pidx, cell) {
    const p = this.players[pidx];
    const price = this.priceOf(cell);
    if (cell.owner !== null || p.cash < price) return false;
    p.cash -= price; cell.owner = pidx;
    this.pushLog(`🏠 ${p.name} 买下「${cell.name}」（¥${price}）`);
    if (cell.district && this.monopoly(pidx, cell.district))
      this.pushLog(`👑 ${p.name} 垄断了${DISTRICTS[cell.district].flag}${DISTRICTS[cell.district].name}！踩中该区房产将收全区租金！`);
    return true;
  }
  upgrade(pidx, cell) {
    const p = this.players[pidx];
    const cost = this.upgradeCostOf(cell);
    if (cell.owner !== pidx || cell.level !== 0 || p.cash < cost) return false;
    p.cash -= cost; cell.level = 1;
    this.pushLog(`⭐ ${p.name} 升级了「${cell.name}」，租金 ¥${this.rentOf(cell)}`);
    return true;
  }
  payBail(pidx) {
    const p = this.players[pidx];
    if (p.cash < BAIL_COST) return false;
    p.cash -= BAIL_COST;
    this.pushLog(`💸 ${p.name} 交保释金 ¥${BAIL_COST} 出狱`);
    return true;
  }
  serveJail(pidx) {
    const p = this.players[pidx];
    p.jail = JAIL_TURNS;
    this.pushLog(`🔒 ${p.name} 选择坐满 ${JAIL_TURNS} 回合`);
  }

  // 回合开始时的自动跳过（坐牢/休息），返回 true 表示跳过
  autoSkip(pidx) {
    const p = this.players[pidx];
    if (p.jail > 0) { p.jail -= 1; this.pushLog(`🔒 ${p.name} 还在服刑（剩余 ${p.jail} 回合）`); return true; }
    if (p.skip) { p.skip = false; this.pushLog(`🏖️ ${p.name} 在度假村/医院休息，本回合跳过`); return true; }
    return false;
  }

  nextTurn() {
    this.turn = 1 - this.turn;
    if (this.turn === 0) {
      this.round += 1;
      if (this.round > MAX_ROUNDS && this.winner === null) {
        const a0 = this.assets(0), a1 = this.assets(1);
        this.winner = a0 > a1 ? 0 : a1 > a0 ? 1 : "draw";
        this.pushLog(`🏁 ${MAX_ROUNDS} 回合结束，${this.winner === "draw" ? "平局" : this.players[this.winner].name + " 总资产更高，获胜！"}`);
      }
    }
  }

  // ---- AI（单机模式） ----
  aiBuy(pidx, cell) { return this.players[pidx].cash - this.priceOf(cell) >= 12000; }
  aiUpgrade(pidx, cell) { return this.players[pidx].cash - this.upgradeCostOf(cell) >= 20000; }
  aiBail(pidx) { return this.players[pidx].cash - BAIL_COST >= 16000; }
}

export function cellGridPos(i, n = GRID_N) {
  if (i <= n - 1) return [0, i];
  if (i <= 2 * n - 2) return [i - n + 1, n - 1];
  if (i <= 3 * n - 3) return [n - 1, 3 * n - 3 - i];
  return [4 * n - 4 - i, 0];
}
