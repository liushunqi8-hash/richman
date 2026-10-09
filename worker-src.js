// worker-src.js — Cloudflare Worker：发游戏页面 + Durable Object 联机房间
import { DurableObject } from "cloudflare:workers";

/*__GAME_CORE__*/

const CLIENT_HTML = "__CLIENT_HTML_JSON__";

const AVATAR_IDS = ["astro", "fox", "panda", "robot"];

function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map(p => ({ name: p.name, avatar: p.avatar, seat: p.seat, connected: p.connected })),
    game: room.game,
    awaiting: room.awaiting,
    lastDice: room.lastDice || null,
    lastDoubles: !!room.lastDoubles,
  };
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; }

  async _load() { return (await this.ctx.storage.get("room")) || null; }
  async _save(room) { await this.ctx.storage.put("room", room); }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const code = (url.searchParams.get("room") || "").toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return new Response("bad room code", { status: 400 });
    const name = (url.searchParams.get("name") || "玩家").slice(0, 12) || "玩家";
    const av = url.searchParams.get("avatar");
    const avatar = AVATAR_IDS.includes(av) ? av : "astro";
    const pid = url.searchParams.get("pid") || crypto.randomUUID();

    let room = await this._load();
    const wantCreate = url.searchParams.get("create") === "1";
    if (!room && !wantCreate) return new Response("房间不存在，请检查房号", { status: 404 });
    if (!room) room = { code, players: [], game: null, phase: "lobby", awaiting: null, createdAt: Date.now() };
    let me = room.players.find(p => p.id === pid);
    if (!me) {
      if (room.players.length >= 5) return new Response("房间已满（最多5人）", { status: 403 });
      if (room.phase !== "lobby") return new Response("游戏已开始，无法加入", { status: 403 });
      me = { id: pid, name, avatar, seat: room.players.length, connected: true };
      room.players.push(me);
    } else {
      me.connected = true; me.name = name; me.avatar = avatar;
    }
    room.lastActionAt = Date.now();
    await this._save(room);

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid });
    server.send(JSON.stringify({ t: "hello", seat: me.seat, pid, code }));
    this._broadcast(room);
    return new Response(null, { status: 101, webSocket: client });
  }

  _broadcast(room) {
    const msg = JSON.stringify({ t: "state", room: publicRoom(room) });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch (e) { /* ignore */ }
    }
    // 断线托管闹钟：对局中每45秒检查一次
    try {
      if (room.phase === "playing") this.ctx.storage.setAlarm(Date.now() + 45000).catch(() => {});
      else this.ctx.storage.deleteAlarm().catch(() => {});
    } catch (e) { /* ignore */ }
  }

  // 闹钟：轮到断线玩家且45秒无行动 → 简单托管代打
  async alarm() {
    const room = await this._load();
    if (!room || room.phase !== "playing" || !room.game) return;
    const g = Game.fromJSON(room.game);
    if (g.winner !== null) return;
    const me = room.players[g.turn];
    if (!me || me.connected) return;
    if (Date.now() - (room.lastActionAt || 0) < 40000) return;
    this._autoTurn(room, g);
    room.game = g.toJSON();
    room.lastActionAt = Date.now();
    room.awaiting = null;
    if (g.winner !== null) room.phase = "over";
    await this._save(room);
    this._broadcast(room);
  }

  _autoDecide(g, seat, action, cell) {
    if (action === "buy") { if (g.aiBuy(seat, cell)) g.buy(seat, cell); }
    else if (action === "buy_hub") { const b = g.aiHubBuilding(seat); if (b) g.buildHub(seat, cell, b); }
    else if (action === "upgrade") { if (g.aiUpgrade(seat, cell)) g.upgrade(seat, cell); }
    else if (action === "jail_choice") { if (g.aiBail(seat)) g.payBail(seat); else g.serveJail(seat); }
  }
  // 断线玩家的一回合：掷骰+简单决策，出局则跳过
  _autoTurn(room, g) {
    const seat = g.turn;
    if (room.awaiting && room.awaiting.seat === seat) {
      const cell = g.cells[room.awaiting.cellIdx];
      this._autoDecide(g, seat, room.awaiting.kind, cell);
      room.awaiting = null;
      g.nextTurn();
    } else {
      let guard = 0;
      while (g.winner === null && guard++ < 6) {
        if (g.autoSkip(seat)) break;
        const r = g.roll();
        const who = g.players[seat].name;
        g.pushLog(`🎲 ${who}（断线托管）掷出 ${r.d1}、${r.d2}（${r.total}点）${r.doubles ? "双骰！再掷一次！" : ""}`);
        const cell = g.movePlayer(seat, r.total);
        let res = g.resolveLanding(seat, cell);
        const wentJail = res.action === "jail_choice" || !!res.jailed;
        let gd = 0;
        while (res && (res.action || res.chained) && gd++ < 8 && g.winner === null) {
          if (res.action) this._autoDecide(g, seat, res.action, res.cell);
          res = res.chained || null;
        }
        if (g.winner !== null) break;
        const pl = g.players[seat];
        if (r.doubles && !wentJail && pl.jail === 0 && !pl.bankrupt) continue;
        break;
      }
      if (g.winner === null) g.nextTurn();
    }
    room.lastDoubles = false; room.rolled = false; room.lastDice = g.lastRoll;
  }

  // 处理结算结果（支持连锁），设置 awaiting
  _settle(g, room, res) {
    if (res.bankrupt) { room.awaiting = null; return; }
    if (res.chained) { this._settle(g, room, res.chained); if (room.awaiting || g.winner !== null) return; }
    if (res.action) {
      room.awaiting = { seat: g.turn, kind: res.action, cellIdx: g.cells.indexOf(res.cell) };
    } else {
      room.awaiting = null;
    }
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment() || {};
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }
    // 心跳：直接回 pong，不碰 storage
    if (msg.t === "ping") { try { ws.send(JSON.stringify({ t: "pong" })); } catch (e) { /* ignore */ } return; }
    const room = await this._load();
    if (!room) return;
    const me = room.players.find(p => p.id === att.pid);
    if (!me) return;
    room.lastActionAt = Date.now();
    const err = (m) => { try { ws.send(JSON.stringify({ t: "error", msg: m })); } catch (e) { /* ignore */ } };

    if (msg.t === "leave") {
      me.connected = false;
      if (room.phase === "playing" && room.game) {
        const g = Game.fromJSON(room.game);
        if (g.winner === null && !g.players[me.seat].eliminated) {
          g.eliminate(me.seat, "leave");
          if (g.winner === null && g.turn === me.seat) g.nextTurn();
          room.game = g.toJSON(); room.awaiting = null;
          if (g.winner !== null) room.phase = "over";
        }
      } else if (room.phase === "lobby") {
        room.players = room.players.filter(p => p.id !== me.id);
        room.players.forEach((p, i) => { p.seat = i; });
      }
      await this._save(room);
      try { ws.close(1000, "left"); } catch (e) { /* ignore */ }
      return this._broadcast(room);
    }

    if (msg.t === "start") {
      if (me.seat !== 0) return err("只有房主可以开始");
      if (room.players.length < 2) return err("至少2人才能开始…");
      if (room.phase !== "lobby") return err("游戏已经开始");
      const g = new Game(undefined, room.players.length);
      room.players.forEach((p, i) => { g.players[i].name = p.name; });
      g.pushLog(`🎲 游戏开始！${g.players[0].name} 先手。${room.players.length}人对战，经过起点 +¥${SALARY}，同国房产租金叠加，无限回合直到最后一人存活。`);
      room.game = g.toJSON(); room.phase = "playing"; room.awaiting = null;
      room.lastDoubles = false; room.rolled = false; room.lastDice = null;
      await this._save(room);
      return this._broadcast(room);
    }

    if (room.phase !== "playing" || !room.game) return err("游戏未开始");
    const g = Game.fromJSON(room.game);
    if (g.players[me.seat].eliminated) return err("你已被淘汰，观战中");

    if (msg.t === "roll") {
      if (g.winner !== null) return err("游戏已结束");
      if (g.turn !== me.seat) return err("还没轮到你");
      if (room.awaiting) return err("请先做决定");
      if (room.rolled && !room.lastDoubles) return err("本回合已经掷过骰子");
      const seat = g.turn;
      if (g.autoSkip(seat)) {
        room.game = g.toJSON(); room.rolled = false; room.lastDoubles = false;
        await this._save(room); return this._broadcast(room);
      }
      const r = g.roll();
      const who = g.players[seat].name;
      g.pushLog(`🎲 ${who} 掷出 ${r.d1}、${r.d2}（${r.total}点）${r.doubles ? "双骰！再掷一次！" : ""}`);
      const cell = g.movePlayer(seat, r.total);
      const res = g.resolveLanding(seat, cell);
      this._settle(g, room, res);
      room.rolled = true;
      room.lastDice = [r.d1, r.d2];
      const pl = g.players[seat];
      const forfeited = res.action === "jail_choice" || !!res.jailed;
      room.lastDoubles = r.doubles && !forfeited && g.winner === null && !pl.bankrupt && pl.jail === 0;
      room.game = g.toJSON();
      if (g.winner !== null) room.phase = "over";
      await this._save(room);
      return this._broadcast(room);
    }

    if (msg.t === "use_frame") {
      if (g.turn !== me.seat || room.awaiting || g.winner !== null) return err("现在不能用嫁祸卡");
      const target = msg.target;
      if (typeof target !== "number" || target === me.seat || target < 0 || target >= g.players.length)
        return err("嫁祸目标无效");
      if (g.players[target].eliminated) return err("对方已出局");
      if (!g.useFrame(me.seat, target)) return err("使用失败");
      room.game = g.toJSON();
      await this._save(room);
      return this._broadcast(room);
    }

    if (["buy", "skip_buy", "upgrade", "skip_upgrade", "bail", "serve", "buy_hub", "skip_hub"].includes(msg.t)) {
      if (!room.awaiting || room.awaiting.seat !== me.seat) return err("现在不能做这个决定");
      const kind = room.awaiting.kind;
      const cell = g.cells[room.awaiting.cellIdx];
      const seat = me.seat;
      let done = false;
      if (msg.t === "buy" && kind === "buy") done = g.buy(seat, cell);
      else if (msg.t === "skip_buy" && kind === "buy") { g.pushLog(`🚶 ${g.players[seat].name} 放弃购买「${cell.name}」`); done = true; }
      else if (msg.t === "upgrade" && kind === "upgrade") done = g.upgrade(seat, cell);
      else if (msg.t === "skip_upgrade" && kind === "upgrade") { g.pushLog(`🚶 ${g.players[seat].name} 跳过升级`); done = true; }
      else if (msg.t === "bail" && kind === "jail_choice") done = g.payBail(seat);
      else if (msg.t === "serve" && kind === "jail_choice") { g.serveJail(seat); done = true; }
      else if (msg.t === "buy_hub" && kind === "buy_hub") done = g.buildHub(seat, cell, msg.building);
      else if (msg.t === "skip_hub" && kind === "buy_hub") { g.pushLog(`🚶 ${g.players[seat].name} 放弃了${cell.name}`); done = true; }
      if (!done) return err("操作失败（现金不足？）");
      room.awaiting = null;
      room.game = g.toJSON();
      if (g.winner !== null) room.phase = "over";
      await this._save(room);
      return this._broadcast(room);
    }

    if (msg.t === "end_turn") {
      if (g.turn !== me.seat) return err("还没轮到你");
      if (room.awaiting) return err("请先做决定");
      if (g.winner !== null) return err("游戏已结束");
      g.nextTurn();
      let guard = 0;
      while (g.winner === null && g.autoSkip(g.turn) && guard++ < 12) g.nextTurn();
      room.game = g.toJSON();
      room.lastDoubles = false; room.rolled = false;
      if (g.winner !== null) room.phase = "over";
      await this._save(room);
      return this._broadcast(room);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const att = ws.deserializeAttachment() || {};
    const room = await this._load();
    if (!room) return;
    const me = room.players.find(p => p.id === att.pid);
    if (me) { me.connected = false; await this._save(room); this._broadcast(room); }
  }

  async webSocketError(ws, error) { /* ignore */ }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/ws") {
      const code = (url.searchParams.get("room") || "").toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) return new Response("bad room code", { status: 400 });
      const id = env.ROOMS.idFromName(code);
      return env.ROOMS.get(id).fetch(request);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(CLIENT_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  }
};
