"""scheduler のユーティリティ関数テスト。"""
import pytest

from scheduler import ShiftScheduler
from tests.conftest import make_config


@pytest.fixture
def scheduler():
    """ユーティリティ関数だけ呼ぶ用の最小インスタンス。"""
    return ShiftScheduler(staff_list=[], config=make_config(), dates=["2026-06-01"])


# ========================================
# _to_minutes / _from_minutes
# ========================================

class TestTimeConversion:
    def test_to_minutes_basic(self, scheduler):
        assert scheduler._to_minutes("00:00") == 0
        assert scheduler._to_minutes("09:00") == 540
        assert scheduler._to_minutes("12:30") == 750
        assert scheduler._to_minutes("23:59") == 23 * 60 + 59
        assert scheduler._to_minutes("24:00") == 1440

    def test_to_minutes_invalid(self, scheduler):
        """不正な形式は 0 にフォールバック (ログ警告)。"""
        assert scheduler._to_minutes("invalid") == 0
        assert scheduler._to_minutes("") == 0
        assert scheduler._to_minutes(None) == 0

    def test_from_minutes(self, scheduler):
        assert scheduler._from_minutes(0) == "00:00"
        assert scheduler._from_minutes(540) == "09:00"
        assert scheduler._from_minutes(1440) == "00:00"  # 24h → 0h (mod 1440)
        assert scheduler._from_minutes(1500) == "01:00"  # 25h → 1h


# ========================================
# _normalize_end_time
# ========================================

class TestNormalizeEndTime:
    def test_same_day(self, scheduler):
        """end > start なら正規化不要。"""
        assert scheduler._normalize_end_time(540, 1200) == 1200  # 09:00 → 20:00

    def test_cross_midnight(self, scheduler):
        """end < start なら翌日扱い (+1440)。深夜営業対応。"""
        # 22:00 → 02:00 (22:00-翌2:00 = 4時間)
        assert scheduler._normalize_end_time(1320, 120) == 1560

    def test_equal_start_end_v36(self, scheduler):
        """v3.6: end == start は同時刻=0時間扱い (旧版は 24時間と誤判定していた)。"""
        assert scheduler._normalize_end_time(540, 540) == 540

    def test_late_night_shift(self, scheduler):
        """深夜業務シフト 23:00 → 03:00 = 4時間として計算。"""
        result = scheduler._normalize_end_time(23 * 60, 3 * 60)
        assert result == 3 * 60 + 1440  # = 1620 (= 27:00)
        assert (result - 23 * 60) / 60 == 4.0  # 4時間


# ========================================
# _get_day_type
# ========================================

class TestDayType:
    def test_weekday(self, scheduler):
        # 2026-06-01 は月曜
        assert scheduler._get_day_type("2026-06-01") == "weekday"

    def test_saturday(self, scheduler):
        # 2026-06-06 は土曜
        assert scheduler._get_day_type("2026-06-06") == "weekend"

    def test_sunday_is_holiday(self, scheduler):
        # 2026-06-07 は日曜 → 'holiday'
        # (重要: UI ラベル「日祝日」とコード一致)
        assert scheduler._get_day_type("2026-06-07") == "holiday"

    def test_closed_day(self):
        """closed_days で指定された曜日は 'closed'。"""
        config = make_config(closed_days=[0])  # 日曜定休 (0=日)
        sch = ShiftScheduler(staff_list=[], config=config, dates=["2026-06-07"])
        assert sch._get_day_type("2026-06-07") == "closed"

    def test_special_holiday(self):
        """special_holidays に含まれる日付は 'closed'。"""
        config = make_config(special_holidays=["2026-06-03"])
        sch = ShiftScheduler(staff_list=[], config=config, dates=["2026-06-03"])
        assert sch._get_day_type("2026-06-03") == "closed"

    def test_invalid_date(self, scheduler):
        """不正な日付文字列は安全のため 'closed'。"""
        assert scheduler._get_day_type("invalid-date") == "closed"
        assert scheduler._get_day_type("") == "closed"
        assert scheduler._get_day_type(None) == "closed"


# ========================================
# _get_required_staff
# ========================================

class TestRequiredStaff:
    def test_weekday_required(self, scheduler):
        """staff_req.min_weekday の値が返る。"""
        # conftest の make_config では min_weekday=2
        assert scheduler._get_required_staff("2026-06-01") == 2

    def test_weekend_required(self, scheduler):
        """staff_req.min_weekend の値が返る (土曜のみ)。"""
        assert scheduler._get_required_staff("2026-06-06") == 3  # 土

    def test_sunday_uses_holiday_value(self, scheduler):
        """日曜は min_holiday が適用される (バグ修正検証)。"""
        # conftest: min_holiday=3
        assert scheduler._get_required_staff("2026-06-07") == 3  # 日

    def test_closed_returns_zero(self):
        """休業日は 0 が返る。"""
        config = make_config(closed_days=[0])  # 日曜定休
        sch = ShiftScheduler(staff_list=[], config=config, dates=["2026-06-07"])
        assert sch._get_required_staff("2026-06-07") == 0


# ========================================
# _get_break_minutes
# ========================================

class TestBreakMinutes:
    def test_under_6_hours_no_break(self, scheduler):
        """6h 未満は休憩 0 分。"""
        assert scheduler._get_break_minutes(5.5) == 0

    def test_6_hours_break(self, scheduler):
        """6h で 45分。"""
        assert scheduler._get_break_minutes(6.0) >= 45
        assert scheduler._get_break_minutes(7.0) >= 45

    def test_8_hours_break(self, scheduler):
        """8h で 60分。"""
        assert scheduler._get_break_minutes(8.0) >= 60
        assert scheduler._get_break_minutes(10.0) >= 60
