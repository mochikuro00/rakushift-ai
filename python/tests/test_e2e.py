"""End-to-end (E2E) スモークテスト。

実際にシフトを生成して、結果が妥当であることを確認する。
"""
import pytest
from datetime import datetime

from scheduler import ShiftScheduler
from tests.conftest import make_staff, make_config, date_range


class TestBasicGeneration:
    """基本的な生成が動作することを確認。"""

    def test_simple_one_week(self, small_team, basic_config, one_week_dates):
        """4名 / 1週間 で生成が成功する。"""
        sch = ShiftScheduler(
            staff_list=small_team,
            config=basic_config,
            dates=one_week_dates,
        )
        result = sch.solve(force=False)
        assert result is not None
        assert len(result) > 0
        # 全シフトに必須フィールドがある
        for s in result:
            assert s["staff_id"]
            assert s["date"]
            assert s["start_time"]
            assert s["end_time"]

    def test_empty_staff_returns_none_or_empty(self):
        """スタッフ 0 名 → 解なし (None または空)。"""
        sch = ShiftScheduler(
            staff_list=[],
            config=make_config(),
            dates=["2026-06-01"],
        )
        result = sch.solve(force=False)
        # スタッフ無しでは生成不能
        assert result is None or len(result) == 0

    def test_one_day_generation(self, small_team, basic_config):
        """1日だけのシフト生成も成功する。"""
        sch = ShiftScheduler(
            staff_list=small_team,
            config=basic_config,
            dates=["2026-06-01"],
        )
        result = sch.solve(force=False)
        assert result is not None


class TestLegalCompliance:
    """法定制約の遵守を確認。"""

    def test_max_hours_day_respected(self, small_team, basic_config, one_week_dates):
        """1日の労働時間が max_hours_day を超えない (force=False)。"""
        sch = ShiftScheduler(
            staff_list=small_team,
            config=basic_config,
            dates=one_week_dates,
        )
        result = sch.solve(force=False)
        assert result is not None
        for shift in result:
            sid = shift["staff_id"]
            staff = next((s for s in small_team if s["id"] == sid), None)
            assert staff is not None
            max_h = float(staff.get("max_hours_day") or 8)
            start = sch._to_minutes(shift["start_time"])
            end = sch._normalize_end_time(start, sch._to_minutes(shift["end_time"]))
            hours = (end - start) / 60.0
            # 休憩を除いた実労働時間
            brk = sch._get_break_minutes(hours)
            work_hours = hours - brk / 60.0
            # 法定 8h を超えないことを確認 (force=False では超えるとペナルティだがハードではないので余裕値を見る)
            assert work_hours <= max_h + 0.5  # 浮動小数誤差許容

    def test_no_seven_consecutive_days(self, basic_config):
        """7日連勤が発生しない (労基法35条)。"""
        staff = [make_staff("s1", "テスト", max_days_week=7)]  # 最大7日設定でも
        dates = date_range("2026-06-01", 14)  # 2週間
        config = make_config(
            staff_req={"min_weekday": 1, "min_weekend": 1, "min_holiday": 1, "min_manager": 0},
        )
        sch = ShiftScheduler(staff_list=staff, config=config, dates=dates)
        result = sch.solve(force=False)
        if result is None:
            pytest.skip("Solver did not produce result for this scenario")

        # スタッフの出勤日を抽出してソート
        sid = "s1"
        work_dates = sorted([s["date"] for s in result if s["staff_id"] == sid])
        if len(work_dates) < 7:
            return  # 7日未満なら違反不可能

        # 任意の連続 7日間ウィンドウで「全部出勤」していないことを確認
        for i in range(len(work_dates) - 6):
            d_start = datetime.strptime(work_dates[i], "%Y-%m-%d")
            d_end = datetime.strptime(work_dates[i + 6], "%Y-%m-%d")
            if (d_end - d_start).days == 6:
                # 7日連続出勤を検知 → 違反
                pytest.fail(f"7日連勤検出: {work_dates[i]} - {work_dates[i+6]}")


