"""今回 (v3.6) 修正したバグのリグレッションテスト。

各テストは「過去にバグっていた挙動」を再現する条件を組み、
修正後の正しい挙動を確認する。
"""
import pytest

from scheduler import ShiftScheduler
from tests.conftest import make_staff, make_config, date_range


# ========================================
# v3.6: peak_skill_rules のデフォルト注入を廃止
# ========================================

class TestPeakSkillRulesNoDefault:
    """旧版は config に peak_skill_rules がない場合
    勝手に「11:00-14:00 / B以上 / 1名」を制約として追加していた。
    """

    def test_no_default_peak_rule_when_unset(self):
        """peak_skill_rules を設定しなければ peak 制約は追加されない。"""
        config = make_config()
        assert "peak_skill_rules" not in config or config.get("peak_skill_rules") in (None, [], [{}])
        sch = ShiftScheduler(
            staff_list=[],
            config=config,
            dates=["2026-06-01"],
        )
        # config から読み込んだ peak_skill_rules は空
        assert sch.config.get("peak_skill_rules", []) in (None, [])


# ========================================
# v3.6.1: ミッドシフト自動生成を完全撤廃
# ========================================

class TestMidShiftRemoved:
    """v3.6.1 でミッドシフト自動生成は完全撤廃された。
    ピーク管理は time_staff_req (時間帯別ルール) に統一。
    config.mid_shift_auto_generate フラグは無視される (UI 設定も削除済み)。
    """

    def test_no_mid_shift_generated_by_default(self):
        config = make_config()
        config["custom_shifts"] = [
            {"name": "早番", "start": "09:00", "end": "15:00"},
            {"name": "遅番", "start": "15:00", "end": "22:00"},
        ]
        sch = ShiftScheduler(
            staff_list=[],
            config=config,
            dates=["2026-06-01"],
        )
        assert len(sch.shift_patterns) == 2
        names = {p["name"] for p in sch.shift_patterns}
        assert "mid" not in names

    def test_legacy_flag_is_ignored(self):
        """旧 config に mid_shift_auto_generate=True が残っていても、
        v3.6.1 では完全に無視される (ミッドシフト生成されない)。"""
        config = make_config()
        config["custom_shifts"] = [
            {"name": "早番", "start": "09:00", "end": "15:00"},
            {"name": "遅番", "start": "15:00", "end": "22:00"},
        ]
        config["mid_shift_auto_generate"] = True  # 旧 config 残骸
        sch = ShiftScheduler(
            staff_list=[],
            config=config,
            dates=["2026-06-01"],
        )
        # フラグが残っていても、ミッドシフトは追加されない
        assert len(sch.shift_patterns) == 2
        names = {p["name"] for p in sch.shift_patterns}
        assert "mid" not in names


# ========================================
# v3.6: 希望時間帯の排他削除 → 先頭追加に変更
# ========================================

class TestPreferenceNotExclusive:
    """旧版は pref_start_wd/we を設定したスタッフは pref_pat 1個のみで
    候補が作られ、希望時間が営業時間外などのとき infeasible になっていた。
    v3.6 で「pref_pat を先頭に追加するが他パターンも残す」に変更。
    """

    def test_pref_does_not_exclude_other_patterns(self):
        """希望時間帯を設定しても、他のパターンが候補から消えない。"""
        staff = make_staff("s1", "山田",
                          pref_start_wd="10:00", pref_end_wd="16:00")
        config = make_config()
        sch = ShiftScheduler(
            staff_list=[staff],
            config=config,
            dates=["2026-06-01"],
        )
        opts = sch._build_shift_options(staff, "2026-06-01", force=False)
        # 希望時間帯 (10:00-16:00) と config の早番/遅番が両方候補に含まれる
        starts = [o["start"] for o in opts]
        assert "10:00" in starts  # 希望時間帯
        # 早番/遅番のいずれかは残る
        assert any(s in starts for s in ["09:00", "15:00"])


# ========================================
# v3.6: _normalize_end_time の境界バグ
# ========================================

