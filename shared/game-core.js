// game-core.js — 大富翁纯逻辑（无 DOM），Node / Workers / 浏览器通用
// v3: 世界城市地图 / 初始 3 万 / 无限回合（破产或投降结束）/ 同国房产租金叠加 / 最高3级
//     中转站（旅馆/公园/加油站/保险公司）/ 机会卡（免罚卡/嫁祸卡/特效药）

export const BOARD_SIZE = 36;
export const GRID_N = 10;
export const START_CASH = 30000;
export const SALARY = 5000;
export const JAIL_TURNS = 2;
export const BAIL_COST = 4800;
export const HOSPITAL_FEE = 4800;
export const MAX_LEVEL = 3;

// 中转站建筑：cost 建造费，toll 对手踩中过路费
export const HUB_BUILDINGS = {
  hotel:     { name: "旅馆",   emoji: "🏨", cost: 8000,  toll: 3000, desc: "对手强制停留3天" },
  park:      { name: "公园",   emoji: "🏞️", cost: 8000,  toll: 0,    desc: "名下房产租金+30%" },
  gas:       { name: "加油站", emoji: "⛽", cost: 10000, toll: 5000, desc: "对手下次掷骰+2" },
  insurance: { name: "保险公司", emoji: "🏦", cost: 10000, toll: 10000, desc: "对手3步内出事赔¥12000" },
};
export const PARK_RENT_BONUS = 0.3;
export const INSURANCE_PAYOUT = 12000;
export const INSURANCE_TURNS = 3;
export const HOTEL_STAY = 3;
export const GAS_BOOST = 2;

export const ITEM_DEFS = {
  jail_free: { name: "免罚卡", emoji: "🎫", desc: "进监狱时自动免罪" },
  frame:     { name: "嫁祸卡", emoji: "😈", desc: "回合内使用，对手进监狱" },
  medicine:  { name: "特效药", emoji: "💊", desc: "进医院时自动痊愈" },
};

export const TIERS = {
  A: { price: 2000,  rents: [900, 1800, 2700, 3600],     upgradeCost: 1500 },
  B: { price: 3500,  rents: [1950, 3900, 5850, 7800],   upgradeCost: 2500 },
  C: { price: 5000,  rents: [3000, 6000, 9000, 12000],   upgradeCost: 3500 },
};

export const DISTRICTS = {
  usa:   { name: "美国", flag: "🇺🇸", color: "#4da3ff", tint: "rgba(77,163,255,0.16)",  tier: "C" },
  china: { name: "中国", flag: "🇨🇳", color: "#ff6b6b", tint: "rgba(255,107,107,0.16)", tier: "B" },
  japan: { name: "日本", flag: "🇯🇵", color: "#ffa94d", tint: "rgba(255,169,77,0.16)",  tier: "B" },
  aus:   { name: "澳大利亚", flag: "🇦🇺", color: "#51cf66", tint: "rgba(81,207,102,0.16)", tier: "B" },
  uk:    { name: "英国", flag: "🇬🇧", color: "#b197fc", tint: "rgba(177,151,252,0.16)", tier: "A" },
  arg:   { name: "阿根廷", flag: "🇦🇷", color: "#3bc9db", tint: "rgba(59,201,219,0.16)", tier: "A" },
};

