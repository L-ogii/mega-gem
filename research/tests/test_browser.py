import json
import random
import tempfile
import unittest
from pathlib import Path

from megagem.browser import (
    AI_FACTORIES,
    DEFAULT_WEIGHTS_DIR,
    BrowserSession,
    _load_evo_weights,
)
from megagem.engine import is_game_over, max_legal_bid, play_round, score_game, setup_game
from megagem.players import Player


class ScriptedHuman(Player):
    """Engine-side stand-in for the browser human: fixed bid, reveal first gem."""

    is_human = True

    def __init__(self, name, bid):
        super().__init__(name)
        self.bid = bid

    def choose_bid(self, public_state, my_state, auction):
        return self.bid

    def choose_gem_to_reveal(self, public_state, my_state):
        return my_state.hand[0]


def _drive(session, bid):
    """Play a whole browser session: always bid ``bid``, reveal the first hand gem."""
    view = session.start()
    reveals = 0
    while view["phase"] != "game_over":
        if view["phase"] == "bid":
            view = session.bid(bid)
        elif view["phase"] == "reveal":
            reveals += 1
            hand = view["state"]["players"][session.human_idx]["hand"]
            view = session.reveal(hand[0])
        else:
            view = session.step()
    return view, reveals


SEATS = [
    {"kind": "human", "name": "You"},
    {"kind": "heuristic", "name": "H"},
    {"kind": "evo4", "name": "E4"},
    {"kind": "evo3", "name": "E3"},
]


class SpectatorTest(unittest.TestCase):
    def test_all_ai_game_runs_to_completion(self):
        seats = [{"kind": k, "name": k} for k in ("random", "heuristic", "evolved", "evo2", "evo4")]
        session = BrowserSession(seats, chart="C", seed=3)
        view = session.start()
        self.assertEqual(view["phase"], "ready")
        # Spectators see every hand.
        self.assertTrue(all("hand" in p for p in view["state"]["players"]))
        rounds = 0
        while view["phase"] != "game_over":
            view = session.step()
            rounds += 1
        self.assertEqual(len(view["scores"]), 5)
        self.assertEqual(len(session.history), rounds)
        self.assertEqual(len(view["final_hands"]), 5)


class ReplayTest(unittest.TestCase):
    def test_snapshot_replay_matches_direct_engine_run(self):
        """Browser game == the same game played straight through the engine."""
        for bid in (0, 4, 99):
            session = BrowserSession(SEATS, chart="E", seed=11)
            view, reveals = _drive(session, bid)

            seat_rng = random.Random(11)
            players = [ScriptedHuman("You", bid)]
            for seat in SEATS[1:]:
                players.append(AI_FACTORIES[seat["kind"]](
                    seat["name"], seed=seat_rng.randrange(2**31),
                    num_players=4, weights_dir=DEFAULT_WEIGHTS_DIR,
                ))
            state = setup_game(players, chart="E", seed=11)
            rng = random.Random(11)
            bids = []
            while not is_game_over(state):
                bids.append(play_round(state, rng=rng)["bids"])

            self.assertEqual([r["bids"] for r in session.history], bids)
            self.assertEqual(view["scores"], score_game(state))
            if bid == 99:
                self.assertGreater(reveals, 0)

    def test_reveal_view_shows_the_card_being_won(self):
        session = BrowserSession(SEATS, seed=5)
        view = session.start()
        card = view["auction"]
        view = session.bid(999)  # max bid — the human wins (or ties) this round
        while view["phase"] == "bid":
            card = view["auction"]
            view = session.bid(999)
        self.assertEqual(view["phase"], "reveal")
        self.assertEqual(view["auction"], card)
        hand = view["state"]["players"][0]["hand"]
        view = session.reveal(hand[-1])
        self.assertEqual(view["last_round"]["winner_idx"], 0)
        self.assertEqual(view["last_round"]["revealed_gem"], hand[-1])

    def test_explain_does_not_perturb_the_game(self):
        plain = BrowserSession(SEATS, seed=21)
        explained = BrowserSession(SEATS, seed=21, explain=True)
        _drive(plain, 3)
        _drive(explained, 3)
        self.assertEqual(
            [r["bids"] for r in plain.history],
            [r["bids"] for r in explained.history],
        )
        first = explained.history[0]["rationale"]
        self.assertIsNone(first[0])
        self.assertEqual(first[2]["ai_class"], "Evo4AI")


