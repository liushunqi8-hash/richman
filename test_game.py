#!/usr/bin/env python3
"""本地逻辑测试：纯逻辑层（Game/Cell/Player）不依赖浏览器，模拟对局找 bug。"""
import sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
import game


def auto_play(seed, max_turns=3000):
    g = game.Game(seed=seed)
    turns = 0
    while g.winner is None and turns < max_turns:
        pidx = g.turn
        p = g.players[pidx]
        if p.jail > 0:
            p.jail -= 1
            g.next_turn()
            turns += 1
            continue
        if p.skip:
            p.skip = False
            g.next_turn()
            turns += 1
            continue
        steps = g.roll()
        assert 1 <= steps <= 6
        cell = g.move_player(pidx, steps)
        res = g.resolve_landing(pidx, cell)
        depth_guard = 0
        while res.get("action") and depth_guard < 6:
            depth_guard += 1
            c = res["cell"]
            if res["action"] == "buy":
                if p.cash - c.price >= 15000:
                    assert g.buy(pidx, c)
            elif res["action"] == "upgrade":
                if p.cash - c.upgrade_cost >= 25000:
                    assert g.upgrade(pidx, c)
            elif res["action"] == "jail_choice":
                if g.ai_decide_bail(pidx):
                    assert g.pay_bail(pidx)
                else:
                    g.serve_jail(pidx)
            res = {"action": None}
        assert not p.bankrupt or g.winner is not None
        g.next_turn()
        turns += 1
    return g, turns


def main():
    # 1. 棋盘定义检查
    assert len(game.BOARD_DEF) == 28, f"棋盘必须是 28 格，实际 {len(game.BOARD_DEF)}"
    kinds = [k for k, _, _ in game.BOARD_DEF]
    assert kinds.count("land") == 16, kinds.count("land")
    assert kinds.count("chance") == 6
    assert kinds.count("tax") == 2
    assert kinds.count("jail") == 1 and kinds.count("hospital") == 1
    assert kinds.count("rest") == 1 and kinds.count("start") == 1
    # 每个街区 4 块地
    for d in game.DISTRICTS:
        n = sum(1 for _, _, dd in game.BOARD_DEF if dd == d)
        assert n == 4, f"街区 {d} 有 {n} 块地"

    # 2. 网格映射检查：28 格互不重叠且都在 8x8 内
    from game import cell_grid_pos
    pts = [cell_grid_pos(i) for i in range(28)]
    assert len(set(pts)) == 28, f"格子重叠: {pts}"
    assert all(0 <= r < 8 and 0 <= c < 8 for r, c in pts)

    # 3. 多种子完整对局
    for seed in range(30):
        g, turns = auto_play(seed)
        assert g.winner is not None, f"seed={seed} 没结束"
        assert g.winner in (0, 1, "draw"), f"seed={seed} winner异常"
        assert all(p.cash >= 0 for p in g.players), f"seed={seed} 现金为负"
    print("30 种子对局全部正常结束 ✓")

    # 4. 买地/升级/租金/破产
    g = game.Game(seed=1)
    cell = g.cells[1]
    assert g.buy(0, cell) and cell.owner == 0
    assert g.players[0].cash == game.START_CASH - cell.price
    assert not g.buy(1, cell)
    assert g.upgrade(0, cell) and cell.level == 1
    before = g.players[1].cash
    g.players[1].pos = 1
    res = g.resolve_landing(1, cell)
    assert res.get("paid_rent") == g.rent_for(cell)
    assert g.players[1].cash == before - g.rent_for(cell)
    g.players[1].cash = 10
    res = g.resolve_landing(1, cell)
    assert res.get("bankrupt") and g.winner == 0
    print("买地/升级/租金/破产 ✓")

    # 5. 垄断租金翻倍
    g = game.Game(seed=2)
    reds = [c for c in g.cells if c.district == "red"]
    assert len(reds) == 4
    for c in reds[:3]:
        g.buy(0, c)
    assert not g.monopoly(0, "red")
    g.buy(0, reds[3])
    assert g.monopoly(0, "red")
    assert g.rent_for(reds[0]) == reds[0].base_rent() * 2
    print("街区垄断租金翻倍 ✓")

    # 6. 监狱
    g = game.Game(seed=3)
    jail = next(c for c in g.cells if c.kind == "jail")
    g.players[0].cash = game.START_CASH
    res = g.resolve_landing(0, jail)
    assert res["action"] == "jail_choice", res
    assert g.pay_bail(0) and g.players[0].cash == game.START_CASH - game.BAIL_COST
    g.players[1].cash = 100
    res = g.resolve_landing(1, jail)
    assert res.get("jailed") and g.players[1].jail == game.JAIL_TURNS
    print("监狱/保释 ✓")

    # 7. 医院
    g = game.Game(seed=4)
    hosp = next(c for c in g.cells if c.kind == "hospital")
    before = g.players[0].cash
    res = g.resolve_landing(0, hosp)
    assert res.get("hospital") == game.HOSPITAL_FEE
    assert g.players[0].cash == before - game.HOSPITAL_FEE
    assert g.players[0].skip is True
    print("医院 ✓")

    # 8. 过起点工资
    g = game.Game(seed=5)
    g.players[0].pos = 26
    g.move_player(0, 5)
    assert g.players[0].cash == game.START_CASH + game.SALARY
    assert g.players[0].pos == 3
    print("过起点工资 ✓")

    print("全部测试通过！")


if __name__ == "__main__":
    main()
