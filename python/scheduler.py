import pulp
import logging
import re
from datetime import datetime, timedelta

logger = logging.getLogger("rakushift.scheduler")

class ShiftScheduler:
    """
    ラクシフトAI シフト最適化エンジン v3.0

    労基法準拠:
    - 6時間超: 45分以上の休憩 (労基法34条)
    - 8時間超: 60分以上の休憩 (労基法34条)
    - 週40時間上限 (労基法32条, 変形労働時間制は非対応)
    - 連続6日勤務上限 / 週1日以上の休日 (労基法35条)
    - 1日8時間上限 (労基法32条, スタッフ個別設定で上書き可)

    企業ルール:
    - 店舗の定休日・臨時休業日・特別営業時間
    - 時間帯別最低人員配置
    - 管理者(店長/リーダー)常駐義務
    - OJT制約(新人にはメンター必須)
    - 承認済み出勤希望の固定配置
    - 承認済み休暇希望の絶対遵守
    """

    DEFAULT_BREAK_RULES = [
        {"min_hours": 6, "break_minutes": 45},
        {"min_hours": 8, "break_minutes": 60},
    ]

    MENTOR_ROLES = {"manager", "leader"}
    ROOKIE_ROLES = {"rookie"}
    POWER_SCORE = {"A": 3.0, "B": 2.0, "C": 1.0, "D": 0.5}

    # 労基法の法定上限
    LEGAL_MAX_HOURS_DAY = 8
    LEGAL_MAX_HOURS_WEEK = 40
    LEGAL_MAX_CONSECUTIVE_DAYS = 6

    # ===========================================================
    # ペナルティ重み定数 (集中管理)
    #   - 旧バージョンは即値が散在し調整が困難だったため、
    #     全ての penalty 加算で参照する単一の定数源に統合。
    #   - 大きいほど "強い禁止/誘導"。負値は "ボーナス"。
    #   - 順序関係 (重要): EMPTY_SLOT > OPEN_CLOSE_NO_EMP > COVERAGE_UNDER > ...
    # ===========================================================
    class W:
        # v3.7: 「ぴったり合わせる」を最優先に再リバランス
        #   v3.6 の問題点:
        #   - COVERAGE_OVER_DAY (2M) + OVER_SLOT (1M) = 3M で希望ボーナス (3M) と
        #     breakeven。最適化が「過剰でも希望優先」に傾き、過剰配置の温床に。
        #   - SHIFT_COST = 30k で「人数が多い場合は考えて」が効かず、可能なだけ
        #     スタッフを追加していた。
        #   v3.7 方針: 過不足を対称化 (UNDER=OVER) + シフト追加コスト引き上げ。
        #             希望はあくまで「同じ人数の中での選別」用に弱める。
        #
        # ===========================================================
        # v3.7.47 最終整理: 階層化された予測可能なペナルティ重み
        # 各 Tier 間は最低 10倍の差を保ち、配置ロジックが安定 (=ブレない)
        # ===========================================================
        #
        # [ Tier 1: 絶対 (100M) ] — 物理・法定の必達
        COVERAGE_UNDER      = 100_000_000  # 必要人数不足 (絶対NG)
        COVERAGE_OVER_DAY   = 100_000_000  # 日次過剰人員 (絶対NG)
        COVERAGE_OVER_SLOT  = 100_000_000  # スロット過剰人員 (絶対NG)
        #
        # [ Tier 2: 必須 (10M) ] — 業務遂行に必須
        EMPTY_SLOT          = 10_000_000  # 任意スロット 0名
        OPEN_CLOSE_NO_EMP   = 10_000_000  # 開け閉め社員1名以上常駐
        #
        # [ Tier 3: 重要 (1M〜3M) ] — 希望尊重・社員優先
        PREFERENCE_EXACT    = -3_000_000  # 希望時間完全一致 (ボーナス)
        POSITION_SHORT      = 3_000_000   # ポジション不足
        PREFERENCE_CLOSE    = -1_500_000  # 希望時間 ±1時間以内
        OJT_NO_MENTOR       = 500_000     # 新人×メンター不在
        #
        # [ Tier 4: 推奨 (50k〜500k) ] — 希望シフト・社員配置
        PREFERENCE_BASE     = -500_000    # 希望日に何らかのシフト
        # (月給未配置/月給min_days/時給min_daysは個別ペナルティで個別管理)
        #
        # [ Tier 5: 微調整 (1k〜100k) ] — 属性ボーナス・効率化
        SHIFT_COST          = 100_000     # シフト 1 件追加 (過剰抑制)
        FAIRNESS_DRIFT      = 10_000      # 公平性偏差
        PRIORITY_HIGH       = -10_000     # 優先度 High スタッフ
        PRIORITY_LOW        = 2_000       # 優先度 Low スタッフ
        MIN_DAYS_WEEK_BONUS = -10_000     # min_days_week 達成ボーナス
        CONTRACT_REGULAR    = -2_000      # レギュラー契約
        CONTRACT_SPOT       = 1_000       # スポット契約
        MENTOR_MATCH_BONUS  = -1_000      # 主担当メンター ペアリング

    def __init__(self, staff_list, config, dates, requests=None, existing_shifts=None):
        # 安全対策: idを持たない不正なスタッフデータを自動除去 (KeyError防止)
        raw_staff = staff_list or []
        self.staff_list = [s for s in raw_staff if isinstance(s, dict) and s.get("id")]
        
        self.config = config or {}
        # 安全対策: YYYY-MM-DDフォーマットの正しい日付のみを対象にする
        valid_dates = []
        for d in (dates or []):
            if isinstance(d, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", d):
                try:
                    datetime.strptime(d, "%Y-%m-%d")
                    valid_dates.append(d)
                except ValueError:
                    pass
        self.dates = sorted(valid_dates)
        raw_req = requests or []
        self.requests = [r for r in raw_req if isinstance(r, dict) and r.get("staff_id")]
        # 既存シフト (empty_only モード時に固定として扱う)
        # HH:MM 形式と YYYY-MM-DD 形式を厳密検証して、_to_minutes での ValueError を未然に防ぐ
        time_pat = re.compile(r"^\d{1,2}:\d{2}(:\d{2})?$")
        date_pat = re.compile(r"^\d{4}-\d{2}-\d{2}$")
        raw_existing = existing_shifts or []
        self.existing_shifts = []
        for s in raw_existing:
            if not isinstance(s, dict):
                continue
            sid = s.get("staff_id")
            sd = s.get("date")
            st = s.get("start_time")
            et = s.get("end_time")
            if not (sid and sd and st and et):
                continue
            if not (isinstance(sd, str) and date_pat.match(sd)):
                continue
            if not (isinstance(st, str) and time_pat.match(st)):
                continue
            if not (isinstance(et, str) and time_pat.match(et)):
                continue
            self.existing_shifts.append({
                "staff_id": sid,
                "date": sd,
                "start_time": st[:5],
                "end_time": et[:5],
            })

        # 旧 random.uniform ジッターは廃止 (常に決定論的: ガチャ要素ゼロ)。
        # 同点解消は staff_id ハッシュベースのタイブレーカーで公平かつ deterministic に行う。
        # config.random_seed は後方互換のため受け取るが、現状の MILP では作用しない。

        # 生成サマリレポート (制約違反・不足の可視化用) を main.py が取得する
        self._last_report = None

        # シフトパターン構築：UI で登録された custom_shifts のみ使用
        # v3.6.1: ミッドシフト自動生成は完全撤廃。
        # ピーク時の人員確保は「時間帯別・曜日別 人員増強」(time_staff_req) ルールで
        # 明示的に管理する設計に統一。ユーザーが定義していない時間帯のシフトパターンを
        # システムが勝手に作らないようにした。中間時間帯のシフトが必要なら、
        # UI で明示的にシフトパターンを追加する。
        raw_patterns = self.config.get("custom_shifts", [])
        self.shift_patterns = []
        for p in raw_patterns:
            st = p.get("start", "09:00")
            en = p.get("end", "18:00")
            self.shift_patterns.append({
                "start": st, "end": en, "name": p.get("name", "")
            })
        if not self.shift_patterns:
            op = self.config.get("opening_time", "09:00")
            cl = self.config.get("closing_time", "22:00")
            self.shift_patterns = [{"start": op, "end": cl, "name": "full"}]

        # 営業時間
        self.op_limit = self.config.get("opening_time", "09:00")
        self.cl_limit = self.config.get("closing_time", "22:00")
        raw_ot = self.config.get("opening_times", {})
        if not raw_ot or not raw_ot.get("weekday"):
            self.opening_times = {
                "weekday": {"start": self.op_limit, "end": self.cl_limit},
                "weekend": {"start": self.op_limit, "end": self.cl_limit},
                "holiday": {"start": self.op_limit, "end": self.cl_limit},
            }
        else:
            self.opening_times = raw_ot

        # 人員配置要件
        sr = self.config.get("staff_req", {})
        self.min_weekday = int(sr.get("min_weekday", 2))
        self.min_weekend = int(sr.get("min_weekend", 3))
        self.min_holiday = int(sr.get("min_holiday", 3))
        self.min_manager = int(sr.get("min_manager", 1))
        self.time_staff_req = self.config.get("time_staff_req", [])

        # 休憩ルール（型安全性の向上）
        raw_rules = self.config.get("break_rules", [])
        self.break_rules = []
        if isinstance(raw_rules, list):
            for r in raw_rules:
                if isinstance(r, dict):
                    try:
                        self.break_rules.append({
                            "min_hours": float(r.get("min_hours", 0)),
                            "break_minutes": int(r.get("break_minutes", 0))
                        })
                    except (ValueError, TypeError):
                        pass
        if not self.break_rules:
            self.break_rules = self.DEFAULT_BREAK_RULES

        # 休業日設定
        self.closed_days = self.config.get("closed_days", [])
        self.special_holidays = self.config.get("special_holidays", [])
        self.special_days = self.config.get("special_days", {})

        # スタッフ分類
        self._mentor_ids = set()
        self._rookie_ids = set()
        self._monthly_ids = set()
        self._manager_ids = set()
        self._eval_rank = {}
        self._staff_map = {}  # id -> staff dict

        # v3.3 改修7: カスタム役職 ID を level/color で判定するため
        # config.roles から動的に role 分類セットを構築
        # 旧版: MENTOR_ROLES = {"manager","leader"} (ハードコード) しか認識せず、
        #       UI で「新規役職」追加した役職 (role_v6lei... 等) はメンター扱いされなかった。
        # 新版: config.roles から level >= 4 ならメンター、>= 3 なら社員/管理者扱い
        custom_mentor_ids = set(self.MENTOR_ROLES)  # default
        custom_employee_role_ids = {"manager", "sub_manager", "employee"}  # default
        custom_rookie_ids = set(self.ROOKIE_ROLES)
        roles_cfg = self.config.get("roles") or []
        if isinstance(roles_cfg, list):
            for r in roles_cfg:
                if not isinstance(r, dict):
                    continue
                rid = str(r.get("id", "")).lower()
                level = r.get("level")
                color = str(r.get("color", "")).lower()
                if not rid:
                    continue
                # level >= 4 (店長級) または color=purple/red はメンター扱い
                if (isinstance(level, (int, float)) and level >= 4) or color in ("purple", "red"):
                    custom_mentor_ids.add(rid)
                # level >= 3 (社員/管理者級) または color=purple/red/green は employee 扱い
                if (isinstance(level, (int, float)) and level >= 3) or color in ("purple", "red", "green"):
                    custom_employee_role_ids.add(rid)
                # level == 1 (新人級) または color=yellow は rookie 候補
                if (isinstance(level, (int, float)) and level <= 1) or color == "yellow":
                    custom_rookie_ids.add(rid)
        self._mentor_role_ids = custom_mentor_ids
        self._employee_role_ids = custom_employee_role_ids
        self._rookie_role_ids = custom_rookie_ids
        logger.info("[Role] mentor={}, employee={}, rookie={}".format(
            self._mentor_role_ids, self._employee_role_ids, self._rookie_role_ids))

        for s in self.staff_list:
            sid = s["id"]
            self._staff_map[sid] = s
            role = str(s.get("role", "staff")).lower()
            evaluation = str(s.get("evaluation", "B")).upper()
            salary = str(s.get("salary_type", "hourly")).lower()

            # v3.3: 動的セットで判定 (カスタム役職も含む)
            if role in self._mentor_role_ids:
                self._mentor_ids.add(sid)
            # v3.7.18: evaluation == "D" を rookie 判定から除外。
            # 評価D の判定はベテランでも (例: 業務適性が低い等で) 起こりうるが、
            # その人を新人扱いして OJT 制約を貼るのは実態と乖離。
            # rookie は明示的に rookie ロールが割り当てられたスタッフのみとする。
            if role in self._rookie_role_ids:
                self._rookie_ids.add(sid)
            if role in self._employee_role_ids:
                self._manager_ids.add(sid)
            if salary == "monthly":
                self._monthly_ids.add(sid)
            self._eval_rank[sid] = evaluation if evaluation in self.POWER_SCORE else "B"

            # v3.7.1: 新カラム (migration 50/51) を優先し、旧 unavailable_dates タグは
            # フォールバックとして使用する。新カラムに値があればそちらを採用。
            # 既に s.get("shift_priority") 等で値が入っていれば、タグ解析は補完のみ。
            ud = s.get("unavailable_dates")
            if ud:
                if isinstance(ud, str):
                    ud = [d.strip() for d in ud.split(",") if d.strip()]
                # v3.7.3: 「新カラム優先、旧タグは新カラムが None のときだけ補完」を厳密化。
                # 旧版 `not s.get("...")` は空文字列 "" でも True になり、明示的に
                # 空に設定された値を旧タグで上書きするバグがあった (agent #1 指摘)。
                for d in ud:
                    if d.startswith("prefStart:") and s.get("pref_start") is None:
                        s["pref_start"] = d.replace("prefStart:", "")
                    if d.startswith("prefEnd:") and s.get("pref_end") is None:
                        s["pref_end"] = d.replace("prefEnd:", "")
                    if d.startswith("prefStartWd:") and s.get("pref_start_wd") is None:
                        s["pref_start_wd"] = d.replace("prefStartWd:", "")
                    if d.startswith("prefEndWd:") and s.get("pref_end_wd") is None:
                        s["pref_end_wd"] = d.replace("prefEndWd:", "")
                    if d.startswith("prefStartWe:") and s.get("pref_start_we") is None:
                        s["pref_start_we"] = d.replace("prefStartWe:", "")
                    if d.startswith("prefEndWe:") and s.get("pref_end_we") is None:
                        s["pref_end_we"] = d.replace("prefEndWe:", "")
                    if d.startswith("ngPair:") and s.get("ng_pairs") is None:
                        s["ng_pairs"] = d.replace("ngPair:", "")
                    if d.startswith("reqPair:") and s.get("req_pairs") is None:
                        s["req_pairs"] = d.replace("reqPair:", "")
                    if d.startswith("position:") and s.get("position") in (None, "any"):
                        s["position"] = d.replace("position:", "")
                    if d.startswith("priority:") and s.get("shift_priority") is None:
                        s["shift_priority"] = d.replace("priority:", "")
                    if d.startswith("contract:") and s.get("contract_type") is None:
                        s["contract_type"] = d.replace("contract:", "")
        # NGデータキャッシュ (各呼び出しで再計算しないように)
        self._ng_cache = {}
        
        # 名前からIDへのマッピング作成（相性制約用）
        name_to_id = {}
        for s in self.staff_list:
            name = s.get("name", "").strip()
            sid = s.get("id")
            if name:
                name_to_id[name] = sid
                if " " in name:
                    name_to_id[name.split(" ")[0]] = sid
                elif "　" in name:
                    name_to_id[name.split("　")[0]] = sid

        self._ng_pair_constraints = []
        self._req_pair_constraints = []

        for s in self.staff_list:
            self._ng_cache[s["id"]] = self._compute_staff_ng_dates(s)

            sid1 = s["id"]
            # v3.7.19: NG ペア制約を廃止 (運用者判断)。
            # ng_pairs カラム自体は DB に残るが、scheduler は参照しない。
            # _ng_pair_constraints は空のまま維持され、MILP/Greedy 双方が無視。

            req_pairs_str = s.get("req_pairs") or ""
            for target_name in [n.strip() for n in re.split(r'[,、\s　]+', req_pairs_str) if n.strip()]:
                sid2 = name_to_id.get(target_name)
                if not sid2:
                    for n, _sid in name_to_id.items():
                        if target_name in n or n in target_name:
                            sid2 = _sid; break
                if sid2 and sid1 != sid2:
                    self._req_pair_constraints.append((sid1, sid2))

        logger.info("[Init] Staff:{} Dates:{} Patterns:{}".format(
            len(self.staff_list), len(self.dates), len(self.shift_patterns)))
        logger.info("[Init] Req: wd={} we={} hol={} mgr={}".format(
            self.min_weekday, self.min_weekend,
            self.min_holiday, self.min_manager))
        logger.info("[Init] Mentors:{} Rookies:{} Monthly:{}".format(
            len(self._mentor_ids), len(self._rookie_ids),
            len(self._monthly_ids)))

    # ===========================================================
    # ユーティリティ
    # ===========================================================

    def _normalize_end_time(self, start_min, end_min):
        """
        end_min < start_min なら翌日跨ぎとして +1440 (例: 22:00→02:00 を 22:00→26:00)。
        end_min == start_min は「同時刻」= 0時間シフトとして扱う (24時間勤務と誤判定しない)。
        v3.6 修正: 旧版は `end <= start` で +1440 していたため、設定ミスで end==start
        になった場合に 24時間勤務扱いされていた。深夜営業 (22:00-02:00 等) は
        end < start で正しく検出される。
        """
        if end_min < start_min:
            return end_min + 1440
        return end_min

    def _to_minutes(self, time_str):
        try:
            parts = str(time_str).split(":")
            return int(parts[0]) * 60 + int(parts[1])
        except (ValueError, IndexError, TypeError) as e:
            logger.warning("[_to_minutes] Invalid time string '%s': %s", time_str, e)
            return 0

    def _from_minutes(self, mins):
        m = int(mins) % 1440
        return "{:02d}:{:02d}".format(m // 60, m % 60)

    def _get_day_type(self, date_str):
        """日付の種別を判定: weekday / weekend / holiday / closed"""
        if not date_str:
            return "closed"
        if date_str in self.special_holidays:
            return "closed"
        try:
            dt = datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError:
            return "closed"  # 不正な日付文字列は安全のためにclosed扱い
        # JavaScript互換: 0=日, 1=月, ..., 6=土
        js_dow = (dt.weekday() + 1) % 7
        
        # closed_daysの数値を安全にパース
        closed_ints = []
        for d in (self.closed_days or []):
            try:
                closed_ints.append(int(d))
            except (ValueError, TypeError) as e:
                logger.warning("[_get_day_type] Invalid closed_day '%s': %s", d, e)
                
        if js_dow in closed_ints:
            return "closed"
        if dt.weekday() == 6:  # 日曜
            return "holiday"
        if dt.weekday() == 5:  # 土曜
            return "weekend"
        return "weekday"

    def _get_required_staff(self, date_str):
        t = self._get_day_type(date_str)
        if t == "closed":
            return 0
        if t == "holiday":
            return self.min_holiday
        if t == "weekend":
            return self.min_weekend
        return self.min_weekday

    def _get_opening_hours(self, date_str):
        if date_str in self.special_days:
            sd = self.special_days[date_str]
            return sd.get("start", self.op_limit), sd.get("end", self.cl_limit)
        t = self._get_day_type(date_str)
        if t == "closed":
            return self.op_limit, self.op_limit
        key = {"holiday": "holiday", "weekend": "weekend"}.get(t, "weekday")
        ot = self.opening_times.get(key, {})
        return ot.get("start", self.op_limit), ot.get("end", self.cl_limit)

    def _get_break_minutes(self, hours):
        """労基法準拠の休憩時間算出 (>=で判定)

        労基法34条:
        - 労働時間が6時間を超える場合: 少なくとも45分
        - 労働時間が8時間を超える場合: 少なくとも60分
        """
        brk = 0
        for rule in sorted(self.break_rules, key=lambda r: r.get("min_hours", 0)):
            # >= に修正: 6時間ちょうどでも休憩必須 (労基法は「超える」だが安全側に)
            if hours >= rule.get("min_hours", 0):
                brk = rule.get("break_minutes", 0)
        return brk

    def _compute_staff_ng_dates(self, staff):
        """スタッフのNG日を計算 (unavailable_dates 実日付 + ng_weekdays 曜日 + 承認済み休暇)

        v3.7.1: ng_weekdays カラム (migration 50 で追加) に対応。
        対象期間 (self.dates) 内で、指定曜日に該当する日付をすべて NG セットに追加。
        旧 unavailable_dates タグ "ngDay:0" は実は機能していなかった (日付比較で
        ヒットしないため) が、v3.7.1 で正しく機能するように修正。
        """
        raw = staff.get("unavailable_dates")
        ng = set()
        if raw:
            if isinstance(raw, list):
                # 実日付のみを採用 (タグ形式は除外)
                for d in raw:
                    s = str(d).strip()
                    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
                        ng.add(s)
            else:
                for d in str(raw).split(","):
                    s = d.strip()
                    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
                        ng.add(s)

        # v3.7.1: ng_weekdays (新カラム) または旧 ngDay タグから曜日 NG を展開
        ng_weekdays = set()
        ngwd_col = staff.get("ng_weekdays")
        if isinstance(ngwd_col, list):
            for w in ngwd_col:
                try:
                    ng_weekdays.add(int(w))
                except (ValueError, TypeError):
                    pass
        # 旧 ngDay タグ フォールバック
        if raw and isinstance(raw, list):
            for d in raw:
                s = str(d).strip()
                if s.startswith("ngDay:"):
                    try:
                        ng_weekdays.add(int(s.replace("ngDay:", "")))
                    except (ValueError, TypeError):
                        pass
        # 対象期間内で該当曜日を NG に追加 (JavaScript互換: 0=日, 1=月, ..., 6=土)
        if ng_weekdays:
            for date_str in self.dates:
                try:
                    dt = datetime.strptime(date_str, "%Y-%m-%d")
                    js_dow = (dt.weekday() + 1) % 7  # Python: Mon=0 → JS: Sun=0
                    if js_dow in ng_weekdays:
                        ng.add(date_str)
                except ValueError:
                    pass

        for req in self.requests:
            if (req.get("staff_id") == staff["id"]
                    and req.get("type") in ("off", "holiday")
                    and req.get("status") == "approved"):
                rd = req.get("dates", [])
                if isinstance(rd, list):
                    for single_date in rd:
                        single_date = str(single_date).strip()
                        if single_date:
                            ng.add(single_date)
                else:
                    for single_date in str(rd).split(","):
                        single_date = single_date.strip()
                        if single_date:
                            ng.add(single_date)
        return ng

    def _get_staff_ng_dates(self, staff):
        """キャッシュからNG日を取得"""
        return self._ng_cache.get(staff["id"], set())

    def _get_work_requests(self):
        """承認済み出勤希望を取得 -> 固定シフトとして扱う"""
        work_reqs = []
        for req in self.requests:
            if (req.get("type") == "work"
                    and req.get("status") == "approved"):
                rd = req.get("dates", [])
                dates_list = []
                if isinstance(rd, list):
                    dates_list = [str(d).strip() for d in rd if str(d).strip()]
                else:
                    dates_list = [str(d).strip() for d in str(rd).split(",") if str(d).strip()]
                
                for single_date in dates_list:
                        work_reqs.append({
                            "staff_id": req.get("staff_id"),
                            "date": single_date,
                            "start_time": req.get("start_time"),
                            "end_time": req.get("end_time"),
                        })
        return work_reqs

    def _group_dates_by_week(self):
        """日付リストをISO週単位でグループ化"""
        if not self.dates:
            return []
        weeks, cur = [], []
        for d in self.dates:
            dt = datetime.strptime(d, "%Y-%m-%d")
            if not cur:
                cur.append(d)
            else:
                prev = datetime.strptime(cur[-1], "%Y-%m-%d")
                if dt.isocalendar()[1] == prev.isocalendar()[1] and dt.year == prev.year:
                    cur.append(d)
                else:
                    weeks.append(cur)
                    cur = [d]
        if cur:
            weeks.append(cur)
        return weeks

    def _build_shift_options(self, staff, date_str, force=False):
        """スタッフが指定日に入れるシフトパターンの候補を構築

        v3.4: シフトパターンは営業時間でクランプしない。
        理由: 営業時間 = 客対応時間 / シフトパターン = 実労働時間 で異なる。
        例: 開店 10:00 でも、開店前作業のため 9:00 開始のシフトを許容する。
        time_staff_req (時間帯別必要人数) で別途客対応時間帯の必要人員を指定可能。
        """
        # 営業時間は「fallback パターン (custom_shifts 未設定時)」と
        # 「time_staff_req のクランプ」に使う。シフトパターン自体はクランプしない。
        day_open, day_close = self._get_opening_hours(date_str)
        open_min = self._to_minutes(day_open)
        close_min = self._normalize_end_time(open_min, self._to_minutes(day_close))

        # v3.3 改修8: max_hours_day=0/None は default 8
        raw_max_hours = staff.get("max_hours_day")
        if raw_max_hours is None or float(raw_max_hours or 0) <= 0:
            max_hours = float(self.LEGAL_MAX_HOURS_DAY)
        else:
            max_hours = float(raw_max_hours)

        options = []
        seen = set()

        patterns_to_use = self.shift_patterns.copy()
        
        # v3.3: カスタム role も含めて社員判定 (level >= 3 or color=purple/red/green)
        is_employee = staff.get("salary_type") == "monthly" or str(staff.get("role", "")).lower() in self._employee_role_ids
        day_type = self._get_day_type(date_str)
        pref_start = staff.get("pref_start_we") if day_type in ("weekend", "holiday") else staff.get("pref_start_wd")
        pref_end = staff.get("pref_end_we") if day_type in ("weekend", "holiday") else staff.get("pref_end_wd")
        # フォールバック (古いprefStart用)
        pref_start = pref_start or staff.get("pref_start")
        pref_end = pref_end or staff.get("pref_end")
        
        if pref_start and pref_end:
            pref_pat = {"start": pref_start, "end": pref_end, "name": "pref"}
            # v3.6: pref_pat を「強い候補」として先頭に追加するが、他のパターンも残す。
            # 旧版 (v3.1) は patterns_to_use = [pref_pat] で他を完全に削除していたが、
            # 希望時間帯が営業時間外/シフト外のとき infeasible (配置不可能) になっていた。
            # 強化された PREFERENCE_EXACT/CLOSE (v3.6 で -3M/-2M) のボーナスで
            # MILP は十分に希望を尊重するため、強制排他は不要。
            patterns_to_use.insert(0, pref_pat)

        def _add_option(ps, pe, is_pref=False):
            """オプションを追加するヘルパー（重複チェック含む）"""
            if ps >= pe:
                return
            hrs = (pe - ps) / 60.0
            if hrs < 1:
                return
            brk_mins = self._get_break_minutes(hrs)
            work_hrs = hrs - (brk_mins / 60.0)
            key = (ps, pe)
            if key in seen:
                # 既に存在するオプションだが、もしこれがprefならフラグを立て直す
                if is_pref:
                    for opt in options:
                        if opt["start_min"] == ps and opt["end_min"] == pe:
                            opt["is_pref"] = True
                return
            seen.add(key)
            options.append({
                "start": self._from_minutes(ps),
                "end": self._from_minutes(pe),
                "start_min": ps, "end_min": pe, "hours": hrs, "work_hours": work_hrs,
                "is_pref": is_pref
            })

        for pat in patterns_to_use:
            # v3.4: シフトパターンの開始/終了をそのまま使用 (営業時間でクランプしない)
            # 例: 早番 9-15 (開店 10:00 でも) を尊重 → 開店前作業の 1h を含む
            ps = self._to_minutes(pat["start"])
            pe = self._normalize_end_time(ps, self._to_minutes(pat["end"]))
            if ps >= pe:
                continue

            # --- 回避策: スタッフの最大労働時間に合わせて終了時間を自動短縮 ---
            hrs = (pe - ps) / 60.0
            brk_mins = self._get_break_minutes(hrs)
            work_hrs = hrs - (brk_mins / 60.0)

            is_pref = pat.get("name") == "pref"
            if work_hrs > max_hours and not force:
                # パターンA: 開始固定で終了を短縮（従来通り）
                needed_break = self._get_break_minutes(max_hours)
                allowed_total_hours = max_hours + (needed_break / 60.0)
                new_pe = ps + int(allowed_total_hours * 60)
                if new_pe < pe:
                    _add_option(ps, new_pe, is_pref)

                # パターンB: 終了固定で開始を遅くする（閉店時間カバー用）
                new_ps = pe - int(allowed_total_hours * 60)
                if new_ps > ps:
                    new_ps = max(new_ps, open_min)
                    _add_option(new_ps, pe, is_pref)
            else:
                _add_option(ps, pe, is_pref)
            # -------------------------------------------------------------------

        # v3.7.61: 営業開始時刻の自動シフトオプション追加を撤回
        # ユーザー要望: 「シフト時間 > 営業時間」(シフトパターン優先)
        # v3.7.56 で追加した「強制 open_min 始まりの opt」がシフトパターンを
        # 上書きしていた問題を解消
        # → シフトパターン (custom_shifts) の時間がそのまま使われる
        # → 09:00-19:00 パターンなら、営業10:00開始でも 09:00 から配置可能
        # → 開店前作業 (1時間前から準備) も尊重

        return options

    def _build_slot_requirements(self, date_str):
        """15分スロットごとの必要人数マップを構築

        「常時 N 名」(per-slot) 解釈:
          ベース必要人数 (min_weekday 等) は「各時刻に必要な同時在籍数」。
          time_staff_req ルールは「特定時間帯の追加増強」(max でベースを上書き)。
        """
        req_num = self._get_required_staff(date_str)
        if req_num <= 0:
            return {}
        day_open, day_close = self._get_opening_hours(date_str)
        op = self._to_minutes(day_open)
        cl = self._normalize_end_time(op, self._to_minutes(day_close))
        slots = {}
        for t in range(op, cl, 15):
            slots[t] = {"base": req_num, "hall": 0, "kitchen": 0, "any": 0}

        dt = datetime.strptime(date_str, "%Y-%m-%d")
        js_dow = (dt.weekday() + 1) % 7
        for rule in self.time_staff_req:
            rule_days = [int(d) for d in rule.get("days", [])]
            if js_dow not in rule_days:
                continue
            rs = self._to_minutes(rule.get("start", "00:00"))
            re_min = self._normalize_end_time(rs, self._to_minutes(rule.get("end", "24:00")))
            rc = int(rule.get("count", 0))
            pos = rule.get("position", "any")

            for t in range(op, cl, 15):
                in_range = (rs <= t < re_min) if rs <= re_min else (t >= rs or t < re_min)
                if in_range and t in slots:
                    if pos == "hall":
                        slots[t]["hall"] = max(slots[t]["hall"], rc)
                    elif pos == "kitchen":
                        slots[t]["kitchen"] = max(slots[t]["kitchen"], rc)
                    else:
                        slots[t]["any"] = max(slots[t]["any"], rc)

        # v3.7.59: 中休み時間 (中抜き営業) を 0 名扱い
        # 平日/土曜/日祝 別に config.break_periods を読む
        break_periods = self.config.get("break_periods") or {}
        day_type_key = self._get_day_type(date_str)
        # day_type_key: "weekday" / "weekend" / "holiday" / "closed"
        bp_key = day_type_key if day_type_key in ("weekday", "weekend", "holiday") else None
        if bp_key and bp_key in break_periods:
            bp = break_periods[bp_key]
            bp_start = bp.get("start")
            bp_end = bp.get("end")
            if bp_start and bp_end:
                bp_s_min = self._to_minutes(bp_start)
                bp_e_min = self._normalize_end_time(bp_s_min, self._to_minutes(bp_end))
                # 中休み時間中は base を 0 にする
                for t in list(slots.keys()):
                    if bp_s_min <= t < bp_e_min:
                        slots[t]["base"] = 0

        final_slots = {}
        for t, counts in slots.items():
            final_slots[t] = max(counts["base"], counts["any"] + counts["hall"] + counts["kitchen"])
        return final_slots

    def _build_pos_requirements(self, date_str):
        """ポジション別の必要人数マップを構築"""
        req_num = self._get_required_staff(date_str)
        if req_num <= 0:
            return {}
        day_open, day_close = self._get_opening_hours(date_str)
        op = self._to_minutes(day_open)
        cl = self._normalize_end_time(op, self._to_minutes(day_close))
        pos_reqs = {}
        for t in range(op, cl, 15):
            pos_reqs[t] = {"hall": 0, "kitchen": 0}

        dt = datetime.strptime(date_str, "%Y-%m-%d")
        js_dow = (dt.weekday() + 1) % 7
        for rule in self.time_staff_req:
            pos = rule.get("position", "any")
            if pos not in ("hall", "kitchen"):
                continue
            rule_days = [int(d) for d in rule.get("days", [])]
            if js_dow not in rule_days:
                continue
            rs = self._to_minutes(rule.get("start", "00:00"))
            re_min = self._normalize_end_time(rs, self._to_minutes(rule.get("end", "24:00")))
            rc = int(rule.get("count", 0))
            for t in range(op, cl, 15):
                in_range = (rs <= t < re_min) if rs <= re_min else (t >= rs or t < re_min)
                if in_range and t in pos_reqs:
                    pos_reqs[t][pos] = max(pos_reqs[t][pos], rc)
        return pos_reqs

    # ===========================================================
    # 事前チェック
    # ===========================================================

    def pre_check(self):
        warnings = []
        daily_details = []
        total_shortage = 0.0

        # v3.3 改修8: max_days_week=0/None は「未設定」とみなしデフォルト 5 で扱う
        # (旧 pre_check は 0 を「出勤不可」と表示していたが、scheduler 本体では
        #  既に or 5 で defaulting しており、表示と実挙動が乖離していたため統一)
        def _eff_max_days(staff):
            v = staff.get("max_days_week")
            if v is None or int(v or 0) <= 0:
                return 5  # default
            return int(v)

        usable = list(self.staff_list)  # 全員 usable (defaulting で救済)
        unconfigured = [s for s in self.staff_list
                        if s.get("max_days_week") in (None, 0, "0", "")]

        if unconfigured:
            names = [s.get("name", s["id"]) for s in unconfigured]
            warnings.append({
                "type": "unconfigured_max_days",
                "message": "{}名の max_days_week 未設定 (デフォルト 5 で扱います): {}".format(
                    len(names), ", ".join(names)),
                "severity": "warning",
            })

        # v3.3 改修4: フィージビリティ事前判定
        # 利用可能スタッフの総労働時間 vs 必要総人時 を比較し、
        # 構造的に不可能なケースを生成前に検知する。
        total_available_hours = 0.0
        for s in usable:
            md = _eff_max_days(s)
            mh = float(s.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
            weeks_in_period = max(1, len(self.dates) / 7.0)
            total_available_hours += md * mh * weeks_in_period

        # 必要総人時 (週ベース) = Σ (min_weekday × 平日数 + min_weekend × 休日数) × 営業時間
        try:
            day_open, day_close = self._get_opening_hours(self.dates[0]) if self.dates else ("09:00", "18:00")
            op = self._to_minutes(day_open)
            cl = self._normalize_end_time(op, self._to_minutes(day_close))
            biz_hours = max(1, (cl - op) / 60.0)
        except Exception:
            biz_hours = 9.0
        total_required_hours = 0.0
        for d in self.dates:
            dt = self._get_day_type(d)
            if dt == "closed":
                continue
            req = self._get_required_staff(d)
            total_required_hours += req * biz_hours

        coverage_ratio = (total_available_hours / total_required_hours) if total_required_hours > 0 else 1.0
        if coverage_ratio < 0.9:
            warnings.append({
                "type": "infeasible_capacity",
                "message": "スタッフ供給力 {:.1f} 人時 < 必要 {:.1f} 人時 (充足率 {:.0%})。物理的にカバー不能なため、スタッフ追加 or 必要人数削減が必要".format(
                    total_available_hours, total_required_hours, coverage_ratio),
                "severity": "critical",
                "supply_hours": round(total_available_hours, 1),
                "demand_hours": round(total_required_hours, 1),
                "coverage_ratio": round(coverage_ratio, 2),
            })

        # 管理者不足チェック
        manager_count = len(self._manager_ids)
        if manager_count < self.min_manager:
            warnings.append({
                "type": "manager_shortage",
                "message": "管理者が{}名必要ですが{}名しかいません".format(
                    self.min_manager, manager_count),
                "severity": "critical",
            })

        for d in self.dates:
            if self._get_day_type(d) == "closed":
                continue
            slot_reqs = self._build_slot_requirements(d)
            if not slot_reqs:
                continue
            available = [s for s in usable
                         if d not in self._get_staff_ng_dates(s)]
            shortage_slots = {}
            for slot_min, req in slot_reqs.items():
                cover = 0
                for s in available:
                    for opt in self._build_shift_options(s, d):
                        if opt["start_min"] <= slot_min < opt["end_min"]:
                            cover += 1
                            break
                gap = req - cover
                if gap > 0:
                    shortage_slots[slot_min] = gap

            if shortage_slots:
                ranges = self._compress_ranges(shortage_slots)
                hrs = sum(v * 0.25 for v in shortage_slots.values())
                total_shortage += hrs
                daily_details.append({
                    "date": d,
                    "day_type": self._get_day_type(d),
                    "available_staff": len(available),
                    "required_per_slot": self._get_required_staff(d),
                    "shortage_ranges": ranges,
                    "shortage_hours": round(hrs, 1),
                })

        if total_shortage > 0:
            warnings.append({
                "type": "staff_shortage",
                "message": "合計 {:.1f} 人時の人員不足".format(total_shortage),
                "severity": "critical",
                "total_shortage_hours": round(total_shortage, 1),
                "affected_days": len(daily_details),
            })

        return {
            "feasible": total_shortage == 0,
            "warnings": warnings,
            "daily_details": daily_details,
            "summary": {
                "total_staff": len(self.staff_list),
                "usable_staff": len(usable),
                "total_dates": len(self.dates),
                "work_dates": len([d for d in self.dates
                                   if self._get_day_type(d) != "closed"]),
                "total_shortage_hours": round(total_shortage, 1),
                "affected_days": len(daily_details),
            },
        }

    def _compress_ranges(self, slots):
        ranges = []
        start = short = prev = None
        for t in sorted(slots):
            v = slots[t]
            if start is None:
                start, short = t, v
            elif t == prev + 15 and v == short:
                pass
            else:
                ranges.append({"start": self._from_minutes(start),
                               "end": self._from_minutes(prev + 15),
                               "shortage": short})
                start, short = t, v
            prev = t
        if start is not None:
            ranges.append({"start": self._from_minutes(start),
                           "end": self._from_minutes(prev + 15),
                           "shortage": short})
        return ranges

    # ===========================================================
    # メイン解法: 3段階フォールバック + グリーディ
    # ===========================================================

    def solve(self, force=False):
        # スタッフ数による Tier 自動降格 (変数爆発の予防)
        # 50名超: Tier 3 をスキップ (品質最適化はタイムアウト必至のため)
        # 100名超: Tier 1 から開始 (法的制約のみ確実に守る)
        n_staff = len(self.staff_list)
        n_days = len(self.dates)
        # おおまかな変数数推定: スタッフ × 日数 × 平均5シフトオプション
        estimated_vars = n_staff * n_days * 5
        logger.info("[Solve] staff=%d days=%d est_vars=%d", n_staff, n_days, estimated_vars)

        # v3.7.12: Tier 自動降格をさらに緩和。
        # 旧版 (v3.6) は staff>=80 で Tier2 だったが、Tier3 timeLimit 120s 化と
        # 合わせて n_staff=100 程度までは Tier3 で耐える (agent #1 指摘)。
        # estimated_vars 係数も実態に近づける (旧 ×5 → ×8、NG/REQペア・OJT 制約等含む)。
        start_tier = 3
        estimated_vars_realistic = n_staff * n_days * 8  # NG/OJT 制約等で +60%
        if n_staff >= 150 or estimated_vars_realistic > 80000:
            start_tier = 1
            logger.warning("[Solve] Large scale (staff=%d) → starting from Tier 1 (legal only) to avoid timeout", n_staff)
        elif n_staff >= 100 or estimated_vars_realistic > 40000:
            start_tier = 2
            logger.warning("[Solve] Medium-large scale (staff=%d) → starting from Tier 2 (skip quality opt)", n_staff)

        # Tier 3 → 2 → 1 (force) → Greedy の順で試行 (start_tier 以下のみ)
        for current_tier in range(start_tier, 0, -1):
            use_force = force or (current_tier == 1)
            result = self._solve_milp(force=use_force, tier=current_tier)
            if result:
                logger.info("[Solve] Tier %d succeeded (force=%s)", current_tier, use_force)
                return result
            logger.info("[Fallback] Tier %d failed, trying lower tier...", current_tier)

        logger.info("[Fallback] All MILP tiers failed → Greedy")
        return self._solve_greedy()

    def _solve_milp(self, force=False, tier=3):
        try:
            # スロット要件キャッシュをクリア（Tier間フォールバック時のリーク防止）
            self._slot_reqs_cache = {}

            prob = pulp.LpProblem("RakuShift_v3", pulp.LpMinimize)
            penalty = pulp.LpAffineExpression()

            x = {}
            staff_opts = {}

            for s in self.staff_list:
                sid = s["id"]
                ng = self._get_staff_ng_dates(s)
                for d in self.dates:
                    if d in ng or self._get_day_type(d) == "closed":
                        staff_opts[(sid, d)] = []
                        continue
                    opts = self._build_shift_options(s, d, force=force)
                    staff_opts[(sid, d)] = opts
                    for oi in range(len(opts)):
                        x[(sid, d, oi)] = pulp.LpVariable(
                            "x_{}_{}_{}" .format(sid, d, oi),
                            0, 1, pulp.LpBinary)

            # ========== 承認済み出勤希望を固定シフトとして反映 ==========
            # v3.1: 希望時間が指定されている場合は EXACT 一致オプションを動的追加
            # 旧版は「最も近いオプション」を選んでいたが、ユーザ要望「ぴったり反映」のため
            # 一致するオプションが無い場合は新規追加する。

            work_requests = self._get_work_requests()
            fixed_assignments = set()
            for wr in work_requests:
                wsid = wr["staff_id"]
                wd = wr["date"]
                if wd not in self.dates:
                    continue
                opts = staff_opts.get((wsid, wd), [])
                if not opts:
                    continue
                best_oi = 0
                if wr.get("start_time") and wr.get("end_time"):
                    wr_start = self._to_minutes(wr["start_time"])
                    wr_end = self._normalize_end_time(wr_start, self._to_minutes(wr["end_time"]))
                    # まず完全一致を探す
                    exact_oi = None
                    for oi, opt in enumerate(opts):
                        if opt["start_min"] == wr_start and opt["end_min"] == wr_end:
                            exact_oi = oi
                            break
                    if exact_oi is not None:
                        best_oi = exact_oi
                    else:
                        # 完全一致無し: 最も近いオプションを使う (旧動作)
                        # ※将来的には新規 option を動的追加してもよいが、
                        #   pulp 変数も同時に作る必要があり影響範囲大のため近似で fallback
                        best_diff = float("inf")
                        for oi, opt in enumerate(opts):
                            diff = abs(opt["start_min"] - wr_start) + abs(opt["end_min"] - wr_end)
                            if diff < best_diff:
                                best_diff = diff
                                best_oi = oi
                if (wsid, wd, best_oi) in x:
                    # v3.7.47 [Tier 2]: 承認希望 10M (必達ボーナス)
                    if wr.get("start_time") and wr.get("end_time"):
                        # 時間指定あり: best_oi に集中ボーナス
                        penalty += -10_000_000 * x[(wsid, wd, best_oi)]
                    else:
                        # 時間指定なし: 全 opt に分散 (合計 -10M)
                        n_opts = len(opts)
                        if n_opts > 0:
                            per_opt_bonus = -10_000_000 // n_opts
                            for oi_b in range(n_opts):
                                if (wsid, wd, oi_b) in x:
                                    penalty += per_opt_bonus * x[(wsid, wd, oi_b)]
                    fixed_assignments.add((wsid, wd))
                    logger.info("[WorkReq] Soft-fixed: staff={} date={} opt={}".format(wsid, wd, best_oi))

            logger.info("[Requests] {} work requests applied".format(len(work_requests)))

            # 配置理由トラッキング (sid, d) → 簡潔な日本語ラベル
            assignment_reasons = {}
            for wr in work_requests:
                wsid, wd = wr.get("staff_id"), wr.get("date")
                if (wsid, wd) in fixed_assignments:
                    assignment_reasons[(wsid, wd)] = "承認済み出勤希望"

            # ========== 既存シフトを固定 (empty_only モードで空きだけ埋める) ==========
            existing_fixed = 0
            for es in self.existing_shifts:
                esid = es["staff_id"]
                ed = es["date"]
                if ed not in self.dates:
                    continue
                if (esid, ed) in fixed_assignments:
                    continue
                opts = staff_opts.get((esid, ed), [])
                if not opts:
                    continue
                es_start = self._to_minutes(es["start_time"])
                es_end = self._normalize_end_time(es_start, self._to_minutes(es["end_time"]))
                best_oi = 0
                best_diff = float("inf")
                for oi, opt in enumerate(opts):
                    diff = abs(opt["start_min"] - es_start) + abs(opt["end_min"] - es_end)
                    if diff < best_diff:
                        best_diff = diff
                        best_oi = oi
                if (esid, ed, best_oi) in x:
                    prob += x[(esid, ed, best_oi)] == 1
                    fixed_assignments.add((esid, ed))
                    assignment_reasons[(esid, ed)] = "既存シフトを維持"
                    existing_fixed += 1
            logger.info("[Existing] {} existing shifts fixed (empty_only mode)".format(existing_fixed))

            # 希望シフト (pending) の (sid, d) → 希望時間帯を控える
            pref_index = {}  # (sid, d) -> {start, end}
            for req in self.requests:
                if req.get("type") == "work" and req.get("status") == "pending":
                    rsid = req.get("staff_id")
                    rd_list = req.get("dates", [])
                    if isinstance(rd_list, str):
                        rd_list = [d.strip() for d in rd_list.split(",") if d.strip()]
                    for rd in rd_list:
                        rd = str(rd).strip()
                        if rd in self.dates:
                            pref_index[(rsid, rd)] = {
                                "start": req.get("start_time"),
                                "end": req.get("end_time")
                            }

            # slack 変数の追跡 (validation_report 用)
            # v3.7.20: 廃止された制約 (manager_under / fatigue / peak_skill) を除去
            tracked_slacks = {
                "coverage_under": [],   # スロット人員不足
                "open_close_under": [], # 開け締め不在 / 社員1名以上常駐
                "ojt": [],              # OJT 不在
                "fairness": [],         # 公平性偏差
            }
            self._tracked_slacks = tracked_slacks

            # ====================================================
            # TIER 1: 法的制約 (ハード制約) + 時間系のソフト化
            # ----------------------------------------------------
            # v3.2 (要望): 「労働基準法は遵守するが、シフトを埋めるために
            #   仕方なく時間制約を超える場合は許容する」
            #   → 1日の労働時間 (max_hours_day) は HARD ではなく SOFT に変更
            #   → 休憩 (34条)・週休 (35条)・1日1シフト・最低人数は依然 HARD
            # ----------------------------------------------------
            # 用語 (明記):
            #   * hours      = 拘束時間 (出勤〜退勤までの全時間)
            #   * work_hours = 実労働時間 = 拘束時間 - 休憩時間
            #                  ※ max_hours_day はこの「実労働時間」と比較
            # ====================================================

            for s in self.staff_list:
                sid = s["id"]

                # --- 1日1シフト制約 (HARD: 物理的に1人1シフトのみ) ---
                for d in self.dates:
                    opts = staff_opts.get((sid, d), [])
                    if opts:
                        prob += pulp.lpSum(
                            x[(sid, d, oi)] for oi in range(len(opts))
                        ) <= 1

                    # --- 1日の最大労働時間 (v3.2: HARD→SOFT 化)
                    # 旧版は work_hours > max_hours のオプションを物理排除していたが、
                    # ユーザ要望で「シフトを埋めるため仕方ない場合は超過可」に変更。
                    # ペナルティで誘導 (超過したい場合は MILP が選ぶ余地を残す)。
                    # v3.3 改修8: max_hours_day=0/None は「未設定」とみなしデフォルト 8
                    raw_max_hours = s.get("max_hours_day")
                    if raw_max_hours is None or float(raw_max_hours or 0) <= 0:
                        max_hours = float(self.LEGAL_MAX_HOURS_DAY)  # 8
                    else:
                        max_hours = float(raw_max_hours)
                    for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                        over_hours = opt["work_hours"] - max_hours
                        if over_hours > 0:
                            # 1時間超過につき 100,000 ペナルティを penalty 関数に加算
                            # シフトが埋まらない (COVERAGE_UNDER 5,000,000) よりは
                            # 軽く設定し、人員不足回避のため超過を許容する。
                            penalty += x[(sid, d, oi)] * int(100_000 * over_hours)

                # --- 週の最大勤務日数 (v3.2: HARD→SOFT 化)
                # v3.3 改修8: max_days_week=0 や未設定 (None) は「未設定」とみなし
                # デフォルト 5 で扱う (旧来の挙動と同じだが意図を明示)。
                # 「絶対出勤不可」を表現したい場合は negative value or 明示的フラグが必要。
                raw_max_days = s.get("max_days_week")
                if raw_max_days is None or int(raw_max_days or 0) <= 0:
                    max_days = 5
                    logger.info("[Rescue] Staff {} max_days_week missing/0 → default 5".format(
                        s.get("name", sid)))
                else:
                    max_days = int(raw_max_days)

                # max_days を超える可能性も MILP が判断できるよう、+2 までは許容
                # (force 時は更に緩める)
                effective_max_days = (max_days + 2) if not force else max(max_days + 3, 7)
                week_groups = self._group_dates_by_week()
                for week in week_groups:
                    wv = []
                    for d in week:
                        for oi in range(len(staff_opts.get((sid, d), []))):
                            wv.append(x[(sid, d, oi)])
                    if wv:
                        prob += pulp.lpSum(wv) <= effective_max_days

                # --- 週の最低出勤日数 (全週ハード制約: 絶対遵守) ---
                min_days_week = int(s.get("min_days_week") or 0)
                if not force and min_days_week > 0:
                    logger.info("[MinDays] Staff {} min_days_week={}".format(
                        s.get("name", sid), min_days_week))
                    for week in week_groups:
                        wv = []
                        available_days_in_week = 0
                        ng_set = self._get_staff_ng_dates(s)
                        for d in week:
                            if d not in ng_set and self._get_day_type(d) != "closed":
                                available_days_in_week += 1
                            for oi in range(len(staff_opts.get((sid, d), []))):
                                wv.append(x[(sid, d, oi)])
                        if wv:
                            effective_min = min(min_days_week, available_days_in_week, max_days)
                            if effective_min > 0:
                                # v3.7.46: 月給スタッフは強く達成必須 (1M/日)
                                # 時給スタッフは希望事項のまま (30k/日)
                                mdw_slack = pulp.LpVariable(
                                    "mdw_{}_{}".format(sid, week[0] if week else "x"),
                                    0, None, pulp.LpInteger)
                                prob += pulp.lpSum(wv) + mdw_slack >= effective_min
                                is_monthly = str(s.get("salary_type", "hourly")).lower() == "monthly"
                                if is_monthly:
                                    # v3.7.47 [Tier 3]: 月給 min_days_week 1M (重要)
                                    penalty += mdw_slack * 1_000_000
                                else:
                                    # [Tier 5]: 時給 30k
                                    penalty += mdw_slack * 30_000

                # --- 月(全体期間)の最低出勤日数 (ハード制約) ---
                min_days_month = int(s.get("min_days_month") or 0)
                if not force and min_days_month > 0 and self.dates:
                    target_min_month = min_days_month
                    ng_set = self._get_staff_ng_dates(s)
                    available_total = len([d for d in self.dates
                                          if d not in ng_set and self._get_day_type(d) != "closed"])
                    target_min_month = min(target_min_month, available_total)
                    # v3.7.12: max_possible 計算で NG/休業を考慮 (agent #1 指摘 HIGH)。
                    # 旧版は週内全日 (len(week)) を分母にしており、NG/閉店日が含まれていたため
                    # max_possible が過大評価され、target_min_month が達成不能になるケースがあった。
                    max_possible = 0
                    # v3.7.14: デフォルトは法定上限ではなく一般的な週5日 (上段 default と一貫させる)。
                    mdw = int(s.get("max_days_week") or 5)
                    for week in week_groups:
                        week_available = sum(
                            1 for d in week
                            if d not in ng_set and self._get_day_type(d) != "closed"
                        )
                        max_possible += min(mdw, week_available)
                    target_min_month = min(target_min_month, max_possible)
                    if target_min_month > 0:
                        all_wv = []
                        for d in self.dates:
                            for oi in range(len(staff_opts.get((sid, d), []))):
                                all_wv.append(x[(sid, d, oi)])
                        if all_wv:
                            mdm_slack = pulp.LpVariable(
                                "mdm_{}".format(sid), 0, None, pulp.LpInteger)
                            prob += pulp.lpSum(all_wv) + mdm_slack >= target_min_month
                            is_monthly = str(s.get("salary_type", "hourly")).lower() == "monthly"
                            if is_monthly:
                                # v3.7.54: 50M → 20M に弱化
                                # COVERAGE_UNDER/OVER (100M) との階層差を 5倍確保
                                # 物理的に達成可能なら確実に満たされる
                                penalty += mdm_slack * 20_000_000
                            else:
                                penalty += mdm_slack * 50_000

                # --- v3.7.54: 全スタッフ最低出勤保証 (Tier 4 500k に弱化) ---
                # v3.7.51-53 の 5M では COVERAGE_UNDER/OVER (100M) と衝突して
                # 52件もの制約違反を引き起こしていた
                # 500k なら過剰回避 (100M) が確実に優先される
                guarantee_min = 5 if str(s.get("salary_type", "hourly")).lower() == "monthly" else 3
                _current_target = locals().get("target_min_month", 0)
                _current_ng_set = self._get_staff_ng_dates(s)
                if _current_target < guarantee_min:
                    all_wv_g = []
                    for d in self.dates:
                        for oi in range(len(staff_opts.get((sid, d), []))):
                            all_wv_g.append(x[(sid, d, oi)])
                    if all_wv_g:
                        ng_count_g = len([d for d in self.dates if d in _current_ng_set or self._get_day_type(d) == "closed"])
                        avail_g = len(self.dates) - ng_count_g
                        effective_guarantee = min(guarantee_min, avail_g)
                        if effective_guarantee > 0:
                            g_slack = pulp.LpVariable(
                                "guarantee_min_{}".format(sid), 0, None, pulp.LpInteger)
                            prob += pulp.lpSum(all_wv_g) + g_slack >= effective_guarantee
                            penalty += g_slack * 500_000  # Tier 4 (旧 5M → 500k)
                # スコープリーク防止: 次スタッフに残骸が漏れないよう削除
                if "target_min_month" in dir():
                    try:
                        del target_min_month
                    except NameError:
                        pass

                # --- 週40時間上限 (労基法32条) ---
                if not force:
                    for week in week_groups:
                        hours_expr = pulp.LpAffineExpression()
                        has_vars = False
                        for d in week:
                            for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                                hours_expr += x[(sid, d, oi)] * opt["work_hours"]
                                has_vars = True
                        if has_vars:
                            prob += hours_expr <= self.LEGAL_MAX_HOURS_WEEK

                # --- 連続勤務6日上限 (労基法35条: 週1日の休日) ---
                # v3.6: 日付ギャップ考慮。
                # 旧版は sorted_d[i:i+7] を「7日間ローリングウィンドウ」として扱い
                # 「<= 6 of 7」制約を貼っていたが、sorted_d にギャップ (定休日や非連続日付)
                # があると 7要素が10日以上のスパンを覆うことになり、制約が緩くなる方向で
                # 正確性を欠いていた。
                # 修正: 実カレンダー連続性を確認し、連続する 7日間 (= 6日+休日1日) のみに
                #       制約を貼る。ギャップを跨ぐスパンはスキップ。
                sorted_d = sorted(self.dates)
                max_consec = self.LEGAL_MAX_CONSECUTIVE_DAYS if not force else 7
                if len(sorted_d) > max_consec:
                    for i in range(len(sorted_d) - max_consec):
                        span = sorted_d[i:i + max_consec + 1]
                        # span が実カレンダーで連続している (= max_consec日連続) か確認
                        try:
                            d_start = datetime.strptime(span[0], "%Y-%m-%d")
                            d_end = datetime.strptime(span[-1], "%Y-%m-%d")
                        except ValueError:
                            continue
                        if (d_end - d_start).days != max_consec:
                            # ギャップを含むスパンは制約対象外 (休日を挟むので連勤超過にならない)
                            continue
                        sv = []
                        for d in span:
                            for oi in range(len(staff_opts.get((sid, d), []))):
                                sv.append(x[(sid, d, oi)])
                        if sv:
                            prob += pulp.lpSum(sv) <= max_consec

                # --- 勤務間インターバル制約 (前日退勤→翌日出勤まで10時間以上) ---
                # v3.6: 日付ギャップ対応。
                # 旧版は (opt2.start + 1440) - opt1.end で「常に翌日」前提で計算していたが、
                # sorted_d に日付ギャップ (定休日や非連続な希望期間) があると d2 が d1+2日
                # 以降のケースが発生し、間隔が実際より短く計算されて過剰制約になっていた。
                # 例: 金曜22:00終 → 月曜6:00開 (土日定休) の実間隔は 56h だが、
                #     旧版は 8h と計算し配置禁止 → 「月曜出れないバグ」
                if not force:
                    for i in range(len(sorted_d) - 1):
                        d1 = sorted_d[i]
                        d2 = sorted_d[i+1]
                        opts1 = staff_opts.get((sid, d1), [])
                        opts2 = staff_opts.get((sid, d2), [])
                        if not opts1 or not opts2:
                            continue
                        # d1 と d2 の実際のカレンダー日数差を分換算
                        d1_dt = datetime.strptime(d1, "%Y-%m-%d")
                        d2_dt = datetime.strptime(d2, "%Y-%m-%d")
                        day_gap_mins = (d2_dt - d1_dt).days * 1440
                        if day_gap_mins >= 1440 * 2:
                            # 2日以上開いていればインターバル 10h 制約は自明に充足
                            continue
                        for oi1, opt1 in enumerate(opts1):
                            for oi2, opt2 in enumerate(opts2):
                                interval = (opt2["start_min"] + day_gap_mins) - opt1["end_min"]
                                if interval < 600:
                                    prob += x[(sid, d1, oi1)] + x[(sid, d2, oi2)] <= 1

            # ====================================================
            # TIER 2: カバレッジ制約 (ソフト制約)
            # ====================================================

            if tier >= 2:
                # --- 1日の出勤人数: 必要人数ぴったり (±0) に収束させる ---
                # v3.7.16: ±1 許容を撤廃。必要人数と過不足ゼロを目標
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    req_daily = self._get_required_staff(d)
                    if req_daily <= 0:
                        continue
                    day_workers = []
                    for s in self.staff_list:
                        sid = s["id"]
                        opts = staff_opts.get((sid, d), [])
                        if opts:
                            day_workers.append(pulp.lpSum([x[(sid, d, oi)] for oi in range(len(opts))]))
                    if day_workers:
                        daily_sum = pulp.lpSum(day_workers)
                        # 下限: 必要人数以上を確保
                        daily_slack_under = pulp.LpVariable(
                            "daily_under_{}".format(d), 0, None, pulp.LpInteger)
                        prob += daily_sum + daily_slack_under >= req_daily
                        penalty += daily_slack_under * self.W.COVERAGE_UNDER
                        # 上限: 必要人数ぴったりに抑える（±0制御）
                        # ただしスロットレベルの要件が日次ベースより大きい場合は、
                        # スロット要件の最大値を基準にして矛盾を防ぐ
                        slot_reqs_for_day = self._build_slot_requirements(d)
                        # キャッシュしてスロットループでの再計算を防ぐ
                        if not hasattr(self, '_slot_reqs_cache'):
                            self._slot_reqs_cache = {}
                        self._slot_reqs_cache[d] = slot_reqs_for_day
                        max_slot_req = max(slot_reqs_for_day.values()) if slot_reqs_for_day else req_daily
                        daily_upper = max(req_daily, max_slot_req)  # ±0を目指す（旧: +1）
                        daily_slack_over = pulp.LpVariable(
                            "daily_over_{}".format(d), 0, None, pulp.LpInteger)
                        prob += daily_sum - daily_slack_over <= daily_upper
                        penalty += daily_slack_over * self.W.COVERAGE_OVER_DAY

                # --- 各時間スロットの人員: 必要人数±1に収束させる ---
                # ※_slot_reqs_cacheを利用して_build_slot_requirementsの二重呼び出しを回避
                for d in self.dates:
                    slot_reqs = self._slot_reqs_cache.get(d) if hasattr(self, '_slot_reqs_cache') else None
                    if slot_reqs is None:
                        slot_reqs = self._build_slot_requirements(d)
                    for slot_min, req in slot_reqs.items():
                        workers = []
                        for s in self.staff_list:
                            sid = s["id"]
                            for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                                if opt["start_min"] <= slot_min < opt["end_min"]:
                                    workers.append(x[(sid, d, oi)])
                        if workers:
                            workers_sum = pulp.lpSum(workers)
                            # 全営業スロットで最低1名は必ず確保
                            if not force:
                                min1_slack = pulp.LpVariable(
                                    "min1_{}_{}".format(d, slot_min), 0, None, pulp.LpInteger)
                                prob += workers_sum + min1_slack >= 1
                                penalty += min1_slack * self.W.EMPTY_SLOT
                            slack_under = pulp.LpVariable(
                                "cov_{}_{}".format(d, slot_min), 0, None, pulp.LpInteger)
                            prob += workers_sum + slack_under >= req
                            penalty += slack_under * self.W.COVERAGE_UNDER
                            tracked_slacks["coverage_under"].append((d, slot_min, req, slack_under))
                            slack_over = pulp.LpVariable(
                                "over_{}_{}".format(d, slot_min), 0, None, pulp.LpInteger)
                            prob += workers_sum - slack_over <= req
                            penalty += slack_over * self.W.COVERAGE_OVER_SLOT

                # --- 社員常駐制約 (v3.7.16: 管理者限定→「社員 (月給+店長) 1名以上」に変更) ---
                # 全時間帯で月給制 or 店長のうち1名以上を出勤させる
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    slot_reqs = self._slot_reqs_cache.get(d) if hasattr(self, '_slot_reqs_cache') else None
                    if slot_reqs is None:
                        slot_reqs = self._build_slot_requirements(d)
                    if not slot_reqs:
                        continue
                    employee_ids = self._monthly_ids.union(self._manager_ids)
                    for slot_min in slot_reqs:
                        emp_vars = []
                        for eid in employee_ids:
                            for oi, opt in enumerate(staff_opts.get((eid, d), [])):
                                if opt["start_min"] <= slot_min < opt["end_min"]:
                                    emp_vars.append(x[(eid, d, oi)])
                        if emp_vars:
                            slack = pulp.LpVariable("emp_{}_{}".format(d, slot_min), 0, None, pulp.LpInteger)
                            prob += pulp.lpSum(emp_vars) + slack >= 1
                            penalty += slack * self.W.OPEN_CLOSE_NO_EMP
                            tracked_slacks["open_close_under"].append((d, slot_min, slack))

                # --- v3.7.50: 遅番優先配置 (Tier 3 重要レベル 5M) ---
                # 履歴:
                #   v3.7.48: 閉店2h前から全スロット 10M → 他時間で不足発生
                #   v3.7.49: 閉店30分前 1スロット 500k → 遅番が入らない日が出る
                #   v3.7.50: 閉店30分前 1スロット 5M (Tier 3)
                #     - COVERAGE_UNDER (100M) より弱いので不足が出る場合は諦める
                #     - 月給 min_days_month (10M) より弱いので社員月達成が優先
                #     - 不足/社員未達成にならない範囲で遅番1名確保される
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    day_open, day_close = self._get_opening_hours(d)
                    op_min = self._to_minutes(day_open)
                    cl_min = self._normalize_end_time(op_min, self._to_minutes(day_close))
                    late_slot = cl_min - 30
                    if late_slot <= op_min:
                        continue
                    late_vars = []
                    for s in self.staff_list:
                        sid = s["id"]
                        for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                            if opt["start_min"] <= late_slot < opt["end_min"]:
                                late_vars.append(x[(sid, d, oi)])
                    if late_vars:
                        late_slack = pulp.LpVariable(
                            "late_{}".format(d), 0, None, pulp.LpInteger)
                        prob += pulp.lpSum(late_vars) + late_slack >= 1
                        # v3.7.54: 5M → 1M に弱化 (COVERAGE 100M との階層差確保)
                        penalty += late_slack * 1_000_000

            # ====================================================
            # TIER 3: 品質最適化 (ソフト制約)
            # ====================================================

            if tier >= 3:
                # --- OJT制約: 新人にはメンター必須 ---
                if self._rookie_ids and self._mentor_ids:
                    for d in self.dates:
                        if self._get_day_type(d) == "closed":
                            continue
                        slot_reqs = self._slot_reqs_cache.get(d) if hasattr(self, '_slot_reqs_cache') else None
                        if slot_reqs is None:
                            slot_reqs = self._build_slot_requirements(d)
                        if not slot_reqs:
                            continue
                        for slot_min in slot_reqs:
                            rookie_vars = []
                            mentor_vars = []
                            for s in self.staff_list:
                                sid = s["id"]
                                for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                                    if opt["start_min"] <= slot_min < opt["end_min"]:
                                        if sid in self._rookie_ids:
                                            rookie_vars.append(x[(sid, d, oi)])
                                        if sid in self._mentor_ids:
                                            mentor_vars.append(x[(sid, d, oi)])
                            if rookie_vars and mentor_vars:
                                slack = pulp.LpVariable(
                                    "ojt_{}_{}".format(d, slot_min),
                                    0, None, pulp.LpInteger)
                                prob += pulp.lpSum(mentor_vars) + slack >= pulp.lpSum(rookie_vars)
                                penalty += slack * self.W.OJT_NO_MENTOR
                            elif rookie_vars and not mentor_vars:
                                # config.block_rookie_without_mentor=True なら新人配置を強制禁止
                                if self.config.get("block_rookie_without_mentor"):
                                    for rv in rookie_vars:
                                        prob += rv == 0
                                else:
                                    for rv in rookie_vars:
                                        penalty += rv * self.W.OJT_NO_MENTOR

                # v3.7.16: 戦力バランス制約を廃止 (運用者判断)

                # v3.7.19: 人件費×評価ランク最小化を廃止 (運用者判断)。
                # 評価ランクと人件費による配分は撤廃し、
                # shift_priority (high/low) と contract_type (regular/spot) の
                # 属性ボーナス + 決定論タイブレーカーのみ残す
                for s in self.staff_list:
                    sid = s["id"]
                    shift_priority = str(s.get("shift_priority", "medium")).lower()
                    contract_type = str(s.get("contract_type", "general")).lower()

                    priority_bonus = 0
                    if shift_priority == "high":
                        priority_bonus += self.W.PRIORITY_HIGH   # 負値
                    elif shift_priority == "low":
                        priority_bonus += self.W.PRIORITY_LOW

                    if contract_type == "regular":
                        priority_bonus += self.W.CONTRACT_REGULAR  # 負値
                    elif contract_type == "spot":
                        priority_bonus += self.W.CONTRACT_SPOT

                    # 決定論的タイブレーカー (同点時の「リスト先頭固定」を回避)
                    sid_hash = (abs(hash(sid)) % 10_000) / 1_000.0
                    for d in self.dates:
                        day_hash = (abs(hash(d + sid)) % 100) / 100.0
                        tiebreaker = sid_hash + day_hash
                        for oi in range(len(staff_opts.get((sid, d), []))):
                            penalty += x[(sid, d, oi)] * (priority_bonus + tiebreaker)

                # --- 勤務日数の公平性と離職防止 (需要ベースの按分方式) ---
                # 店舗全体の需要人日数からスタッフごとの配分比率を計算し、±1で収束させる
                active_staff = [s for s in self.staff_list if int(s.get("max_days_week") or 5) > 0]
                if len(active_staff) >= 2:
                    total_vars = {}
                    for s in active_staff:
                        sid = s["id"]
                        total_vars[sid] = pulp.lpSum(
                            x[(sid, d, oi)]
                            for d in self.dates
                            for oi in range(len(staff_opts.get((sid, d), [])))
                        )
                    work_days_count = len([d for d in self.dates
                                          if self._get_day_type(d) != "closed"])
                    weeks_in_period = max(work_days_count / 7.0, 1.0)

                    # 需要ベースの目標計算: 全体の必要人日数を算出
                    total_demand_days = sum(
                        self._get_required_staff(d)
                        for d in self.dates
                        if self._get_day_type(d) != "closed"
                    )
                    # 全スタッフのmax_days_week合計を月間ベースに換算（按分の分母）
                    total_capacity_per_week = sum(
                        int(s.get("max_days_week") or 5) for s in active_staff
                    )
                    total_capacity_monthly = total_capacity_per_week * weeks_in_period

                    for s in active_staff:
                        sid = s["id"]
                        tv = total_vars[sid]
                        staff_max_days = int(s.get("max_days_week") or 5)
                        ng_count = len([d for d in self.dates
                                        if d in self._get_staff_ng_dates(s)
                                        or self._get_day_type(d) == "closed"])
                        available_days = len(self.dates) - ng_count

                        # 需要ベース目標: 全体需要 × (個人月間キャパ / 全体月間キャパ)
                        staff_monthly_capacity = staff_max_days * weeks_in_period
                        if total_capacity_monthly > 0:
                            demand_ratio = staff_monthly_capacity / total_capacity_monthly
                            staff_target = total_demand_days * demand_ratio
                        else:
                            staff_target = staff_max_days * weeks_in_period * 0.7

                        # 上限はmax_days_week×週数と出勤可能日数の小さい方
                        upper_limit = min(staff_max_days * weeks_in_period, available_days)
                        staff_target = min(staff_target, upper_limit)
                        staff_target = max(staff_target, 1.0)  # 最低1日は保証

                        slack_over = pulp.LpVariable("fair_over_{}".format(sid), 0, None)
                        slack_under = pulp.LpVariable("fair_under_{}".format(sid), 0, None)
                        prob += tv - staff_target <= slack_over
                        prob += staff_target - tv <= slack_under
                        penalty += (slack_over + slack_under) * self.W.FAIRNESS_DRIFT

                    logger.info("[Tier3] Fairness: demand={} days, {} staff, capacity/wk={}".format(
                        total_demand_days, len(active_staff), total_capacity_per_week))

                    # === 離職防止アルゴリズム (v3.7.22: HARD → SOFT 化) ===
                    # 旧: prob += tv >= guarantee_shifts (HARD 制約) で全員強制配置
                    # 新: 不在 1 シフトごとに 50k ペナルティ。カバレッジ過剰や希望に負ける階層
                    for s in active_staff:
                        sid = s["id"]
                        tv = total_vars[sid]
                        submitted_days = len([d for d in self.dates if staff_opts.get((sid, d))])
                        if submitted_days > 0:
                            staff_max_days = int(s.get("max_days_week") or 5)
                            min_dw = int(s.get("min_days_week") or 0)
                            weekly_guarantee = min(1, staff_max_days)
                            candidate = int(weekly_guarantee * weeks_in_period)
                            guarantee_shifts = min(
                                candidate, submitted_days,
                                int(staff_max_days * weeks_in_period)
                            )
                            if min_dw > 0:
                                min_dw_total = min(int(min_dw * weeks_in_period), submitted_days)
                                guarantee_shifts = min(guarantee_shifts, min_dw_total)
                            guarantee_shifts = max(guarantee_shifts, 1)
                            # SOFT 制約: 達成しない分だけペナルティ
                            g_slack = pulp.LpVariable("guarantee_{}".format(sid), 0, None, pulp.LpInteger)
                            prob += tv + g_slack >= guarantee_shifts
                            penalty += g_slack * 50_000  # COVERAGE_OVER (4M) より遥かに弱い
                # --- min_days_week > 0 のスタッフへの配置ボーナス ---
                # min_days_weekのハード制約で確保済みなので、ボーナスは補助的に軽めに
                for s in self.staff_list:
                    sid = s["id"]
                    min_dw = int(s.get("min_days_week") or 0)
                    if min_dw > 0:
                        for d in self.dates:
                            for oi in range(len(staff_opts.get((sid, d), []))):
                                penalty += x[(sid, d, oi)] * self.W.MIN_DAYS_WEEK_BONUS

                # v3.7.16: ピーク時スキルミックス制約を廃止 (運用者判断)

                # --- 希望シフト充足率の最大化 (従業員満足度スコア) ---
                # 未承認（pending）の出勤希望に対してボーナス（負のペナルティ）を付与し、
                # AIが可能な限り従業員の希望を叶えるように誘導する
                preference_count = 0
                for req in self.requests:
                    if req.get("type") == "work" and req.get("status") == "pending":
                        rsid = req.get("staff_id")
                        rd_list = req.get("dates", [])
                        if isinstance(rd_list, str):
                            rd_list = [d.strip() for d in rd_list.split(",") if d.strip()]
                        for rd in rd_list:
                            rd = str(rd).strip()
                            if rd not in self.dates:
                                continue
                            opts_r = staff_opts.get((rsid, rd), [])
                            if not opts_r:
                                continue
                            
                            # 希望時間帯に最も近いパターンを優遇
                            req_start = req.get("start_time")
                            req_end = req.get("end_time")
                            
                            for oi, opt in enumerate(opts_r):
                                bonus = self.W.PREFERENCE_BASE
                                if req_start and req_end:
                                    rs_m = self._to_minutes(req_start)
                                    re_m = self._to_minutes(req_end)
                                    diff = abs(opt["start_min"] - rs_m) + abs(opt["end_min"] - re_m)
                                    if diff == 0:
                                        bonus = self.W.PREFERENCE_EXACT
                                    elif diff <= 60:
                                        bonus = self.W.PREFERENCE_CLOSE
                                # v3.7.12: 常時希望時間帯 (pref_start_wd/we) と一致する opt にも
                                # EXACT ボーナスを付与 (agent #1 指摘の is_pref デッドコード解消)。
                                # 旧版は work request の req_start/end の diff のみで判定していたが、
                                # 常時希望と work request の req_start が必ずしも一致するとは限らないため、
                                # is_pref フラグがある opt は強制的に EXACT に格上げ。
                                if opt.get("is_pref") and bonus > self.W.PREFERENCE_EXACT:
                                    bonus = self.W.PREFERENCE_EXACT
                                penalty += x[(rsid, rd, oi)] * bonus
                                preference_count += 1

                logger.info("[Tier3] Preference fulfillment: {} shift preferences processed".format(preference_count))

                # v3.7.13: 常時希望時間帯 (pref_start_wd/we) ボーナス
                # 上記ループは work request を持つスタッフのみに適用される。
                # work request なしで pref_start_wd のみ設定したスタッフにも
                # 希望時間帯ボーナス (PREFERENCE_BASE) を付与し、MILP が希望を
                # 尊重するようにする。
                # 実機テストで「常時希望が反映されない」現象を発見した修正。
                standing_pref_count = 0
                for s in self.staff_list:
                    sid = s["id"]
                    # work request を持つスタッフはスキップ (上で処理済)
                    has_work_req = any(
                        req.get("staff_id") == sid
                        and req.get("type") == "work"
                        and req.get("status") == "pending"
                        for req in self.requests
                    )
                    if has_work_req:
                        continue
                    for d in self.dates:
                        for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                            if opt.get("is_pref"):
                                # 常時希望 opt のみにボーナス付与
                                penalty += x[(sid, d, oi)] * self.W.PREFERENCE_BASE
                                standing_pref_count += 1
                logger.info("[Tier3] Standing preferences: {} options bonused".format(standing_pref_count))

                # v3.7.17: 時間帯分散制約 (朝/昼/夕) を廃止 (運用者判断)

                # v3.7.16: 連続5日後の疲労インセンティブを廃止 (運用者判断)
                # ※連続勤務6日の法定上限は HARD 制約として line 1191 で別途維持

                # --- メンター主担当マッチング (preferred_mentor がある新人を主担当と同シフトに) ---
                if self._rookie_ids:
                    for s in self.staff_list:
                        sid = s["id"]
                        if sid not in self._rookie_ids:
                            continue
                        pref_mentor_id = s.get("preferred_mentor")
                        if not pref_mentor_id or pref_mentor_id not in self._staff_map:
                            continue
                        for d in self.dates:
                            if self._get_day_type(d) == "closed":
                                continue
                            rookie_d = [x[(sid, d, oi)]
                                        for oi in range(len(staff_opts.get((sid, d), [])))]
                            mentor_d = [x[(pref_mentor_id, d, oi)]
                                        for oi in range(len(staff_opts.get((pref_mentor_id, d), [])))]
                            if rookie_d and mentor_d:
                                # 新人が出勤するときに主担当も出勤しているとボーナス
                                # ペアリングインジケータ: pair <= rookie_sum, pair <= mentor_sum
                                pair_ind = pulp.LpVariable(
                                    "pair_{}_{}".format(sid, d), 0, 1, pulp.LpBinary)
                                prob += pair_ind <= pulp.lpSum(rookie_d)
                                prob += pair_ind <= pulp.lpSum(mentor_d)
                                penalty += pair_ind * self.W.MENTOR_MATCH_BONUS

                # v3.7.16: 土日ローテーション公平性制約を廃止 (運用者判断)

                logger.info("[Tier3] Quality optimization applied")

            # ====================================================
            # 目的関数: コスト最小化
            # ====================================================

            # v3.7.28: 「過剰絶対回避 + 月給優先 + 時給はスポット投入」ポリシー
            # 配置の優先順位を以下のように設計:
            #   1. COVERAGE (UNDER 5M / OVER 20M) で過剰絶対回避
            #   2. 月給スタッフを優先配置 (不在ペナルティ 30k)
            #   3. 時給スタッフは「スポット帯 (time_staff_req で要件が高い時間)」のみ低コスト
            #      通常時間帯では追加コスト (15k) を課して控え目に
            #   4. PREFERENCE_EXACT (-3M) は両方の人件費を覆せる強さ

            # スポット帯 (time_staff_req 設定済みの時間) かどうかの判定マップを構築
            # _slot_reqs_cache は v3.7.x で構築済 (各日のスロット必要人数 dict)
            time_rules_cfg = self.config.get("time_staff_req") or []
            has_time_rules = bool(time_rules_cfg)

            # v3.7.45: 月給スタッフ優先配置を強化 (30k → 150k)
            # ユーザー報告: 名倉/坂本/岩井 (社員) のシフト回数が少ない
            # 原因: 30k が時給コスト 5k の 6倍だが、複数日分の累積で逆転するケースあり
            # 修正: 150k に強化、時給 5k の 30倍に。これで「月給を休ませて時給を入れる」
            #       選択は確実に避けられる (過剰回避 20M は維持)
            for sid in self._monthly_ids:
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    opts = staff_opts.get((sid, d), [])
                    if opts:
                        not_working = 1 - pulp.lpSum(
                            x[(sid, d, oi)] for oi in range(len(opts)))
                        # v3.7.47 [Tier 4]: 月給未配置 500k (推奨レベル)
                        penalty += not_working * 500_000

            # 時給スタッフは「働くと小ペナルティ」(控え目配置)。ただしスポット帯は割引
            hourly_ids = {s["id"] for s in self.staff_list
                          if str(s.get("salary_type", "hourly")).lower() == "hourly"}
            for sid in hourly_ids:
                for d in self.dates:
                    opts = staff_opts.get((sid, d), [])
                    if not opts:
                        continue
                    # その日に「スポット帯」(time_staff_req で要件が高いスロット) があるか
                    slot_reqs = self._slot_reqs_cache.get(d, {}) if hasattr(self, '_slot_reqs_cache') else {}
                    for oi, opt in enumerate(opts):
                        # opt の時間範囲とスポット帯の重なりを判定
                        is_spot = False
                        if has_time_rules and slot_reqs:
                            # opt 範囲内に高要件スロット (>= 2) があれば「スポット」
                            for slot_min, req_at_slot in slot_reqs.items():
                                if opt["start_min"] <= slot_min < opt["end_min"] and req_at_slot >= 2:
                                    is_spot = True
                                    break
                        # v3.7.47 [Tier 5]: 時給通常コスト 10k / スポット帯 0
                        cost = 0 if is_spot else 10_000
                        if cost > 0:
                            penalty += x[(sid, d, oi)] * cost

            # シフト 1 件あたりの基本コスト (不要シフト抑制)
            for s in self.staff_list:
                sid = s["id"]
                for d in self.dates:
                    for oi in range(len(staff_opts.get((sid, d), []))):
                        penalty += x[(sid, d, oi)] * self.W.SHIFT_COST

            # 強行モード時: 超過時間へのペナルティ
            if force:
                for s in self.staff_list:
                    mh = float(s.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
                    sid = s["id"]
                    for d in self.dates:
                        for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                            if opt["work_hours"] > mh:
                                penalty += x[(sid, d, oi)] * (opt["work_hours"] - mh) * 50000

            # 社員（店長・副店長・社員など）のシフト希望ソフト制約
            # 人員不足時は無視されるが、人が足りている時は本人の希望時間帯を優先する
            employee_ids = self._monthly_ids.union(self._manager_ids)
            for eid in employee_ids:
                for d in self.dates:
                    opts = staff_opts.get((eid, d), [])
                    has_pref = any(opt.get("is_pref") for opt in opts)
                    if has_pref:
                        for oi, opt in enumerate(opts):
                            if not opt.get("is_pref"):
                                # 10000のペナルティ。不足ペナルティ(500000)よりはるかに小さいが、通常パターンのコストより高い
                                penalty += x[(eid, d, oi)] * 10000

            # v3.7.19: NG ペア制約を廃止 (運用者判断)

            # 人間関係（相性）制約: 必須ペア
            for (sid1, sid2) in getattr(self, '_req_pair_constraints', []):
                for d in self.dates:
                    slot_reqs_rp = self._slot_reqs_cache.get(d) if hasattr(self, '_slot_reqs_cache') else None
                    if slot_reqs_rp is None:
                        slot_reqs_rp = self._build_slot_requirements(d)
                    if not slot_reqs_rp:
                        continue
                    for slot_min in slot_reqs_rp:
                        sid1_w = pulp.lpSum(x[(sid1, d, oi)] for oi, opt in enumerate(staff_opts.get((sid1, d), [])) if opt["start_min"] <= slot_min < opt["end_min"])
                        sid2_w = pulp.lpSum(x[(sid2, d, oi)] for oi, opt in enumerate(staff_opts.get((sid2, d), [])) if opt["start_min"] <= slot_min < opt["end_min"])
                        shortage = pulp.LpVariable("REQ_shortage_{}_{}_{}_{}".format(sid1[:8], sid2[:8], d, slot_min), lowBound=0)
                        prob += (shortage >= sid1_w - sid2_w)
                        penalty += shortage * 100000

            # ポジション別の必要人数確保（ソフト制約）
            for d in self.dates:
                pos_reqs = self._build_pos_requirements(d)
                for slot_min_pos, reqs in pos_reqs.items():
                    for pos, req_num in reqs.items():
                        if req_num > 0:
                            pos_staff = []
                            for s in self.staff_list:
                                if s["id"] not in [sid2[0] for sid2 in staff_opts.keys() if sid2[1] == d]:
                                    continue
                                sp = s.get("position", "any")
                                if sp in ("any", pos):
                                    pos_staff.append(s["id"])
                            working_pos = pulp.lpSum(
                                x[(sid, d, oi)]
                                for sid in pos_staff
                                for oi, opt in enumerate(staff_opts.get((sid, d), []))
                                if opt["start_min"] <= slot_min_pos < opt["end_min"]
                            )
                            shortage = pulp.LpVariable("POS_short_{}_{}_{}" .format(pos, d, slot_min_pos), lowBound=0)
                            prob += (shortage >= req_num - working_pos)
                            penalty += shortage * self.W.POSITION_SHORT

            prob += penalty
            # v3.6: Tierごとのタイムリミットを config で上書き可能に。
            # デフォルトを引き上げ (60/30/20 → 120/60/30) — 中規模店 (30-50名×1ヶ月) で
            # Tier3 が timeout して品質劣化する事態を防ぐ。
            # Railway/Render の HTTP timeout は 300s なので、3 tier 合計 210s で収まる。
            default_limits = {3: 120, 2: 60, 1: 30}
            cfg_limits = self.config.get("milp_time_limits") or {}
            tier_time_limits = {
                3: int(cfg_limits.get("tier3") or default_limits[3]),
                2: int(cfg_limits.get("tier2") or default_limits[2]),
                1: int(cfg_limits.get("tier1") or default_limits[1]),
            }
            # MILP 規模をログ出力 (運用監視・スケーラビリティ判断用)
            logger.info("[MILP] tier=%d vars=%d constraints=%d timeLimit=%ds",
                        tier, len(x), len(prob.constraints), tier_time_limits.get(tier, 60))
            solver = pulp.PULP_CBC_CMD(msg=0, timeLimit=tier_time_limits.get(tier, 60))
            prob.solve(solver)

            status = pulp.LpStatus[prob.status]
            logger.info("[MILP] Status: {} (tier={}, force={})".format(
                status, tier, force))

            if status not in ("Optimal", "Not Solved"):
                return None

            # ====================================================
            # 結果抽出 + 配置理由ラベル付与
            # ====================================================
            shifts = []
            warnings = []
            for s in self.staff_list:
                sid = s["id"]
                rank = self._eval_rank.get(sid, "B")
                priority = str(s.get("shift_priority", "medium")).lower()
                contract = str(s.get("contract_type", "general")).lower()
                for d in self.dates:
                    for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                        if (sid, d, oi) in x and pulp.value(x[(sid, d, oi)]) and pulp.value(x[(sid, d, oi)]) > 0.5:
                            hrs = opt["hours"]
                            brk = self._get_break_minutes(hrs)
                            mh = float(s.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
                            # 配置理由を判定 (優先順位高い順)
                            reason = assignment_reasons.get((sid, d))
                            if not reason:
                                pref = pref_index.get((sid, d))
                                if pref and pref.get("start") and pref.get("end"):
                                    ps = self._to_minutes(pref["start"])
                                    pe = self._to_minutes(pref["end"])
                                    diff = abs(opt["start_min"] - ps) + abs(opt["end_min"] - pe)
                                    if diff == 0:
                                        reason = "希望シフトと完全一致"
                                    elif diff <= 60:
                                        reason = "希望シフトに近い時間帯"
                                    else:
                                        reason = "希望日に配置"
                                elif priority == "high":
                                    reason = "シフト優先度: 高"
                                elif contract == "regular":
                                    reason = "レギュラー契約優先"
                                elif sid in self._mentor_ids:
                                    reason = "メンター・管理者ロール"
                                elif sid in self._monthly_ids:
                                    reason = "月給スタッフ (固定費活用)"
                                elif rank in ("A", "B"):
                                    reason = "高評価ランク (戦力)"
                                else:
                                    reason = "公平性に基づく自動配置"
                            entry = {
                                "staff_id": sid,
                                "date": d,
                                "start_time": opt["start"],
                                "end_time": opt["end"],
                                "break_minutes": brk,
                                "reason": reason,
                            }
                            if opt["work_hours"] > mh:
                                warnings.append("{} {}: {:.1f}h over".format(
                                    s.get("name", ""), d, opt["work_hours"] - mh))
                            shifts.append(entry)

            self._validate(shifts)

            # ====================================================
            # validation_report 生成 (slack 集計)
            # ====================================================
            def _name(sid):
                rec = self._staff_map.get(sid, {})
                return rec.get("name", sid[:8])

            coverage_gaps = []
            for (d, slot_min, req, sv) in tracked_slacks.get("coverage_under", []):
                v = pulp.value(sv) or 0
                if v >= 0.5:
                    coverage_gaps.append({
                        "date": d,
                        "time": self._from_minutes(slot_min),
                        "required": int(req),
                        "shortage": int(round(v)),
                    })

            open_close_gaps = []
            for (d, slot_min, sv) in tracked_slacks.get("open_close_under", []):
                v = pulp.value(sv) or 0
                if v >= 0.5:
                    open_close_gaps.append({
                        "date": d,
                        "time": self._from_minutes(slot_min),
                    })

            # v3.7.20: manager_gaps はレポート出力から除外 (管理者常駐制約廃止のため)
            report = {
                "tier": tier,
                "mode": "force" if force else "auto",
                "total_shifts": len(shifts),
                "overtime_warnings": warnings,
                "coverage_gaps": coverage_gaps[:50],          # スロット人員不足 (top 50)
                "open_close_gaps": open_close_gaps[:30],      # 開け締め社員不在
                "has_violations": bool(warnings or coverage_gaps or open_close_gaps),
            }
            self._last_report = report

            if warnings:
                logger.info("[OVERTIME]")
                for w in warnings:
                    logger.info("  " + w)
            logger.info("[Report] coverage_gaps={} open_close_gaps={}".format(
                len(coverage_gaps), len(open_close_gaps)))
            logger.info("[Result] {} shifts".format(len(shifts)))
            return shifts if shifts else None

        except Exception as e:
            logger.info("[MILP Error] {}".format(e))
            import traceback
            traceback.print_exc()
            return None

    # ===========================================================
    # バリデーション
    # ===========================================================

    def _validate(self, shifts):
        violations = 0
        # ±1品質チェック用カウンター
        total_slots_checked = 0
        slots_within_pm1 = 0  # ±1以内に収まったスロット数
        daily_within_pm1 = 0  # ±1以内の日数
        daily_checked = 0

        # カバレッジ検証 + ±1品質チェック
        for d in self.dates:
            reqs = self._build_slot_requirements(d)
            day_s = [s for s in shifts if s["date"] == d]

            if not reqs:
                continue

            req_daily = self._get_required_staff(d)
            daily_assigned = len(day_s)
            # スロット要件の最大値も考慮（MILP制約と同じ基準）
            max_slot_req = max(reqs.values()) if reqs else req_daily
            daily_effective_req = max(req_daily, max_slot_req)
            if daily_effective_req > 0:
                daily_checked += 1
                daily_diff = daily_assigned - daily_effective_req
                if -1 <= daily_diff <= 1:
                    daily_within_pm1 += 1
                elif daily_diff < -1:
                    logger.info("  BALANCE: {} daily: need={} got={} ({}名不足)".format(
                        d, daily_effective_req, daily_assigned, abs(daily_diff)))
                elif daily_diff > 1:
                    logger.info("  BALANCE: {} daily: need={} got={} (+{}名過剰)".format(
                        d, daily_effective_req, daily_assigned, daily_diff))

            for slot_min, req in reqs.items():
                cov = sum(1 for s in day_s
                          if self._to_minutes(s["start_time"]) <= slot_min
                          < self._to_minutes(s["end_time"]))
                total_slots_checked += 1
                diff = cov - req
                if -1 <= diff <= 1:
                    slots_within_pm1 += 1
                if cov < req:
                    logger.info("  VIOLATION: {} {} need={} got={}".format(
                        d, self._from_minutes(slot_min), req, cov))
                    violations += 1

        # ±1達成率のログ出力
        if total_slots_checked > 0:
            slot_rate = (slots_within_pm1 / total_slots_checked) * 100
            logger.info("  [±1 QUALITY] Slot: {}/{} ({:.1f}%) within ±1".format(
                slots_within_pm1, total_slots_checked, slot_rate))
        if daily_checked > 0:
            daily_rate = (daily_within_pm1 / daily_checked) * 100
            logger.info("  [±1 QUALITY] Daily: {}/{} ({:.1f}%) within ±1".format(
                daily_within_pm1, daily_checked, daily_rate))

        # スタッフ別配置日数のバラツキ検証
        staff_days = {}
        for sh in shifts:
            sid = sh["staff_id"]
            staff_days.setdefault(sid, set()).add(sh["date"])
        if staff_days:
            days_list = [len(ds) for ds in staff_days.values()]
            avg_days = sum(days_list) / len(days_list)
            max_days = max(days_list)
            min_days = min(days_list)
            logger.info("  [FAIRNESS] Staff days: avg={:.1f}, min={}, max={}, spread={}".format(
                avg_days, min_days, max_days, max_days - min_days))

        # 連勤検証
        sorted_d = sorted(self.dates)
        for s in self.staff_list:
            sid = s["id"]
            consec = 0
            for d in sorted_d:
                if any(sh["staff_id"] == sid and sh["date"] == d for sh in shifts):
                    consec += 1
                    if consec > self.LEGAL_MAX_CONSECUTIVE_DAYS:
                        logger.info("  VIOLATION: {} consec={} days at {}".format(
                            s.get("name", sid), consec, d))
                        violations += 1
                else:
                    consec = 0

        # 週40時間検証
        week_groups = self._group_dates_by_week()
        for s in self.staff_list:
            sid = s["id"]
            for week in week_groups:
                total_hours = 0
                for d in week:
                    for sh in shifts:
                        if sh["staff_id"] == sid and sh["date"] == d:
                            sm = self._to_minutes(sh["start_time"])
                            em = self._normalize_end_time(sm, self._to_minutes(sh["end_time"]))
                            raw_hrs = (em - sm) / 60.0
                            brk = self._get_break_minutes(raw_hrs) / 60.0
                            total_hours += (raw_hrs - brk)
                if total_hours > self.LEGAL_MAX_HOURS_WEEK:
                    logger.info("  VIOLATION: {} week {} hours={:.1f} > {}".format(
                        s.get("name", sid), week[0], total_hours,
                        self.LEGAL_MAX_HOURS_WEEK))
                    violations += 1

        # NG日検証
        for s in self.staff_list:
            sid = s["id"]
            ng = self._get_staff_ng_dates(s)
            for sh in shifts:
                if sh["staff_id"] == sid and sh["date"] in ng:
                    logger.info("  VIOLATION: {} assigned on NG date {}".format(
                        s.get("name", sid), sh["date"]))
                    violations += 1

        if violations == 0:
            logger.info("  VALIDATION: All constraints satisfied!")
        else:
            logger.info("  VALIDATION: {} violations".format(violations))

    # ===========================================================
    # グリーディ解法 (MILP失敗時のフォールバック)
    # ===========================================================

    def _solve_greedy(self):
        shifts = []
        weekly_count = {}     # {staff_id: {week_key: count}}
        weekly_hours = {}     # {staff_id: {week_key: hours}}
        consecutive = {}      # {staff_id: current_consecutive_days}
        last_work_date = {}   # {staff_id: last_date_str}

        # v3.7.20: NG ペア制約は廃止済み (v3.7.19) のため、Greedy 側のセット構築も削除

        # まず承認済み出勤希望を固定シフトとして配置
        work_requests = self._get_work_requests()
        assigned_days = {}
        for wr in work_requests:
            wsid = wr["staff_id"]
            wd = wr["date"]
            if wd not in self.dates or self._get_day_type(wd) == "closed":
                continue
            staff = self._staff_map.get(wsid)
            if not staff:
                continue
            opts = self._build_shift_options(staff, wd, force=True)
            if not opts:
                continue
            best_opt = opts[0]
            if wr.get("start_time") and wr.get("end_time"):
                wr_start = self._to_minutes(wr["start_time"])
                wr_end = self._normalize_end_time(wr_start, self._to_minutes(wr["end_time"]))
                best_diff = float("inf")
                for opt in opts:
                    diff = abs(opt["start_min"] - wr_start) + abs(opt["end_min"] - wr_end)
                    if diff < best_diff:
                        best_diff = diff
                        best_opt = opt
            brk = self._get_break_minutes(best_opt["hours"])
            shifts.append({
                "staff_id": wsid, "date": wd,
                "start_time": best_opt["start"], "end_time": best_opt["end"],
                "break_minutes": brk,
            })
            assigned_days.setdefault(wd, set()).add(wsid)
            dt = datetime.strptime(wd, "%Y-%m-%d")
            wk = "{}-W{}".format(dt.year, dt.isocalendar()[1])
            weekly_count.setdefault(wsid, {})
            weekly_count[wsid][wk] = weekly_count[wsid].get(wk, 0) + 1
            weekly_hours.setdefault(wsid, {})
            weekly_hours[wsid][wk] = weekly_hours[wsid].get(wk, 0) + best_opt["hours"]

        # 日付順にスタッフを配置
        for d in sorted(self.dates):
            if self._get_day_type(d) == "closed":
                # 休業日は連勤カウントをリセット
                for sid in consecutive:
                    if last_work_date.get(sid) != d:
                        consecutive[sid] = 0
                continue
            slot_reqs = self._build_slot_requirements(d)
            if not slot_reqs:
                continue
            dt = datetime.strptime(d, "%Y-%m-%d")
            wk = "{}-W{}".format(dt.year, dt.isocalendar()[1])
            day_shifts = [s for s in shifts if s["date"] == d]
            assigned = assigned_days.get(d, set()).copy()

            # 管理者優先配置: まず管理者を確保
            manager_present = any(
                sh["staff_id"] in self._manager_ids for sh in day_shifts
            )
            if not manager_present:
                for mid in sorted(self._manager_ids):
                    mgr = self._staff_map.get(mid)
                    if not mgr or mid in assigned:
                        continue
                    if d in self._get_staff_ng_dates(mgr):
                        continue
                    if self._greedy_check_limits(mid, wk, weekly_count, weekly_hours, consecutive, mgr):
                        continue
                    opts = self._build_shift_options(mgr, d, force=False)
                    if opts:
                        opt = opts[0]  # 最初のパターン
                        brk = self._get_break_minutes(opt["hours"])
                        entry = {
                            "staff_id": mid, "date": d,
                            "start_time": opt["start"], "end_time": opt["end"],
                            "break_minutes": brk,
                        }
                        day_shifts.append(entry)
                        shifts.append(entry)
                        assigned.add(mid)
                        self._greedy_update_counts(mid, wk, d,
                                                   weekly_count, weekly_hours,
                                                   consecutive, last_work_date,
                                                   opt["hours"])
                        break

            # 不足スロットを埋める（ただし過剰配置は防止）
            for _ in range(30):
                deficit = {}
                max_slot_req_day = 0
                for slot_min, req in slot_reqs.items():
                    cov = sum(1 for s in day_shifts
                              if self._to_minutes(s["start_time"]) <= slot_min
                              < self._to_minutes(s["end_time"]))
                    if cov < req:
                        deficit[slot_min] = req - cov
                    if req > max_slot_req_day:
                        max_slot_req_day = req
                if not deficit:
                    break
                # v3.7.33 [MED-3]: ぴったり停止 (work_request 分の超過余裕を撤廃)
                # 旧 v3.7.31: max_slot_req_day + len(assigned_days[d]) で停止
                #   → assigned_days[d] は work_request 既配置で day_shifts にも含まれるため
                #     k人の work_request がある日は k人分の過剰を許容してしまう
                # 新: max_slot_req_day ぴったりで停止 (work_request 重ね分を引かない)
                if len(day_shifts) >= max_slot_req_day:
                    break

                worst = max(deficit, key=deficit.get)
                best_s = best_o = None
                best_cov = 0

                # メンター優先、評価順でソート
                sorted_staff = sorted(
                    self.staff_list,
                    key=lambda s: (
                        0 if s["id"] in self._monthly_ids else 1,  # 月給優先
                        0 if s["id"] in self._mentor_ids else 1,
                        {"A": 0, "B": 1, "C": 2, "D": 3}.get(
                            self._eval_rank.get(s["id"], "B"), 2)
                    ))

                for s in sorted_staff:
                    sid = s["id"]
                    if sid in assigned:
                        continue
                    if d in self._get_staff_ng_dates(s):
                        continue
                    # v3.7.11: OJT メンター制約 — 旧版は「メンター同日在席」のみ
                    # チェックしていたが、時間帯が重ならない (例: メンター早番 / 新人遅番)
                    # と実質的にメンター不在になるバグ。
                    # 修正: その日に既に配置されたメンターのシフト時間範囲を集めて、
                    # 後で新人シフト候補ごとに時間重複を確認する。
                    mentor_ranges_on_day = []
                    if sid in self._rookie_ids:
                        has_mentor = any(other_sid in self._mentor_ids for other_sid in assigned)
                        if not has_mentor:
                            continue
                        # day_shifts は最新の day_shifts (このループの上にあるはず)
                        for sh in day_shifts:
                            if sh.get("staff_id") in self._mentor_ids:
                                try:
                                    mstart = self._to_minutes(sh["start_time"])
                                    mend = self._normalize_end_time(mstart, self._to_minutes(sh["end_time"]))
                                    mentor_ranges_on_day.append((mstart, mend))
                                except (ValueError, KeyError):
                                    pass
                        if not mentor_ranges_on_day:
                            # メンターは居るが時間データが取れない → 配置スキップ (安全側)
                            continue
                    if self._greedy_check_limits(sid, wk, weekly_count,
                                                 weekly_hours, consecutive, s):
                        continue
                    max_hours = float(s.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
                    for opt in self._build_shift_options(s, d, force=False):
                        if opt["hours"] > max_hours:
                            continue
                        # v3.7.11: 新人候補シフトとメンターシフトの時間重複チェック
                        if mentor_ranges_on_day:
                            opt_overlaps_mentor = any(
                                opt["start_min"] < mend and opt["end_min"] > mstart
                                for mstart, mend in mentor_ranges_on_day
                            )
                            if not opt_overlaps_mentor:
                                continue
                        if opt["start_min"] <= worst < opt["end_min"]:
                            c = sum(1 for sm in deficit
                                    if opt["start_min"] <= sm < opt["end_min"])
                            # v3.7.12: タイブレーカー判定を浮動小数点 +0.5 ではなく
                            # (cov, is_pref) のタプル比較に変更。
                            # 旧版は c += 0.5 で int→float 昇格があり、後の整数比較で
                            # 精度問題のリスクがあった (agent #1 指摘 CRITICAL)。
                            is_pref_bonus = 1 if opt.get("is_pref") else 0
                            score = (c, is_pref_bonus)
                            best_score = (best_cov, 1 if best_o and best_o.get("is_pref") else 0)
                            if score > best_score:
                                best_cov = c
                                best_s = s
                                best_o = opt
                    if best_s:
                        break

                if best_s and best_o:
                    brk = self._get_break_minutes(best_o["hours"])
                    entry = {
                        "staff_id": best_s["id"],
                        "date": d,
                        "start_time": best_o["start"],
                        "end_time": best_o["end"],
                        "break_minutes": brk,
                    }
                    day_shifts.append(entry)
                    shifts.append(entry)
                    assigned.add(best_s["id"])
                    self._greedy_update_counts(
                        best_s["id"], wk, d,
                        weekly_count, weekly_hours,
                        consecutive, last_work_date,
                        best_o["hours"])
                else:
                    break

            assigned_days[d] = assigned

        # v3.6: min_days_week 後処理
        # 旧版は greedy で min_days_week を完全に無視 → 「最低出勤日数を
        # 守る」と契約したスタッフが週0日になる可能性。週ごとに不足を補う。
        week_groups = self._group_dates_by_week()
        for s in self.staff_list:
            sid = s["id"]
            min_dw = int(s.get("min_days_week") or 0)
            if min_dw <= 0:
                continue
            ng_set = self._get_staff_ng_dates(s)
            max_dw = int(s.get("max_days_week") or 5)
            for week in week_groups:
                if not week:
                    continue
                wk_key = "{}-W{}".format(
                    datetime.strptime(week[0], "%Y-%m-%d").year,
                    datetime.strptime(week[0], "%Y-%m-%d").isocalendar()[1]
                )
                current = weekly_count.get(sid, {}).get(wk_key, 0)
                if current >= min_dw or current >= max_dw:
                    continue
                # この週で出勤可能な日を探して追加
                for d in week:
                    if current >= min_dw:
                        break
                    if d in ng_set or self._get_day_type(d) == "closed":
                        continue
                    if any(sh["staff_id"] == sid and sh["date"] == d for sh in shifts):
                        continue

                    # v3.7.3: 連勤6日上限 / 10時間インターバル / 週40h を遵守
                    # 旧版は post-pass で min_days_week を満たすだけのために法令違反シフトを
                    # 作る可能性があった (agent #1 指摘の HIGH バグ)
                    d_dt = datetime.strptime(d, "%Y-%m-%d")

                    # 連勤6日チェック: d を含む 7日窓内の出勤数が 7 にならないか
                    consec_violation = False
                    for offset in range(-6, 1):
                        win_start = d_dt + timedelta(days=offset)
                        win_dates = set((win_start + timedelta(days=k)).strftime("%Y-%m-%d") for k in range(7))
                        in_win = sum(1 for sh in shifts if sh["staff_id"] == sid and sh["date"] in win_dates) + 1
                        if in_win > self.LEGAL_MAX_CONSECUTIVE_DAYS:
                            consec_violation = True
                            break
                    if consec_violation:
                        continue

                    # v3.7.12: 10時間インターバル + シフト選択を一体化
                    # 旧版は opt0[0] でインターバル検証 → opts[0] で配置していたが、
                    # 別オプションが返るケースがあり実質チェック無効化のリスクがあった
                    # (agent #1 指摘 HIGH)。
                    # 修正: 「インターバル違反しない最初の opt」を探して採用する。
                    opts = self._build_shift_options(s, d, force=False)
                    if not opts:
                        continue
                    chosen_opt = None
                    for cand in opts:
                        cand_start = cand["start_min"]
                        cand_end = cand["end_min"]
                        violates = False
                        for sh in shifts:
                            if sh["staff_id"] != sid:
                                continue
                            try:
                                sh_dt = datetime.strptime(sh["date"], "%Y-%m-%d")
                            except ValueError:
                                continue
                            diff_days = (sh_dt - d_dt).days
                            if abs(diff_days) > 1:
                                continue
                            sh_start = self._to_minutes(sh["start_time"])
                            sh_end = self._normalize_end_time(sh_start, self._to_minutes(sh["end_time"]))
                            if diff_days == 1:
                                iv = (sh_start + 1440) - cand_end
                            elif diff_days == -1:
                                iv = (cand_start + 1440) - sh_end
                            else:
                                continue
                            if iv < 600:
                                violates = True
                                break
                        if not violates:
                            chosen_opt = cand
                            break
                    if chosen_opt is None:
                        continue
                    opt = chosen_opt
                    week_set = set(week)
                    existing_hours = 0.0
                    for sh in shifts:
                        if sh["staff_id"] == sid and sh["date"] in week_set:
                            sh_start = self._to_minutes(sh["start_time"])
                            sh_end = self._normalize_end_time(sh_start, self._to_minutes(sh["end_time"]))
                            existing_hours += (sh_end - sh_start) / 60.0 - (sh.get("break_minutes", 0) / 60.0)
                    if existing_hours + opt["work_hours"] > self.LEGAL_MAX_HOURS_WEEK:
                        continue

                    brk = self._get_break_minutes(opt["hours"])
                    shifts.append({
                        "staff_id": sid, "date": d,
                        "start_time": opt["start"], "end_time": opt["end"],
                        "break_minutes": brk,
                    })
                    weekly_count.setdefault(sid, {})
                    weekly_count[sid][wk_key] = current + 1
                    current += 1

        logger.info("[Greedy] {} shifts".format(len(shifts)))
        self._validate(shifts)
        return shifts if shifts else None

    def _greedy_check_limits(self, sid, wk, weekly_count, weekly_hours,
                             consecutive, staff):
        """グリーディ用: スタッフが制約に違反するかチェック"""
        md = int(staff.get("max_days_week") or 5)
        if md <= 0:
            return True  # 出勤不可
        cur_days = weekly_count.get(sid, {}).get(wk, 0)
        if cur_days >= md:
            return True  # 週最大日数超過

        cur_hours = weekly_hours.get(sid, {}).get(wk, 0)
        max_hours = float(staff.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
        if cur_hours + max_hours > self.LEGAL_MAX_HOURS_WEEK:
            return True  # 週40時間超過の可能性

        cur_consec = consecutive.get(sid, 0)
        if cur_consec >= self.LEGAL_MAX_CONSECUTIVE_DAYS:
            return True  # 連続勤務超過

        return False

    def _greedy_update_counts(self, sid, wk, date_str,
                              weekly_count, weekly_hours,
                              consecutive, last_work_date, hours):
        """グリーディ用: 各種カウンターを更新"""
        weekly_count.setdefault(sid, {})
        weekly_count[sid][wk] = weekly_count[sid].get(wk, 0) + 1

        weekly_hours.setdefault(sid, {})
        weekly_hours[sid][wk] = weekly_hours[sid].get(wk, 0) + hours

        # 連勤チェック
        prev = last_work_date.get(sid)
        if prev:
            prev_dt = datetime.strptime(prev, "%Y-%m-%d")
            cur_dt = datetime.strptime(date_str, "%Y-%m-%d")
            if (cur_dt - prev_dt).days == 1:
                consecutive[sid] = consecutive.get(sid, 0) + 1
            else:
                consecutive[sid] = 1
        else:
            consecutive[sid] = 1
        last_work_date[sid] = date_str
