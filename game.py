# -*- coding: utf-8 -*-
"""大富翁 Richman - 纯 Python 版大富翁游戏（浏览器里通过 Pyodide 运行）.

v2: 28 格大地图 / 初始资金 5 万 / 街区垄断租金翻倍 / 监狱 / 医院 / 随机事件.
游戏逻辑与 UI 分离：Game/Cell/Player 是纯逻辑，可在 CPython 下测试；
UI 部分只在浏览器里执行（IN_BROWSER 为 True 时）。
"""
import random

try:
    from js import document, window  # noqa
    from pyodide.ffi import create_proxy  # noqa
    IN_BROWSER = True
except ImportError:  # 本地测试环境
    IN_BROWSER = False

BOARD_SIZE = 28
GRID_N = 8               # 8x8 环形棋盘
START_CASH = 50000
SALARY = 10000           # 经过起点工资
MAX_ROUNDS = 30
JAIL_TURNS = 2
BAIL_COST = 8000
HOSPITAL_FEE = 8000
MONOPOLY_MULT = 2        # 垄断整个街区：租金翻倍

TIERS = {
    "A": {"price": 10000, "rents": [1500, 3500],   "upgrade_cost": 7500},
    "B": {"price": 17500, "rents": [3250, 7000],   "upgrade_cost": 12500},
    "C": {"price": 25000, "rents": [5000, 11000],  "upgrade_cost": 17500},
}

DISTRICTS = {
    "red":    {"name": "红区", "color": "#ff6b6b", "tint": "rgba(255,107,107,0.16)",  "tier": "A"},
    "orange": {"name": "橙区", "color": "#ffa94d", "tint": "rgba(255,169,77,0.16)",   "tier": "B"},
    "blue":   {"name": "蓝区", "color": "#4da3ff", "tint": "rgba(77,163,255,0.16)",   "tier": "B"},
    "purple": {"name": "紫区", "color": "#b197fc", "tint": "rgba(177,151,252,0.16)",  "tier": "C"},
}

# 棋盘定义：(种类, 名字, 街区)
BOARD_DEF = [
    ("start",    "起点",   None),
    ("land",     "红区·东", "red"),
    ("land",     "红区·西", "red"),
    ("chance",   "机会",   None),
    ("land",     "红区·南", "red"),
    ("tax",      "税务局", None),
    ("land",     "橙区·南", "orange"),
    ("land",     "橙区·北", "orange"),
    ("chance",   "机会",   None),
    ("land",     "橙区·东", "orange"),
    ("jail",     "监狱",   None),
    ("land",     "橙区·西", "orange"),
    ("land",     "蓝区·南", "blue"),
    ("hospital", "医院",   None),
    ("land",     "蓝区·北", "blue"),
    ("chance",   "机会",   None),
    ("land",     "蓝区·东", "blue"),
    ("land",     "蓝区·西", "blue"),
    ("rest",     "度假村", None),
    ("land",     "紫区·南", "purple"),
    ("land",     "紫区·北", "purple"),
    ("chance",   "机会",   None),
    ("land",     "紫区·东", "purple"),
    ("land",     "紫区·西", "purple"),
    ("land",     "红区·北", "red"),
    ("chance",   "机会",   None),
    ("tax",      "税务局", None),
    ("chance",   "机会",   None),
]

CHANCE_EVENTS = [  # (key, 权重)
    ("bonus", 3),
    ("fine", 3),
    ("forward", 2),
    ("back", 2),
    ("lottery", 1),
    ("robbed", 1),
]


class Cell:
    def __init__(self, kind, name, district):
        self.kind = kind
        self.name = name
        self.district = district
        self.owner = None   # None / 0 / 1
        self.level = 0      # 0 未升级，1 已升级

    @property
    def tier(self):
        return DISTRICTS[self.district]["tier"] if self.district else None

    @property
    def price(self):
        return TIERS[self.tier]["price"] if self.tier else 0

    @property
    def upgrade_cost(self):
        return TIERS[self.tier]["upgrade_cost"] if self.tier else 0

    def base_rent(self):
        return TIERS[self.tier]["rents"][self.level] if self.tier else 0


class Player:
    def __init__(self, name):
        self.name = name
        self.cash = START_CASH
        self.pos = 0
        self.skip = False
        self.jail = 0          # 剩余坐牢回合数
        self.bankrupt = False