// [种类, 名字, 国家] —— 10x10 一圈 36 格
export const BOARD_DEF = [
  ["start",    "🏁 起点",   null],
  ["land",     "纽约",     "usa"],
  ["land",     "洛杉矶",   "usa"],
  ["chance",   "❓ 机会",  null],
  ["land",     "旧金山",   "usa"],
  ["tax",      "🧾 税务局", null],
  ["land",     "北京",     "china"],
  ["land",     "上海",     "china"],
  ["hub",      "🚉 中转站①", null],
  ["land",     "广州",     "china"],
  ["jail",     "🚔 监狱",  null],
  ["land",     "深圳",     "china"],
  ["land",     "东京",     "japan"],
  ["hospital", "🏥 医院",  null],
  ["land",     "大阪",     "japan"],
  ["chance",   "❓ 机会",  null],
  ["land",     "京都",     "japan"],
  ["land",     "札幌",     "japan"],
  ["land",     "悉尼",     "aus"],
  ["land",     "墨尔本",   "aus"],
  ["land",     "布里斯班", "aus"],
  ["chance",   "❓ 机会",  null],
  ["rest",     "🏖️ 度假村", null],
  ["land",     "伦敦",     "uk"],
  ["land",     "曼彻斯特", "uk"],
  ["hub",      "🚉 中转站②", null],
  ["land",     "爱丁堡",   "uk"],
  ["land",     "利物浦",   "uk"],
  ["land",     "布宜诺斯艾利斯", "arg"],
  ["land",     "科尔多瓦", "arg"],
  ["land",     "罗萨里奥", "arg"],
  ["chance",   "❓ 机会",  null],
  ["land",     "芝加哥",   "usa"],
  ["chance",   "❓ 机会",  null],
  ["tax",      "🧾 税务局", null],
  ["chance",   "❓ 机会",  null],
];