class RivalBidsTest(unittest.TestCase):
    def test_does_not_perturb_the_game(self):
        plain = BrowserSession(SEATS, seed=21)
        _drive(plain, 3)
        sampled = BrowserSession(SEATS, seed=21)
        view = sampled.start()
        while view["phase"] != "game_over":
            if view["phase"] == "bid":
                sampled.rival_bids(20)
                view = sampled.bid(3)
            else:
                view = sampled.reveal(view["state"]["players"][0]["hand"][0])
        self.assertEqual(
            [r["bids"] for r in plain.history],
            [r["bids"] for r in sampled.history],
        )
        self.assertEqual(plain.scores, sampled.scores)

    def test_samples_are_legal_bids_for_every_rival(self):
        session = BrowserSession(SEATS, seed=8)
        view = session.start()
        out = session.rival_bids(50)
        self.assertEqual(out["round"], 1)
        self.assertEqual(out["seats"], [1, 2, 3])
        self.assertEqual(len(out["samples"]), 50)
        auction = session.state.auction_deck[-1]
        for sample in out["samples"]:
            for seat, bid in zip(out["seats"], sample):
                self.assertGreaterEqual(bid, 0)
                self.assertLessEqual(bid, max_legal_bid(session.state.player_states[seat], auction))
        self.assertEqual(session.rival_bids(50), out)  # reproducible

    def test_ignores_how_the_hidden_cards_are_really_dealt(self):
        """Swap a rival's hand card with a deck card: the human sees the same table, so nothing changes."""
        real = BrowserSession(SEATS, seed=8)
        real.start()
        swapped = BrowserSession(SEATS, seed=8)
        swapped.start()
        hand, deck = swapped.state.player_states[1].hand, swapped.state.gem_deck
        k = next(i for i, g in enumerate(deck) if g.color != hand[0].color)
        hand[0], deck[k] = deck[k], hand[0]
        self.assertEqual(real.view()["state"], swapped.view()["state"])
        self.assertEqual(real.rival_bids(50), swapped.rival_bids(50))


MULTI_SEATS = [
    {"kind": "human", "name": "Ana"},
    {"kind": "heuristic", "name": "H"},
    {"kind": "human", "name": "Ben"},
    {"kind": "evo4", "name": "E4"},
]
MULTI_BIDS = {0: 3, 2: 6}


def _drive_multi(session, bids=MULTI_BIDS):
    """Play a whole multi-human session: fixed bids, the winner reveals its first hand gem."""
    session.start()
    views = session.views()
    reveals = 0
    while views["0"]["phase"] != "game_over":
        phases = {v["phase"] for v in views.values()}
        if phases == {"bid"}:
            views = session.bid_all({str(k): v for k, v in bids.items()})
        else:
            seat = views["0"]["reveal_seat"]
            reveals += 1
            session.reveal(views[str(seat)]["state"]["players"][seat]["hand"][0], seat)
            views = session.views()
    return views, reveals