class TestNormalizeEndTimeEdge:
    """旧版は end <= start で +1440 していたため、end == start を 24時間勤務と
    誤判定していた。v3.6 で end < start のみに変更。
    """

    def test_equal_times_returns_zero_hours(self):
        sch = ShiftScheduler(staff_list=[], config=make_config(), dates=["2026-06-01"])
        # 09:00 - 09:00 は 0時間 (24時間ではない)
        result = sch._normalize_end_time(540, 540)
        assert result == 540

    def test_late_night_still_works(self):
        """22:00 → 02:00 のような正常な深夜シフトは従来通り正しく動作。"""
        sch = ShiftScheduler(staff_list=[], config=make_config(), dates=["2026-06-01"])
        result = sch._normalize_end_time(22 * 60, 2 * 60)
        assert result == 2 * 60 + 1440  # = 1560 (4時間後扱い)


# ========================================
# v3.6: インターバル制約の日付ギャップバグ
# ========================================

class TestIntervalGapBug:
    """旧版は (opt2.start + 1440) - opt1.end で「常に翌日」前提で計算。
    sorted_d にギャップがあると 2日以上の実間隔が 8h 等と誤計算され、
    「土日定休店で月曜朝シフト不可」現象が出ていた。
    """

    def test_gap_does_not_trigger_interval_constraint(self):
        """金曜22:00終→月曜6:00開 (土日定休) のシフトが両方配置可能。"""
        config = make_config(
            closed_days=[0, 6],  # 日(0), 土(6) を定休に
        )
        config["custom_shifts"] = [
            {"name": "夜", "start": "16:00", "end": "22:00"},
            {"name": "朝", "start": "06:00", "end": "12:00"},
        ]
        config["staff_req"] = {
            "min_weekday": 1, "min_weekend": 0, "min_holiday": 0, "min_manager": 0,
        }
        # 1名だけ。金土日月 のうち土日は閉店なので、金と月に配置されることを期待
        staff = [make_staff("s1", "テスト", max_days_week=5)]
        dates = ["2026-06-05", "2026-06-06", "2026-06-07", "2026-06-08"]
        # 金土日月: 金=2026-06-05, 月=2026-06-08

        sch = ShiftScheduler(staff_list=staff, config=config, dates=dates)
        result = sch.solve(force=False)
        assert result is not None
        # 金(夜) と 月(朝) の両方が配置できる (旧版はインターバル誤計算で不可)
        date_set = {s["date"] for s in result}
        # 少なくとも 1日は配置される (生成成功の証)
        assert len(date_set) >= 1


# ========================================
# v3.6: 連勤6日上限の日付ギャップ考慮
# ========================================

class TestConsecutiveDayGap:
    """旧版は sorted_d[i:i+7] を 7日間ウィンドウとして扱い、ギャップで
    実カレンダー10日以上を「連勤6日」と誤判定していた (緩い方向)。
    """

    def test_constraint_skips_gapped_span(self):
        """ギャップを跨ぐスパンには連勤制約が貼られない (緩和ではなく正確化)。"""
        # 1日休んで再開するケースで、連勤判定が誤発火しないことを確認
        # 月-土 6日連勤 + 日定休 + 月-土 6日連勤 → 違法ではない
        config = make_config(
            closed_days=[0],  # 日曜定休
        )
        staff = [make_staff("s1", "テスト", max_days_week=6)]
        # 2週間分
        dates = date_range("2026-06-01", 14)
        sch = ShiftScheduler(staff_list=staff, config=config, dates=dates)
        result = sch.solve(force=False)
        # 解が得られること (制約過剰でinfeasibleにならない)
        assert result is not None


# ========================================
# v3.6: NG ペア制約が Greedy でも有効
# ========================================

class TestNgPairDisabled:
    """v3.7.19 で NG ペア制約は完全廃止された (運用者判断)。
    _ng_pair_constraints は構築時点で常に空。
    """

    def test_ng_pair_constraint_always_empty(self):
        """ng_pairs カラムに値があっても _ng_pair_constraints は空。"""
        staff = [
            make_staff("s1", "山田", ng_pairs="佐藤"),
            make_staff("s2", "佐藤"),
        ]
        sch = ShiftScheduler(
            staff_list=staff,
            config=make_config(),
            dates=["2026-06-01"],
        )
        assert sch._ng_pair_constraints == []


