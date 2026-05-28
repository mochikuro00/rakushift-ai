"""共通テストフィクスチャ。

スケジューラの単体/結合テスト用ヘルパとサンプルデータを提供。
"""
import sys
import os
from datetime import datetime, timedelta

import pytest

# python/ をパスに追加（pytest を python/tests/ から走らせる前提）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scheduler import ShiftScheduler  # noqa: E402


def make_staff(id, name, **kwargs):
    """テスト用スタッフレコード生成。デフォルトは「フルタイマー Bランク」。"""
    base = {
        "id": id,
        "name": name,
        "role": "staff",
        "max_days_week": 5,
        "min_days_week": 0,
        "max_hours_day": 8,
        "evaluation": "B",
        "salary_type": "hourly",
        "contract_type": "general",
        "shift_priority": "medium",
    }
    base.update(kwargs)
    return base


def make_config(**overrides):
    """テスト用 config。デフォルトは平日9-22 / 平日2名・土曜3名・日祝3名"""
    base = {
        "opening_time": "09:00",
        "closing_time": "22:00",
        "opening_times": {
            "weekday": {"start": "09:00", "end": "22:00"},
            "weekend": {"start": "09:00", "end": "22:00"},
            "holiday": {"start": "09:00", "end": "22:00"},
        },
        "staff_req": {
            "min_weekday": 2,
            "min_weekend": 3,
            "min_holiday": 3,
            "min_manager": 1,
        },
        "custom_shifts": [
            {"name": "早番", "start": "09:00", "end": "15:00"},
            {"name": "遅番", "start": "15:00", "end": "22:00"},
        ],
        "closed_days": [],
        "special_holidays": [],
        "break_rules": [],
        "time_staff_req": [],
        # テスト高速化のため timeLimit を短く
        "milp_time_limits": {"tier3": 10, "tier2": 5, "tier1": 3},
    }
    base.update(overrides)
    return base


def date_range(start, days):
    """'2026-06-01' から N 日分の日付文字列リストを生成。"""
    start_dt = datetime.strptime(start, "%Y-%m-%d")
    return [(start_dt + timedelta(days=i)).strftime("%Y-%m-%d")
            for i in range(days)]


@pytest.fixture
def small_team():
    """4名・週5日まで・全員 B ランクの小規模チーム。"""
    return [
        make_staff("s1", "山田", role="manager", max_days_week=5),
        make_staff("s2", "佐藤", max_days_week=5),
        make_staff("s3", "鈴木", max_days_week=4),
        make_staff("s4", "高橋", max_days_week=4),
    ]


@pytest.fixture
def basic_config():
    return make_config()


@pytest.fixture
def one_week_dates():
    """2026-06-01 (月) から 7日分。"""
    return date_range("2026-06-01", 7)