class Game:
    def __init__(self, seed=None):
        self.rng = random.Random(seed)
        self.cells = [Cell(k, n, d) for k, n, d in BOARD_DEF]
        self.players = [Player("你"), Player("电脑")]
        self.turn = 0          # 0 你，1 电脑
        self.round = 1
        self.winner = None     # None / 0 / 1 / "draw"
        self.last_roll = None

    # ---------- 基础 ----------
    def roll(self):
        self.last_roll = self.rng.randint(1, 6)
        return self.last_roll

    def move_player(self, pidx, steps):
        """移动并结算过起点工资，返回落点格子。"""
        p = self.players[pidx]
        if p.pos + steps >= BOARD_SIZE:
            p.cash += SALARY
        p.pos = (p.pos + steps) % BOARD_SIZE
        return self.cells[p.pos]

    def district_cells(self, district):
        return [c for c in self.cells if c.district == district]

    def monopoly(self, pidx, district):
        """是否垄断整个街区。"""
        cells = self.district_cells(district)
        return bool(cells) and all(c.owner == pidx for c in cells)

    def rent_for(self, cell):
        """当前租金（含垄断加成）。"""
        rent = cell.base_rent()
        if cell.owner is not None and self.monopoly(cell.owner, cell.district):
            rent *= MONOPOLY_MULT
        return rent

    def assets(self, pidx):
        p = self.players[pidx]
        total = p.cash
        for c in self.cells:
            if c.owner == pidx:
                total += c.price
                if c.level:
                    total += c.upgrade_cost
        return total

    def owned_count(self, pidx):
        return sum(1 for c in self.cells if c.owner == pidx)

    def monopoly_count(self, pidx):
        return sum(1 for d in DISTRICTS if self.monopoly(pidx, d))

    # ---------- 落点结算 ----------
    def resolve_landing(self, pidx, cell, depth=0):
        """结算落点。返回需要玩家决策的动作。"""
        p = self.players[pidx]
        if cell.kind == "land":
            if cell.owner is None:
                return {"action": "buy", "cell": cell}
            if cell.owner == pidx:
                if cell.level == 0:
                    return {"action": "upgrade", "cell": cell}
                return {"action": None, "cell": cell}
            rent = self.rent_for(cell)
            if p.cash < rent:
                p.bankrupt = True
                self.winner = 1 - pidx
                return {"action": None, "cell": cell, "bankrupt": True}
            p.cash -= rent
            self.players[cell.owner].cash += rent
            mono = "（垄断×2！）" if self.monopoly(cell.owner, cell.district) else ""
            return {"action": None, "cell": cell, "paid_rent": rent, "mono": mono}
        if cell.kind == "chance":
            return self._chance(pidx, depth)
        if cell.kind == "tax":
            fee = max(2500, p.cash // 10)
            p.cash = max(0, p.cash - fee)
            return {"action": None, "cell": cell, "tax": fee}
        if cell.kind == "rest":
            p.skip = True
            return {"action": None, "cell": cell, "rest": True}
        if cell.kind == "jail":
            if p.cash >= BAIL_COST:
                return {"action": "jail_choice", "cell": cell}
            p.jail = JAIL_TURNS
            return {"action": None, "cell": cell, "jailed": True, "no_bail": True}
        if cell.kind == "hospital":
            fee = min(p.cash, HOSPITAL_FEE)
            p.cash -= fee
            p.skip = True
            return {"action": None, "cell": cell, "hospital": fee}
        return {"action": None, "cell": cell}  # start

    def _chance(self, pidx, depth):
        p = self.players[pidx]
        keys = [k for k, _ in CHANCE_EVENTS]
        weights = [w for _, w in CHANCE_EVENTS]
        evt = self.rng.choices(keys, weights=weights)[0]
        if evt == "bonus":
            p.cash += 8000
            return {"action": None, "cell": self.cells[p.pos], "event": "📈 股市大涨，+¥8000"}
        if evt == "fine":
            p.cash = max(0, p.cash - 5000)
            return {"action": None, "cell": self.cells[p.pos], "event": "🧾 收到罚单，-¥5000"}
        if evt == "lottery":
            p.cash += 15000
            return {"action": None, "cell": self.cells[p.pos], "event": "🎰 彩票中奖！+¥15000"}
        if evt == "robbed":
            p.cash = max(0, p.cash - 8000)
            return {"action": None, "cell": self.cells[p.pos], "event": "🥷 深夜被抢，-¥8000"}
        steps = 3 if evt == "forward" else -3
        label = "🍀 好运降临，前进 3 格" if evt == "forward" else "🍌 踩到香蕉皮，后退 3 格"
        cell = self.move_player(pidx, steps)
        res = {"action": None, "cell": cell, "event": label}
        if depth < 2:
            sub = self.resolve_landing(pidx, cell, depth + 1)
            res["chained"] = sub
        return res

    # ---------- 决策 ----------
    def buy(self, pidx, cell):
        p = self.players[pidx]
        if cell.owner is not None or p.cash < cell.price:
            return False
        p.cash -= cell.price
        cell.owner = pidx
        return True

    def upgrade(self, pidx, cell):
        p = self.players[pidx]
        if cell.owner != pidx or cell.level != 0 or p.cash < cell.upgrade_cost:
            return False
        p.cash -= cell.upgrade_cost
        cell.level = 1
        return True

    def pay_bail(self, pidx):
        p = self.players[pidx]
        if p.cash < BAIL_COST:
            return False
        p.cash -= BAIL_COST
        return True

    def serve_jail(self, pidx):
        self.players[pidx].jail = JAIL_TURNS

    def next_turn(self):
        self.turn = 1 - self.turn
        if self.turn == 0:
            self.round += 1
            if self.round > MAX_ROUNDS and self.winner is None:
                a0, a1 = self.assets(0), self.assets(1)
                if a0 > a1:
                    self.winner = 0
                elif a1 > a0:
                    self.winner = 1
                else:
                    self.winner = "draw"

    # ---------- 电脑 AI ----------
    def ai_decide_buy(self, pidx, cell):
        return self.players[pidx].cash - cell.price >= 15000

    def ai_decide_upgrade(self, pidx, cell):
        return self.players[pidx].cash - cell.upgrade_cost >= 25000

    def ai_decide_bail(self, pidx):
        return self.players[pidx].cash - BAIL_COST >= 20000


# ================= UI（仅浏览器） =================
_proxies = []

CELL_EMOJI = {"start": "🏁", "land": "🏠", "chance": "❓", "tax": "🧾",
              "rest": "🏖️", "jail": "🚔", "hospital": "🏥"}
OWNER_COLOR = {0: "#4da3ff", 1: "#ff6b6b"}


def cell_grid_pos(i):
    """28 格环形棋盘映射到 8x8 网格（顺时针，从左上开始）。"""
    n = GRID_N
    if i <= n - 1:
        return (0, i)
    if i <= 2 * n - 2:
        return (i - n + 1, n - 1)
    if i <= 3 * n - 3:
        return (n - 1, 3 * n - 3 - i)
    return (4 * n - 4 - i, 0)


class UI:
    def __init__(self, game):
        self.g = game
        self.log_lines = []
        self._build_layout()
        self.render()
        self.log("🎲 游戏开始！你先手，点击「掷骰子」。经过起点 +¥10000，垄断整个街区租金翻倍，30 回合后比总资产。")

    # ----- 布局 -----
    def _build_layout(self):
        root = document.getElementById("app")

        title = document.createElement("h1")
        title.textContent = "💰 大富翁 Richman"
        root.appendChild(title)
        sub = document.createElement("p")
        sub.id = "subtitle"
        sub.textContent = "纯 Python 驱动 · 跑在 Pyodide 上"
        root.appendChild(sub)

        wrap = document.createElement("div")
        wrap.id = "wrap"
        root.appendChild(wrap)

        board = document.createElement("div")
        board.id = "board"
        wrap.appendChild(board)
        self.board_el = board

        side = document.createElement("div")
        side.id = "side"
        wrap.appendChild(side)

        self.dice_btn = self._btn("🎲 掷骰子", self.on_dice)
        side.appendChild(self.dice_btn)

        self.action_el = document.createElement("div")
        self.action_el.id = "actions"
        side.appendChild(self.action_el)

        self.stats_el = document.createElement("div")
        self.stats_el.id = "stats"
        side.appendChild(self.stats_el)

        log_title = document.createElement("h3")
        log_title.textContent = "📜 战报"
        side.appendChild(log_title)
        self.log_el = document.createElement("div")
        self.log_el.id = "log"
        side.appendChild(self.log_el)

    def _btn(self, text, handler):
        b = document.createElement("button")
        b.textContent = text
        b.className = "btn"
        px = create_proxy(handler)
        _proxies.append(px)
        b.addEventListener("click", px)
        return b

    # ----- 日志 -----
    def log(self, msg):
        self.log_lines.append(msg)
        self.log_lines = self.log_lines[-150:]
        self.log_el.innerHTML = ""
        for line in reversed(self.log_lines):
            d = document.createElement("div")
            d.textContent = line
            self.log_el.appendChild(d)

    # ----- 渲染 -----
    def render(self):
        self._render_board()
        self._render_stats()

    def _render_board(self):
        b = self.board_el
        b.innerHTML = ""
        for i, cell in enumerate(self.g.cells):
            r, c = cell_grid_pos(i)
            d = document.createElement("div")
            d.className = "cell"
            d.style.gridRow = str(r + 1)
            d.style.gridColumn = str(c + 1)
            if cell.district:
                d.style.background = DISTRICTS[cell.district]["tint"]
            if cell.owner is not None:
                d.style.borderColor = OWNER_COLOR[cell.owner]
                d.style.borderWidth = "3px"

            name = document.createElement("div")
            name.className = "cname"
            crown = ""
            if cell.district and cell.owner is not None and self.g.monopoly(cell.owner, cell.district):
                crown = "👑"
            name.textContent = f"{CELL_EMOJI[cell.kind]}{crown}{cell.name}"
            d.appendChild(name)

            info = document.createElement("div")
            info.className = "cinfo"
            if cell.kind == "land":
                stars = "⭐" if cell.level else ""
                info.textContent = f"¥{cell.price // 1000}k{stars}"
            d.appendChild(info)

            tokens = document.createElement("div")
            tokens.className = "tokens"
            for pi, p in enumerate(self.g.players):
                if p.pos == i and not p.bankrupt:
                    t = document.createElement("span")
                    t.className = "token"
                    t.style.background = OWNER_COLOR[pi]
                    mark = "🔒" if p.jail > 0 else ("你" if pi == 0 else "电")
                    t.textContent = mark
                    tokens.appendChild(t)
            d.appendChild(tokens)
            b.appendChild(d)

    def _render_stats(self):
        s = self.stats_el
        s.innerHTML = ""
        for pi, p in enumerate(self.g.players):
            d = document.createElement("div")
            d.className = "pstat"
            who = "🧑 你" if pi == 0 else "🤖 电脑"
            t = document.createElement("b")
            t.textContent = who
            d.appendChild(t)
            rows = [("现金", f"¥{p.cash}"),
                    ("地产", f"{self.g.owned_count(pi)} 块"),
                    ("垄断", f"{self.g.monopoly_count(pi)} 个街区"),
                    ("总资产", f"¥{self.g.assets(pi)}")]
            if p.jail > 0:
                rows.append(("状态", f"🔒服刑中（{p.jail}回合）"))
            for label, val in rows:
                row = document.createElement("div")
                row.textContent = f"{label}：{val}"
                d.appendChild(row)
            s.appendChild(d)
        rd = document.createElement("div")
        rd.id = "round"
        rd.textContent = f"第 {min(self.g.round, MAX_ROUNDS)} / {MAX_ROUNDS} 回合"
        s.appendChild(rd)

    # ----- 回合流程 -----
    def _turn_blocked(self, pidx):
        """坐牢/休息检查，返回 True 表示本回合跳过。"""
        p = self.g.players[pidx]
        who = "你" if pidx == 0 else "电脑"
        if p.jail > 0:
            p.jail -= 1
            self.log(f"🔒 {who}还在服刑（剩余 {p.jail} 回合）。")
            return True
        if p.skip:
            p.skip = False
            self.log(f"🏖️ {who}在度假村/医院休息，本回合跳过。")
            return True
        return False

    def on_dice(self, _evt=None):
        if self.g.winner is not None or self.g.turn != 0:
            return
        if self._turn_blocked(0):
            self.end_human_turn()
            return
        steps = self.g.roll()
        cell = self.g.move_player(0, steps)
        self.log(f"🎲 你掷出 {steps} 点，走到「{cell.name}」。")
        self.render()
        res = self.g.resolve_landing(0, cell)
        self._after_resolve(0, res)

    def _after_resolve(self, pidx, res, is_ai=False):
        """处理结算结果。返回 True 表示已展示决策按钮、正在等待玩家决策。"""
        g = self.g
        p = g.players[pidx]
        who = "你" if pidx == 0 else "电脑"
        cell = res["cell"]

        if res.get("bankrupt"):
            self.log(f"💸 {who} 付不起租金，破产！")
            self.render()
            self.game_over()
            return False
        if res.get("paid_rent"):
            self.log(f"💰 {who} 交租 ¥{res['paid_rent']}{res.get('mono', '')}（{cell.name}）。")
        if res.get("tax"):
            self.log(f"🧾 {who} 缴税 ¥{res['tax']}。")
        if res.get("rest"):
            self.log(f"🏖️ {who} 到达度假村，下回合休息。")
        if res.get("hospital"):
            self.log(f"🏥 {who} 住院，医药费 ¥{res['hospital']}，下回合休息。")
        if res.get("jailed"):
            extra = "（交不起保释金）" if res.get("no_bail") else ""
            self.log(f"🚔 {who} 入狱服刑 {JAIL_TURNS} 回合{extra}。")
        if res.get("event"):
            self.log(f"❓ {who}：{res['event']}。")
        chained = res.get("chained")
        if chained:
            needs = self._after_resolve(pidx, chained, is_ai)
            if g.winner is not None or needs:
                return needs

        action = res.get("action")
        if action == "buy":
            if is_ai:
                if g.ai_decide_buy(pidx, cell):
                    g.buy(pidx, cell)
                    self.log(f"🤖 电脑买下「{cell.name}」（¥{cell.price}）。")
                    self._check_monopoly_log(pidx, cell)
                else:
                    self.log(f"🤖 电脑放弃购买「{cell.name}」。")
                self.render()
            else:
                self._ask_buy(cell)
                self.render()
                return True
        elif action == "upgrade":
            if is_ai:
                if g.ai_decide_upgrade(pidx, cell):
                    g.upgrade(pidx, cell)
                    self.log(f"🤖 电脑升级了「{cell.name}」，租金涨到 ¥{g.rent_for(cell)}。")
                self.render()
            else:
                self._ask_upgrade(cell)
                self.render()
                return True
        elif action == "jail_choice":
            if is_ai:
                if g.ai_decide_bail(pidx):
                    g.pay_bail(pidx)
                    self.log(f"🤖 电脑交保释金 ¥{BAIL_COST} 出狱。")
                else:
                    g.serve_jail(pidx)
                    self.log(f"🤖 电脑没钱保释，坐牢 {JAIL_TURNS} 回合。")
                self.render()
            else:
                self._ask_jail(cell)
                self.render()
                return True
        else:
            self.render()

        if g.winner is not None:
            self.game_over()
            return False
        if not is_ai:
            self._show_end_turn()
        return False

    def _check_monopoly_log(self, pidx, cell):
        if cell.district and self.g.monopoly(pidx, cell.district):
            who = "你" if pidx == 0 else "电脑"
            self.log(f"👑 {who}垄断了{DISTRICTS[cell.district]['name']}！租金翻倍！")

    # ----- 人类决策按钮 -----
    def _clear_actions(self):
        self.action_el.innerHTML = ""

    def _ask_buy(self, cell):
        self._clear_actions()
        rent = self.g.rent_for(cell)
        tip = document.createElement("div")
        tip.textContent = f"「{cell.name}」售价 ¥{cell.price}，租金 ¥{rent}，买吗？"
        self.action_el.appendChild(tip)
        self.action_el.appendChild(self._btn(f"买！(-¥{cell.price})", lambda e: self._do_buy(cell)))
        self.action_el.appendChild(self._btn("放弃", lambda e: self._do_skip_buy(cell)))
        self.dice_btn.disabled = True

    def _do_buy(self, cell):
        ok = self.g.buy(0, cell)
        self.log(f"🏠 你买下「{cell.name}」。" if ok else "🚫 现金不够，买不起。")
        if ok:
            self._check_monopoly_log(0, cell)
        self._clear_actions()
        self.render()
        self._show_end_turn()

    def _do_skip_buy(self, cell):
        self.log(f"🚶 你放弃购买「{cell.name}」。")
        self._clear_actions()
        self._show_end_turn()

    def _ask_upgrade(self, cell):
        self._clear_actions()
        new_rent = TIERS[cell.tier]["rents"][1]
        if self.g.monopoly(0, cell.district):
            new_rent *= MONOPOLY_MULT
        tip = document.createElement("div")
        tip.textContent = f"「{cell.name}」是你的地盘，花 ¥{cell.upgrade_cost} 升级？租金 ¥{self.g.rent_for(cell)} → ¥{new_rent}"
        self.action_el.appendChild(tip)
        self.action_el.appendChild(self._btn(f"升级！(-¥{cell.upgrade_cost})", lambda e: self._do_upgrade(cell)))
        self.action_el.appendChild(self._btn("算了", lambda e: self._do_skip_upgrade(cell)))
        self.dice_btn.disabled = True

    def _do_upgrade(self, cell):
        ok = self.g.upgrade(0, cell)
        self.log(f"⭐ 你升级了「{cell.name}」。" if ok else "🚫 现金不够，升不起。")
        self._clear_actions()
        self.render()
        self._show_end_turn()

    def _do_skip_upgrade(self, cell):
        self.log(f"🚶 你跳过了升级「{cell.name}」。")
        self._clear_actions()
        self._show_end_turn()

    def _ask_jail(self, cell):
        self._clear_actions()
        tip = document.createElement("div")
        tip.textContent = f"🚔 你进了监狱！交保释金 ¥{BAIL_COST} 马上出去，还是坐满 {JAIL_TURNS} 回合？"
        self.action_el.appendChild(tip)
        self.action_el.appendChild(self._btn(f"交保释金（-¥{BAIL_COST}）", lambda e: self._do_bail()))
        self.action_el.appendChild(self._btn(f"坐牢（{JAIL_TURNS}回合）", lambda e: self._do_serve()))
        self.dice_btn.disabled = True

    def _do_bail(self):
        ok = self.g.pay_bail(0)
        self.log(f"💸 你交保释金出狱。" if ok else "🚫 现金不够，只能坐牢。")
        if not ok:
            self.g.serve_jail(0)
        self._clear_actions()
        self.render()
        self._show_end_turn()

    def _do_serve(self):
        self.g.serve_jail(0)
        self.log(f"🔒 你选择坐满 {JAIL_TURNS} 回合。")
        self._clear_actions()
        self.render()
        self._show_end_turn()

    def _show_end_turn(self):
        self._clear_actions()
        self.action_el.appendChild(self._btn("⏭️ 结束回合（电脑行动）", self._on_end_turn))
        self.dice_btn.disabled = True

    def _on_end_turn(self, _evt=None):
        self._clear_actions()
        self.end_human_turn()

    def end_human_turn(self):
        self.g.next_turn()
        self.render()
        if self.g.winner is not None:
            self.game_over()
            return
        self.log("🤖 电脑回合……")
        px = create_proxy(lambda: self.ai_turn())
        _proxies.append(px)
        window.setTimeout(px, 800)

    def ai_turn(self):
        g = self.g
        if self._turn_blocked(1):
            pass
        else:
            steps = g.roll()
            cell = g.move_player(1, steps)
            self.log(f"🎲 电脑掷出 {steps} 点，走到「{cell.name}」。")
            res = g.resolve_landing(1, cell)
            self._after_resolve(1, res, is_ai=True)
            if g.winner is not None:
                return
        g.next_turn()
        self.render()
        if g.winner is not None:
            self.game_over()
            return
        self.dice_btn.disabled = False
        self.log(f"—— 第 {min(g.round, MAX_ROUNDS)} 回合，你掷骰子 ——")

    def game_over(self):
        w = self.g.winner
        self.dice_btn.disabled = True
        self._clear_actions()
        ov = document.createElement("div")
        ov.id = "gameover"
        if w == 0:
            ov.textContent = "🎉 你赢了！电脑破产了，大富翁就是你！"
        elif w == 1:
            ov.textContent = "😭 你破产了……电脑笑到了最后。"
        else:
            a0, a1 = self.g.assets(0), self.g.assets(1)
            if w == "draw":
                ov.textContent = f"🤝 平局！双方总资产都是 ¥{a0}。"
            else:
                who = "你" if w == 0 else "电脑"
                ov.textContent = f"🏁 30 回合结束，{who} 总资产更高，获胜！"
        again = self._btn("🔄 再来一局", lambda e: window.location.reload())
        self.action_el.appendChild(ov)
        self.action_el.appendChild(again)
        self.log("🏁 游戏结束。")


def main():
    game = Game()
    UI(game)


if IN_BROWSER:
    main()