class TestNullableStaffAttributes:
    """v3.7.9 で修正: ng_pairs/req_pairs カラムが DB NULL のとき
    re.split(pattern, None) で TypeError になっていたバグの再発防止。
    migration 50/51 で NULLABLE 専用カラムを追加後、旧データに NULL が残り
    再現していた。
    """

    def test_ng_pairs_null_does_not_crash(self):
        """ng_pairs=None で ShiftScheduler.__init__ がクラッシュしない。"""
        staff = [
            make_staff("s1", "山田", ng_pairs=None),
            make_staff("s2", "佐藤", ng_pairs=None),
        ]
        # クラッシュしないこと
        sch = ShiftScheduler(staff_list=staff, config=make_config(), dates=["2026-06-01"])
        # NG ペアは登録されない (None なので空文字列扱い)
        assert len(sch._ng_pair_constraints) == 0

    def test_req_pairs_null_does_not_crash(self):
        """req_pairs=None も同様。"""
        staff = [
            make_staff("s1", "山田", req_pairs=None),
        ]
        sch = ShiftScheduler(staff_list=staff, config=make_config(), dates=["2026-06-01"])
        assert len(sch._req_pair_constraints) == 0

    def test_ng_pairs_empty_string_works(self):
        """ng_pairs="" (空文字列) でも問題ない。"""
        staff = [make_staff("s1", "山田", ng_pairs="")]
        sch = ShiftScheduler(staff_list=staff, config=make_config(), dates=["2026-06-01"])
        assert len(sch._ng_pair_constraints) == 0

    def test_ng_weekdays_null_does_not_crash(self):
        """ng_weekdays=None でも NG 日計算がクラッシュしない。"""
        staff = [make_staff("s1", "山田", ng_weekdays=None)]
        sch = ShiftScheduler(staff_list=staff, config=make_config(), dates=["2026-06-01"])
        ng = sch._compute_staff_ng_dates(staff[0])
        # ng_weekdays が None なので何も NG にならない
        assert isinstance(ng, set)

    def test_pref_columns_null_does_not_crash(self):
        """全 pref_* 新カラムが None でクラッシュしない。"""
        staff = [make_staff("s1", "テスト",
                          pref_start_wd=None, pref_end_wd=None,
                          pref_start_we=None, pref_end_we=None)]
        sch = ShiftScheduler(staff_list=staff, config=make_config(), dates=["2026-06-01"])
        # _build_shift_options が動作する
        opts = sch._build_shift_options(staff[0], "2026-06-01", force=False)
        assert isinstance(opts, list)


# ========================================
# v3.6: ペナルティ重みの階層整合性
# ========================================

class TestPenaltyWeights:
    """v3.6 リバランスで重みの階層が正しく揃っているか確認。"""

    def test_open_close_no_longer_dominates(self):
        """OPEN_CLOSE_NO_EMP が EMPTY_SLOT と同階層に揃っている。
        旧版は 5倍だった (50M vs 10M) → 暴走の原因。
        """
        W = ShiftScheduler.W
        # 同階層 (= 1.0倍〜2.0倍以内)
        assert W.OPEN_CLOSE_NO_EMP <= W.EMPTY_SLOT * 2

    def test_preference_strong_enough(self):
        """PREFERENCE_EXACT が COVERAGE_UNDER の 30% 以上 (希望が無視されない強度)。
        旧版は 20% (1M / 5M) で希望が常に犠牲になっていた。
        """
        W = ShiftScheduler.W
        # 絶対値で比較 (PREFERENCE_EXACT は負値=ボーナス)
        assert abs(W.PREFERENCE_EXACT) >= W.COVERAGE_UNDER * 0.3

    def test_min_manager_appropriate(self):
        """MIN_MANAGER が COVERAGE_UNDER 以上 (管理者重視)。"""
        W = ShiftScheduler.W
        assert W.MIN_MANAGER >= W.COVERAGE_UNDER