const CHANCE_KEYS = ["bonus", "fine", "forward", "back", "lottery", "robbed", "jail_free", "frame", "medicine"];
const CHANCE_WEIGHTS = [3, 3, 2, 2, 1, 1, 2, 2, 2];

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
  constructor(seed, nPlayers = 2) {
    this.seed = seed === undefined ? (Date.now() % 2147483647) : seed;
    this.rngCalls = 0;
    this.rng = mulberry32(this.seed);
    this.cells = BOARD_DEF.map(([kind, name, district]) => ({
      kind, name, district, owner: null, level: 0, building: null,
    }));
    this.players = [];
    for (let i = 0; i < Math.max(2, Math.min(8, nPlayers)); i++) {
      this.players.push({ name: `玩家${i + 1}`, cash: START_CASH, pos: 0, skip: false, jail: 0,
        bankrupt: false, eliminated: false, items: [], boost: 0, insured: null, hotelStay: 0 });
    }
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
      cells: this.cells.map(c => ({ owner: c.owner, level: c.level, building: c.building })),
      players: this.players.map(p => ({ ...p })),
      turn: this.turn, round: this.round, winner: this.winner,
      lastRoll: this.lastRoll, log: this.log.slice(-150),
    };
  }
  static fromJSON(d) {
    const g = new Game(d.seed);
    for (let i = 0; i < (d.rngCalls || 0); i++) g._rand(); // 快进 RNG，保证骰子不重播
    d.cells.forEach((c, i) => { g.cells[i].owner = c.owner; g.cells[i].level = c.level; g.cells[i].building = c.building || null; });
    g.players = d.players.map(p => ({ eliminated: false, items: [], boost: 0, insured: null, hotelStay: 0, ...p }));
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
  // 租金=该房主在该国所有房产的租金之和（有一处也算，不要求垄断）；有公园则+30%
  rentOf(cell) {
    if (cell.owner === null || !cell.district) return this.baseRentOf(cell);
    let total = 0;
    for (const c of this.cells)
      if (c.kind === "land" && c.district === cell.district && c.owner === cell.owner)
        total += this.baseRentOf(c);
    if (this.hasBuilding(cell.owner, "park")) total = Math.round(total * (1 + PARK_RENT_BONUS));
    return total;
  }
  hasBuilding(pidx, b) {
    return this.cells.some(c => c.kind === "hub" && c.owner === pidx && c.building === b);
  }
  districtPropCount(pidx, d) {
    return this.cells.filter(c => c.kind === "land" && c.district === d && c.owner === pidx).length;
  }
  assets(pidx) {
    const p = this.players[pidx];
    let total = p.cash;
    this.cells.forEach(c => {
      if (c.owner !== pidx) return;
      if (c.kind === "hub") total += HUB_BUILDINGS[c.building].cost;
      else total += this.priceOf(c) + this.upgradeCostOf(c) * c.level;
    });
    return total;
  }
  ownedCount(pidx) { return this.cells.filter(c => c.owner === pidx).length; }
  monopolyCount(pidx) { return Object.keys(DISTRICTS).filter(d => this.monopoly(pidx, d)).length; }

  // 双骰子：返回 {d1, d2, total, doubles, boosted}
  roll() {
    const p = this.players[this.turn];
    if (p.insured && p.insured.turns > 0) {
      p.insured.turns -= 1;
      if (p.insured.turns <= 0) { p.insured = null; this.pushLog(`🏦 ${p.name} 的保险到期了`); }
    }
    const d1 = 1 + Math.floor(this._rand() * 6);
    const d2 = 1 + Math.floor(this._rand() * 6);
    let total = d1 + d2, boosted = 0;
    if (p.boost > 0) { boosted = p.boost; total += boosted; p.boost = 0; this.pushLog(`⛽ ${p.name} 加速 +${boosted}！`); }
    this.lastRoll = [d1, d2];
    return { d1, d2, total, doubles: d1 === d2, boosted };
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
      if (cell.owner === pidx) return cell.level < MAX_LEVEL ? { action: "upgrade", cell } : { action: null, cell };
      const rent = this.rentOf(cell);
      const nProps = this.districtPropCount(cell.owner, cell.district);
      if (p.cash < rent) {
        this.eliminate(pidx, "bankrupt");
        return { action: null, cell, bankrupt: true };
      }
      p.cash -= rent; this.players[cell.owner].cash += rent;
      this.pushLog(`💰 ${p.name} 交租 ¥${rent}${nProps > 1 ? `（${cell.name}房主在该国${nProps}处房产）` : ""}（${cell.name}）`);
      return { action: null, cell, paidRent: rent };
    }
    if (cell.kind === "hub") {
      if (cell.owner === null) return { action: "buy_hub", cell };
      if (cell.owner === pidx) return { action: null, cell };
      const b = HUB_BUILDINGS[cell.building];
      const owner = this.players[cell.owner];
      if (b.toll > 0) {
        if (p.cash < b.toll) {
          this.eliminate(pidx, "bankrupt");
          this.pushLog(`💸 ${p.name} 付不起${b.name}过路费 ¥${b.toll}！`);
          return { action: null, cell, bankrupt: true };
        }
        p.cash -= b.toll; owner.cash += b.toll;
        this.pushLog(`💰 ${p.name} 支付${b.name}过路费 ¥${b.toll}`);
      }
      if (cell.building === "hotel") {
        p.hotelStay = HOTEL_STAY;
        this.pushLog(`🏨 ${p.name} 入住旅馆，强制停留 ${HOTEL_STAY} 天！`);
      } else if (cell.building === "gas") {
        p.boost = GAS_BOOST;
        this.pushLog(`⛽ ${p.name} 加满油，下次掷骰 +${GAS_BOOST}`);
      } else if (cell.building === "insurance") {
        p.insured = { turns: INSURANCE_TURNS, by: cell.owner };
        this.pushLog(`🏦 ${p.name} 获赠保险：${INSURANCE_TURNS}步内进监狱/医院/被抢，${owner.name}赔付 ¥${INSURANCE_PAYOUT}`);
      }
      return { action: null, cell, hub: cell.building };
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
      const fi = p.items.indexOf("jail_free");
      if (fi >= 0) {
        p.items.splice(fi, 1);
        this.pushLog(`🎫 ${p.name} 使用免罚卡，免于牢狱之灾！`);
        return { action: null, cell, usedCard: "jail_free" };
      }
      if (p.cash >= BAIL_COST) return { action: "jail_choice", cell };
      p.jail = JAIL_TURNS;
      this.pushLog(`🚔 ${p.name} 入狱服刑 ${JAIL_TURNS} 回合（交不起保释金）`);
      this._maybeInsurance(pidx, "入狱");
      return { action: null, cell, jailed: true };
    }
    if (cell.kind === "hospital") {
      const mi = p.items.indexOf("medicine");
      if (mi >= 0) {
        p.items.splice(mi, 1);
        this.pushLog(`💊 ${p.name} 服用特效药，瞬间痊愈！`);
        return { action: null, cell, usedCard: "medicine" };
      }
      const fee = Math.min(p.cash, HOSPITAL_FEE);
      p.cash -= fee; p.skip = true;
      this.pushLog(`🏥 ${p.name} 住院，医药费 ¥${fee}，下回合休息`);
      this._maybeInsurance(pidx, "住院");
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
    if (evt === "fine") { p.cash = Math.max(0, p.cash - 3000); this.pushLog(`❓ ${p.name}：🧾 收到罚单，-¥3000`); this._maybeInsurance(pidx, "被罚款"); return done(); }
    if (evt === "lottery") { p.cash += 9000; this.pushLog(`❓ ${p.name}：🎰 彩票中奖！+¥9000`); return done(); }
    if (evt === "robbed") { p.cash = Math.max(0, p.cash - 4800); this.pushLog(`❓ ${p.name}：🥷 深夜被抢，-¥4800`); this._maybeInsurance(pidx, "被抢劫"); return done(); }
    if (evt === "jail_free") { p.items.push("jail_free"); this.pushLog(`❓ ${p.name}：🎫 获得【免罚卡】！进监狱时自动免罪`); return done(); }
    if (evt === "frame") { p.items.push("frame"); this.pushLog(`❓ ${p.name}：😈 获得【嫁祸卡】！回合内可使用，让对手进监狱`); return done(); }
    if (evt === "medicine") { p.items.push("medicine"); this.pushLog(`❓ ${p.name}：💊 获得【特效药】！进医院时自动痊愈`); return done(); }
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
    if (cell.district && this.monopoly(pidx, cell.district)) {
      const n = this.districtCells(cell.district).length;
      this.pushLog(`👑 ${p.name} 集齐了${DISTRICTS[cell.district].flag}${DISTRICTS[cell.district].name}${n}城！`);
    }
    return true;
  }
  upgrade(pidx, cell) {
    const p = this.players[pidx];
    const cost = this.upgradeCostOf(cell);
    if (cell.owner !== pidx || cell.level >= MAX_LEVEL || p.cash < cost) return false;
    p.cash -= cost; cell.level += 1;
    this.pushLog(`⭐ ${p.name} 升级了「${cell.name}」${"⭐".repeat(cell.level)}，租金 ¥${this.rentOf(cell)}`);
    return true;
  }
  // 中转站建造
  buildHub(pidx, cell, building) {
    const p = this.players[pidx];
    const b = HUB_BUILDINGS[building];
    if (!b || cell.kind !== "hub" || cell.owner !== null || p.cash < b.cost) return false;
    p.cash -= b.cost; cell.owner = pidx; cell.building = building;
    this.pushLog(`${b.emoji} ${p.name} 在${cell.name}建造了【${b.name}】（¥${b.cost}）${b.toll ? `，过路费 ¥${b.toll}` : ""}`);
    return true;
  }
  // 嫁祸卡：指定对手进监狱（对方有免罚卡则抵挡）
  useFrame(pidx, target) {
    const p = this.players[pidx];
    const t = this.players[target];
    const fi = p.items.indexOf("frame");
    if (fi < 0 || this.winner !== null || !t || target === pidx || t.eliminated) return false;
    p.items.splice(fi, 1);
    const gi = t.items.indexOf("jail_free");
    if (gi >= 0) {
      t.items.splice(gi, 1);
      this.pushLog(`😈 ${p.name} 想嫁祸 ${t.name}，${t.name}亮出免罚卡躲过一劫！`);
      return true;
    }
    t.jail = JAIL_TURNS;
    this.pushLog(`😈 ${p.name} 使用嫁祸卡！${t.name} 被关进监狱 ${JAIL_TURNS} 回合`);
    return true;
  }
  // 保险理赔：3步内出事，保险公司店主赔付（一次性，不会赔到破产）
  _maybeInsurance(pidx, reason) {
    const p = this.players[pidx];
    if (!p.insured || this.winner !== null) return;
    const owner = this.players[p.insured.by];
    const pay = Math.min(INSURANCE_PAYOUT, owner.cash);
    owner.cash -= pay; p.cash += pay;
    p.insured = null;
    this.pushLog(`🏦 保险理赔！${p.name}${reason}，${owner.name}赔付 ¥${pay}`);
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
    this._maybeInsurance(pidx, "入狱服刑");
  }

  // 回合开始时的自动跳过（坐牢/旅馆/休息），返回 true 表示跳过
  autoSkip(pidx) {
    const p = this.players[pidx];
    if (p.jail > 0) { p.jail -= 1; this.pushLog(`🔒 ${p.name} 还在服刑（剩余 ${p.jail} 回合）`); return true; }
    if (p.hotelStay > 0) { p.hotelStay -= 1; this.pushLog(`🏨 ${p.name} 在旅馆休息（剩余 ${p.hotelStay} 天）`); return true; }
    if (p.skip) { p.skip = false; this.pushLog(`🏖️ ${p.name} 在度假村/医院休息，本回合跳过`); return true; }
    return false;
  }

  nextTurn() {
    if (this.winner !== null) return;
    const n = this.players.length;
    let steps = 0;
    while (steps++ <= n) {
      const prev = this.turn;
      this.turn = (this.turn + 1) % n;
      if (this.turn < prev) this.round += 1; // 绕回一圈
      if (!this.players[this.turn].eliminated) break;
    }
    this._checkWin();
  }

  aliveSeats() {
    const r = [];
    this.players.forEach((p, i) => { if (!p.eliminated) r.push(i); });
    return r;
  }
  _checkWin() {
    if (this.winner !== null) return;
    const alive = this.aliveSeats();
    if (alive.length === 1) {
      this.winner = alive[0];
      this.pushLog(`🏆 ${this.players[this.winner].name} 是最后的幸存者，赢得比赛！`);
    }
  }
  // 淘汰（破产/投降/离开）：最后一人存活即获胜
  eliminate(pidx, reason = "bankrupt") {
    const p = this.players[pidx];
    if (this.winner !== null || p.eliminated) return false;
    p.eliminated = true; p.bankrupt = true;
    const label = reason === "surrender" ? "🏳️" : reason === "leave" ? "🚪" : "💸";
    const verb = reason === "surrender" ? "投降" : reason === "leave" ? "离开游戏" : "破产";
    this.pushLog(`${label} ${p.name}${verb}，被淘汰出局！`);
    this._checkWin();
    return true;
  }

  // 投降：算淘汰
  surrender(pidx) {
    return this.eliminate(pidx, "surrender");
  }

  // ---- AI（单机模式） ----
  aiBuy(pidx, cell) { return this.players[pidx].cash - this.priceOf(cell) >= 12000; }
  aiUpgrade(pidx, cell) { return this.players[pidx].cash - this.upgradeCostOf(cell) >= 20000; }
  aiBail(pidx) { return this.players[pidx].cash - BAIL_COST >= 16000; }
  aiHubBuilding(pidx) {
    const cash = this.players[pidx].cash;
    for (const key of ["insurance", "gas", "hotel", "park"])
      if (cash - HUB_BUILDINGS[key].cost >= 15000) return key;
    return null;
  }
  aiUseFrame(pidx) { return this.players[pidx].items.includes("frame") && this._rand() < 0.4; }
}

export function cellGridPos(i, n = GRID_N) {
  if (i <= n - 1) return [0, i];
  if (i <= 2 * n - 2) return [i - n + 1, n - 1];
  if (i <= 3 * n - 3) return [n - 1, 3 * n - 3 - i];
  return [4 * n - 4 - i, 0];
}