class MultiHumanTest(unittest.TestCase):
    def test_matches_a_direct_engine_run(self):
        session = BrowserSession(MULTI_SEATS, chart="B", seed=4)
        views, reveals = _drive_multi(session)

        seat_rng = random.Random(4)
        players = []
        for i, seat in enumerate(MULTI_SEATS):
            if seat["kind"] == "human":
                players.append(ScriptedHuman(seat["name"], MULTI_BIDS[i]))
            else:
                players.append(AI_FACTORIES[seat["kind"]](
                    seat["name"], seed=seat_rng.randrange(2**31),
                    num_players=4, weights_dir=DEFAULT_WEIGHTS_DIR,
                ))
        state = setup_game(players, chart="B", seed=4)
        rng = random.Random(4)
        bids = []
        while not is_game_over(state):
            bids.append(play_round(state, rng=rng)["bids"])

        self.assertEqual([r["bids"] for r in session.history], bids)
        self.assertEqual(views["0"]["scores"], score_game(state))
        self.assertGreater(reveals, 0)

    def test_each_human_sees_only_their_own_hand(self):
        session = BrowserSession(MULTI_SEATS, seed=6)
        session.start()
        views = session.views()
        self.assertEqual(set(views), {"0", "2"})
        for seat, view in views.items():
            self.assertEqual(view["human_idx"], int(seat))
            self.assertEqual(view["human_seats"], [0, 2])
            for i, p in enumerate(view["state"]["players"]):
                self.assertEqual("hand" in p, i == int(seat))

    def test_others_wait_while_the_winner_reveals(self):
        session = BrowserSession(MULTI_SEATS, seed=6)
        session.start()
        views = session.views()
        while views["0"]["phase"] == "bid":
            views = session.bid_all({"0": 99, "2": 0})  # Ana outbids everyone
        self.assertEqual(views["0"]["phase"], "reveal")
        self.assertEqual(views["0"]["reveal_seat"], 0)
        self.assertEqual(views["2"]["phase"], "waiting")
        with self.assertRaises(RuntimeError):
            session.reveal("Blue", seat=2)
        session.reveal(views["0"]["state"]["players"][0]["hand"][0], seat=0)
        self.assertEqual(session.history[-1]["winner_idx"], 0)


class SessionGuardTest(unittest.TestCase):
    def test_rejects_out_of_phase_calls(self):
        session = BrowserSession(SEATS, seed=1)
        with self.assertRaises(RuntimeError):
            session.bid(1)
        session.start()
        with self.assertRaises(RuntimeError):
            session.reveal("Blue")
        with self.assertRaises(RuntimeError):
            session.step()

    def test_rejects_unknown_kinds(self):
        with self.assertRaises(ValueError):
            BrowserSession([{"kind": "nope"}] * 3)

    def test_loan_cap_exceeds_coins(self):
        session = BrowserSession(SEATS, seed=2)
        view = session.start()
        while view["phase"] != "game_over":
            if view["phase"] == "bid":
                coins = view["state"]["players"][0]["coins"]
                extra = view["auction"].get("amount", 0) if view["auction"]["kind"] == "loan" else 0
                self.assertEqual(view["max_bid"], coins + extra)
                view = session.bid(0)
            else:
                view = session.reveal(view["state"]["players"][0]["hand"][0])


class WeightsLookupTest(unittest.TestCase):
    def test_other_seat_counts_fall_back_to_4p_weights(self):
        four = _load_evo_weights(DEFAULT_WEIGHTS_DIR, "evo4", 4)
        self.assertIsNotNone(four)
        self.assertEqual(_load_evo_weights(DEFAULT_WEIGHTS_DIR, "evo4", 3), four)

    def test_seat_count_specific_file_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "best_weights_evo2_vs_all_4p.json").write_text(json.dumps({"weights": [1.0]}))
            (d / "best_weights_evo2_self_5p.json").write_text(json.dumps({"weights": [5.0]}))
            self.assertEqual(_load_evo_weights(d, "evo2", 5), [5.0])
            self.assertEqual(_load_evo_weights(d, "evo2", 3), [1.0])

    def test_missing_weights_fall_back_to_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            seats = [{"kind": k} for k in ("evolved", "evo2", "evo3", "evo4")]
            session = BrowserSession(seats, seed=0, weights_dir=tmp)
            self.assertEqual(session.start()["phase"], "ready")


if __name__ == "__main__":
    unittest.main()