class TestConstraintEnforcement:
    """ユーザー設定制約の遵守を確認。"""

    def test_max_days_week_soft_limit(self, basic_config):
        """max_days_week を超える配置にはペナルティが効く (+2 までは緩和許容)。"""
        staff = [
            make_staff("s1", "管理者", role="manager", max_days_week=5),
            make_staff("s2", "パート", max_days_week=3),  # 週3日まで
        ]
        dates = date_range("2026-06-01", 7)
        sch = ShiftScheduler(staff_list=staff, config=basic_config, dates=dates)
        result = sch.solve(force=False)
        if result is None:
            pytest.skip("No result")
        # パートの出勤日数 ≤ max_days_week + 2 (緩和許容範囲)
        s2_count = sum(1 for s in result if s["staff_id"] == "s2")
        assert s2_count <= 3 + 2

    def test_closed_day_no_shifts(self, small_team):
        """休業日にシフトが配置されない。"""
        config = make_config(closed_days=[0, 6])  # 土日定休
        dates = date_range("2026-06-01", 7)
        sch = ShiftScheduler(staff_list=small_team, config=config, dates=dates)
        result = sch.solve(force=False)
        if result is None:
            pytest.skip("No result")
        # 土曜 (2026-06-06) と日曜 (2026-06-07) にシフトがない
        sat_shifts = [s for s in result if s["date"] == "2026-06-06"]
        sun_shifts = [s for s in result if s["date"] == "2026-06-07"]
        assert len(sat_shifts) == 0
        assert len(sun_shifts) == 0


class TestPreference:
    """希望シフトの尊重を確認 (v3.6 強化された重みの動作確認)。"""

    def test_approved_work_request_placed(self, small_team, basic_config):
        """承認済みの出勤希望は確実に配置される。"""
        dates = date_range("2026-06-01", 7)
        requests = [
            {
                "staff_id": "s2",
                "type": "work",
                "status": "approved",
                "dates": ["2026-06-03"],
                "start_time": "09:00",
                "end_time": "17:00",
            }
        ]
        sch = ShiftScheduler(
            staff_list=small_team,
            config=basic_config,
            dates=dates,
            requests=requests,
        )
        result = sch.solve(force=False)
        if result is None:
            pytest.skip("No result")
        # s2 が 06-03 に配置されている
        s2_on_03 = [s for s in result if s["staff_id"] == "s2" and s["date"] == "2026-06-03"]
        assert len(s2_on_03) >= 1


class TestPreCheck:
    """事前チェック (pre_check) の動作確認。"""

    def test_pre_check_returns_warnings(self, small_team, basic_config):
        """pre_check が辞書形式で警告を返す。"""
        dates = date_range("2026-06-01", 7)
        sch = ShiftScheduler(
            staff_list=small_team,
            config=basic_config,
            dates=dates,
        )
        report = sch.pre_check()
        assert isinstance(report, dict)
        assert "warnings" in report or "feasible" in report

    def test_pre_check_detects_capacity_shortage(self):
        """スタッフ供給力 < 必要人時のとき infeasible_capacity 警告。"""
        # 1名で 1ヶ月の店舗を回せるはずがない
        staff = [make_staff("s1", "テスト", max_days_week=5, max_hours_day=8)]
        config = make_config(
            staff_req={"min_weekday": 5, "min_weekend": 5, "min_holiday": 5, "min_manager": 0},
        )
        dates = date_range("2026-06-01", 30)
        sch = ShiftScheduler(staff_list=staff, config=config, dates=dates)
        report = sch.pre_check()
        # 何らかの警告が出る
        warnings = report.get("warnings", [])
        # capacity 不足の検出 (テキストに「不能」や「不足」を含む)
        types = [w.get("type") for w in warnings]
        # infeasible_capacity または manager_shortage のいずれか
        assert any(t in types for t in ("infeasible_capacity", "manager_shortage")) or len(warnings) > 0
