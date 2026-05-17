import pulp
from datetime import datetime, timedelta


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

    def __init__(self, staff_list, config, dates, requests=None):
        self.staff_list = staff_list or []
        self.config = config or {}
        self.dates = sorted(dates or [])
        self.requests = requests or []

        # シフトパターン構築
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

        # 休憩ルール
        self.break_rules = self.config.get("break_rules", [])
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

        for s in self.staff_list:
            sid = s["id"]
            self._staff_map[sid] = s
            role = str(s.get("role", "staff")).lower()
            evaluation = str(s.get("evaluation", "B")).upper()
            salary = str(s.get("salary_type", "hourly")).lower()

            if role in self.MENTOR_ROLES:
                self._mentor_ids.add(sid)
            if role in self.ROOKIE_ROLES or evaluation == "D":
                self._rookie_ids.add(sid)
            if role == "manager":
                self._manager_ids.add(sid)
            if salary == "monthly":
                self._monthly_ids.add(sid)
            self._eval_rank[sid] = evaluation if evaluation in self.POWER_SCORE else "B"

        # NGデータキャッシュ (各呼び出しで再計算しないように)
        self._ng_cache = {}
        for s in self.staff_list:
            self._ng_cache[s["id"]] = self._compute_staff_ng_dates(s)

        print("[Init] Staff:{} Dates:{} Patterns:{}".format(
            len(self.staff_list), len(self.dates), len(self.shift_patterns)))
        print("[Init] Req: wd={} we={} hol={} mgr={}".format(
            self.min_weekday, self.min_weekend,
            self.min_holiday, self.min_manager))
        print("[Init] Mentors:{} Rookies:{} Monthly:{}".format(
            len(self._mentor_ids), len(self._rookie_ids),
            len(self._monthly_ids)))

    # ===========================================================
    # ユーティリティ
    # ===========================================================

    def _normalize_end_time(self, start_min, end_min):
        if end_min <= start_min:
            return end_min + 1440
        return end_min

    def _to_minutes(self, time_str):
        try:
            parts = str(time_str).split(":")
            return int(parts[0]) * 60 + int(parts[1])
        except Exception:
            return 0

    def _from_minutes(self, mins):
        m = int(mins) % 1440
        return "{:02d}:{:02d}".format(m // 60, m % 60)

    def _get_day_type(self, date_str):
        """日付の種別を判定: weekday / weekend / holiday / closed"""
        if date_str in self.special_holidays:
            return "closed"
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        # JavaScript互換: 0=日, 1=月, ..., 6=土
        js_dow = (dt.weekday() + 1) % 7
        if js_dow in self.closed_days:
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
        """スタッフのNG日を計算 (unavailable_dates + 承認済み休暇)"""
        raw = staff.get("unavailable_dates")
        ng = set()
        if raw:
            if isinstance(raw, list):
                ng = {str(d).strip() for d in raw if str(d).strip()}
            else:
                ng = {str(d).strip() for d in str(raw).split(",") if str(d).strip()}
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
        """スタッフが指定日に入れるシフトパターンの候補を構築"""
        day_open, day_close = self._get_opening_hours(date_str)
        open_min = self._to_minutes(day_open)
        close_min = self._normalize_end_time(open_min, self._to_minutes(day_close))

        max_hours = float(staff.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
        if not force and max_hours <= 0:
            return []
        if force and max_hours <= 0:
            max_hours = self.LEGAL_MAX_HOURS_DAY

        options = []
        seen = set()
        for pat in self.shift_patterns:
            raw_ps = self._to_minutes(pat["start"])
            raw_pe = self._normalize_end_time(raw_ps, self._to_minutes(pat["end"]))
            ps = max(raw_ps, open_min)
            pe = min(raw_pe, close_min)
            if ps >= pe:
                continue

            # --- 回避策: スタッフの最大労働時間に合わせて終了時間を自動短縮 ---
            hrs = (pe - ps) / 60.0
            brk_mins = self._get_break_minutes(hrs)
            work_hrs = hrs - (brk_mins / 60.0)

            if work_hrs > max_hours and not force:
                # 必要な労働時間がmax_hoursの場合の休憩時間を取得
                needed_break = self._get_break_minutes(max_hours)
                allowed_total_hours = max_hours + (needed_break / 60.0)
                new_pe = ps + int(allowed_total_hours * 60)
                if new_pe < pe:
                    pe = new_pe
                    # 短縮されたので再計算
                    hrs = (pe - ps) / 60.0
                    brk_mins = self._get_break_minutes(hrs)
                    work_hrs = hrs - (brk_mins / 60.0)

            if hrs < 1:
                continue
            # -------------------------------------------------------------------

            key = (ps, pe)
            if key in seen:
                continue
            seen.add(key)
            options.append({
                "start": self._from_minutes(ps),
                "end": self._from_minutes(pe),
                "start_min": ps, "end_min": pe, "hours": hrs, "work_hours": work_hrs,
            })
        return options

    def _build_slot_requirements(self, date_str):
        """15分スロットごとの必要人数マップを構築"""
        req_num = self._get_required_staff(date_str)
        if req_num <= 0:
            return {}
        day_open, day_close = self._get_opening_hours(date_str)
        op = self._to_minutes(day_open)
        cl = self._normalize_end_time(op, self._to_minutes(day_close))
        slots = {}
        for t in range(op, cl, 15):
            slots[t] = req_num

        dt = datetime.strptime(date_str, "%Y-%m-%d")
        js_dow = (dt.weekday() + 1) % 7
        for rule in self.time_staff_req:
            if js_dow not in rule.get("days", []):
                continue
            rs = self._to_minutes(rule.get("start", "00:00"))
            re_min = self._normalize_end_time(rs, self._to_minutes(rule.get("end", "24:00")))
            rc = int(rule.get("count", 0))
            for t in range(op, cl, 15):
                in_range = (rs <= t < re_min) if rs <= re_min else (t >= rs or t < re_min)
                if in_range and t in slots:
                    slots[t] = max(slots[t], rc)
        return slots

    # ===========================================================
    # 事前チェック
    # ===========================================================

    def pre_check(self):
        warnings = []
        daily_details = []
        total_shortage = 0.0

        usable = [s for s in self.staff_list
                   if int(s.get("max_days_week") or 5) > 0]
        unusable = [s for s in self.staff_list
                    if int(s.get("max_days_week") or 5) <= 0]

        if unusable:
            names = [s.get("name", s["id"]) for s in unusable]
            warnings.append({
                "type": "unusable_staff",
                "message": "{}名が出勤不可(max_days=0): {}".format(
                    len(names), ", ".join(names)),
                "severity": "info",
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
        result = self._solve_milp(force=force, tier=3)
        if result:
            print("[Solve] Tier 3 (full) succeeded")
            return result

        print("[Fallback] Relaxing Tier 3...")
        result = self._solve_milp(force=force, tier=2)
        if result:
            print("[Solve] Tier 2 (no OJT/balance) succeeded")
            return result

        print("[Fallback] Relaxing to Tier 1 + force...")
        result = self._solve_milp(force=True, tier=1)
        if result:
            print("[Solve] Tier 1 (legal only) succeeded")
            return result

        print("[Fallback] Greedy...")
        return self._solve_greedy()

    def _solve_milp(self, force=False, tier=3):
        try:
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
                    best_diff = float("inf")
                    for oi, opt in enumerate(opts):
                        diff = abs(opt["start_min"] - wr_start) + abs(opt["end_min"] - wr_end)
                        if diff < best_diff:
                            best_diff = diff
                            best_oi = oi
                if (wsid, wd, best_oi) in x:
                    prob += x[(wsid, wd, best_oi)] == 1
                    fixed_assignments.add((wsid, wd))
                    print("[WorkReq] Fixed: staff={} date={}".format(wsid, wd))

            print("[Requests] {} work requests applied".format(len(work_requests)))

            # ====================================================
            # TIER 1: 法的制約 (ハード制約)
            # ====================================================

            for s in self.staff_list:
                sid = s["id"]

                # --- 1日1シフト制約 ---
                for d in self.dates:
                    opts = staff_opts.get((sid, d), [])
                    if opts:
                        prob += pulp.lpSum(
                            x[(sid, d, oi)] for oi in range(len(opts))
                        ) <= 1

                    # --- 1日の最大労働時間 (労基法32条) ---
                    max_hours = float(s.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
                    if not force:
                        for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                            if opt["work_hours"] > max_hours:
                                prob += x[(sid, d, oi)] == 0

                # --- 週の最大勤務日数 ---
                max_days = int(s.get("max_days_week") or 5)
                if not force and max_days <= 0:
                    for d in self.dates:
                        for oi in range(len(staff_opts.get((sid, d), []))):
                            prob += x[(sid, d, oi)] == 0
                    continue

                effective_max_days = max_days if not force else max(max_days, 6)
                week_groups = self._group_dates_by_week()
                for week in week_groups:
                    wv = []
                    for d in week:
                        for oi in range(len(staff_opts.get((sid, d), []))):
                            wv.append(x[(sid, d, oi)])
                    if wv:
                        prob += pulp.lpSum(wv) <= effective_max_days

                # --- 週の最低出勤日数 (ハード制約 + ソフト制約の二重構造) ---
                min_days_week = int(s.get("min_days_week") or 0)
                if not force and min_days_week > 0:
                    print("[MinDays] Staff {} min_days_week={}".format(
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
                            effective_min = min(min_days_week, available_days_in_week)
                            if effective_min > 0:
                                if len(week) >= 5:
                                    # 5日以上の週はハード制約（絶対遵守）
                                    prob += pulp.lpSum(wv) >= effective_min
                                else:
                                    # 短い週はソフト制約（ペナルティ2M）
                                    slack_var = pulp.LpVariable(
                                        "slack_min_days_week_{}_{}".format(sid, week[0]), 0, None)
                                    prob += pulp.lpSum(wv) + slack_var >= effective_min
                                    penalty += slack_var * 2000000

                # --- 月(全体期間)の最低出勤日数 (ハード制約) ---
                min_days_month = int(s.get("min_days_month") or 0)
                if not force and min_days_month > 0 and self.dates:
                    work_dates_count = len([d for d in self.dates
                                           if self._get_day_type(d) != "closed"])
                    target_min_month = max(1, int(round(
                        min_days_month * (work_dates_count / 22.0)
                    )))
                    ng_set = self._get_staff_ng_dates(s)
                    available_total = len([d for d in self.dates
                                          if d not in ng_set and self._get_day_type(d) != "closed"])
                    target_min_month = min(target_min_month, available_total)
                    if target_min_month > 0:
                        all_wv = []
                        for d in self.dates:
                            for oi in range(len(staff_opts.get((sid, d), []))):
                                all_wv.append(x[(sid, d, oi)])
                        if all_wv:
                            print("[MinDays] Staff {} min_days_month={} -> target={}".format(
                                s.get("name", sid), min_days_month, target_min_month))
                            prob += pulp.lpSum(all_wv) >= target_min_month

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
                sorted_d = sorted(self.dates)
                max_consec = self.LEGAL_MAX_CONSECUTIVE_DAYS if not force else 7
                if len(sorted_d) > max_consec:
                    for i in range(len(sorted_d) - max_consec):
                        span = sorted_d[i:i + max_consec + 1]
                        # span内の全日に出勤することを禁止
                        sv = []
                        for d in span:
                            for oi in range(len(staff_opts.get((sid, d), []))):
                                sv.append(x[(sid, d, oi)])
                        if sv:
                            prob += pulp.lpSum(sv) <= max_consec

                # --- 勤務間インターバル制約 (前日の退勤から翌日の出勤まで10時間以上) ---
                if not force:
                    for i in range(len(sorted_d) - 1):
                        d1 = sorted_d[i]
                        d2 = sorted_d[i+1]
                        opts1 = staff_opts.get((sid, d1), [])
                        opts2 = staff_opts.get((sid, d2), [])
                        if not opts1 or not opts2:
                            continue
                        for oi1, opt1 in enumerate(opts1):
                            for oi2, opt2 in enumerate(opts2):
                                # 退勤から翌日出勤までの休息時間（分）
                                interval = (opt2["start_min"] + 1440) - opt1["end_min"]
                                if interval < 600:  # 10時間(600分)未満なら同時にシフトに入れない
                                    prob += x[(sid, d1, oi1)] + x[(sid, d2, oi2)] <= 1

            # ====================================================
            # TIER 2: カバレッジ制約 (ソフト制約)
            # ====================================================

            if tier >= 2:
                # --- 1日の合計出勤人数の上限制約（フロントエンドの+0を強制） ---
                for d in self.dates:
                    if self._get_day_type(d) == "holiday":
                        req_daily = int(self.config.get("staff_req", {}).get("min_holiday", 3))
                    elif self._get_day_type(d) == "weekend":
                        req_daily = int(self.config.get("staff_req", {}).get("min_weekend", 3))
                    else:
                        req_daily = int(self.config.get("staff_req", {}).get("min_weekday", 2))

                    day_workers = []
                    for s in self.staff_list:
                        sid = s["id"]
                        opts = staff_opts.get((sid, d), [])
                        if opts:
                            # スタッフdに出勤するかを示す変数 (1日に最大1シフトしか入れないためsumでOK)
                            day_workers.append(pulp.lpSum([x[(sid, d, oi)] for oi in range(len(opts))]))

                    # 以前は1日の総出勤人数（ヘッドカウント）に上限を設けていましたが、
                    # 短時間バイトをつなぎ合わせてカバーすることを許可するため、
                    # 1日全体の人数制限は削除し、時間帯ごと（スロット）の過剰配置ペナルティに任せます。
                # --- 各時間スロットの最低人員 + 過剰配置ペナルティ ---
                for d in self.dates:
                    slot_reqs = self._build_slot_requirements(d)
                    for slot_min, req in slot_reqs.items():
                        workers = []
                        for s in self.staff_list:
                            sid = s["id"]
                            for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                                if opt["start_min"] <= slot_min < opt["end_min"]:
                                    workers.append(x[(sid, d, oi)])
                        if workers:
                            # 下限制約: 最低人数を確保
                            slack_under = pulp.LpVariable(
                                "cov_{}_{}".format(d, slot_min),
                                0, None, pulp.LpInteger)
                            prob += pulp.lpSum(workers) + slack_under >= req
                            penalty += slack_under * 1000000
                            # 上限制約: 必要人数ぴったりを目標（超過にペナルティ）
                            slack_over = pulp.LpVariable(
                                "over_{}_{}".format(d, slot_min),
                                0, None, pulp.LpInteger)
                            prob += pulp.lpSum(workers) - slack_over <= req
                            penalty += slack_over * 500000

                # --- 管理者常駐制約 ---
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    slot_reqs = self._build_slot_requirements(d)
                    if not slot_reqs:
                        continue
                    # 管理者が不在のスロットを検出するため、
                    # 全営業スロットで管理者が最低1名必要
                    first_slot = min(slot_reqs.keys())
                    last_slot = max(slot_reqs.keys())
                    mgr_day_vars = []
                    for mid in self._manager_ids:
                        for oi in range(len(staff_opts.get((mid, d), []))):
                            mgr_day_vars.append(x[(mid, d, oi)])
                    if mgr_day_vars:
                        slack = pulp.LpVariable(
                            "mgr_day_{}".format(d),
                            0, None, pulp.LpInteger)
                        prob += pulp.lpSum(mgr_day_vars) + slack >= self.min_manager
                        penalty += slack * 500000

                    # 全スロットでの管理者カバレッジ
                    for slot_min in slot_reqs:
                        mgr_vars = []
                        for mid in self._manager_ids:
                            for oi, opt in enumerate(staff_opts.get((mid, d), [])):
                                if opt["start_min"] <= slot_min < opt["end_min"]:
                                    mgr_vars.append(x[(mid, d, oi)])
                        if mgr_vars:
                            slack = pulp.LpVariable(
                                "mgr_{}_{}".format(d, slot_min),
                                0, None, pulp.LpInteger)
                            prob += pulp.lpSum(mgr_vars) + slack >= self.min_manager
                            penalty += slack * 500000

            # ====================================================
            # TIER 3: 品質最適化 (ソフト制約)
            # ====================================================

            if tier >= 3:
                # --- OJT制約: 新人にはメンター必須 ---
                if self._rookie_ids and self._mentor_ids:
                    for d in self.dates:
                        if self._get_day_type(d) == "closed":
                            continue
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
                                penalty += slack * 200000
                            elif rookie_vars and not mentor_vars:
                                for rv in rookie_vars:
                                    penalty += rv * 200000

                # --- 戦力バランス ---
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    slot_reqs = self._build_slot_requirements(d)
                    if not slot_reqs:
                        continue
                    power_expr = pulp.LpAffineExpression()
                    for s in self.staff_list:
                        sid = s["id"]
                        rank = self._eval_rank.get(sid, "B")
                        pw = self.POWER_SCORE.get(rank, 2.0)
                        for oi in range(len(staff_opts.get((sid, d), []))):
                            power_expr += x[(sid, d, oi)] * pw
                    min_req = self._get_required_staff(d)
                    if min_req > 0:
                        slack = pulp.LpVariable("pw_{}".format(d), 0, None)
                        prob += power_expr + slack >= 1.5 * min_req
                        penalty += slack * 10000

                # --- 人件費と評価ランクによる最適化 (コスト最小化) ---
                for s in self.staff_list:
                    sid = s["id"]
                    rank = self._eval_rank.get(sid, "B")
                    # ランクペナルティ (Aは優遇、Dは後回し)
                    rank_penalty = {"A": 0, "B": 5, "C": 15, "D": 30}.get(rank, 10)
                    
                    hourly_wage = float(s.get("hourly_wage") or 1000)
                    is_monthly = str(s.get("salary_type", "hourly")).lower() == "monthly"

                    # 新機能：シフト優先度と契約区分による強力なスコア調整
                    shift_priority = str(s.get("shift_priority", "medium")).lower()
                    contract_type = str(s.get("contract_type", "general")).lower()
                    
                    priority_bonus = 0
                    if shift_priority == "high":
                        priority_bonus -= 50000  # 最優先でシフトに入れる
                    elif shift_priority == "low":
                        priority_bonus += 20000  # 穴埋めとしてのみ利用
                        
                    if contract_type == "regular":
                        priority_bonus -= 10000  # レギュラーは優先
                    elif contract_type == "spot":
                        priority_bonus += 5000   # スポットは後回し

                    for d in self.dates:
                        for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                            work_hours = opt["work_hours"]
                            # 月給制の場合はシフト追加による変動人件費はゼロとみなす
                            labor_cost = 0.0 if is_monthly else (hourly_wage * work_hours)
                            
                            # 人件費を最小化しつつ、評価の高いスタッフを優先するハイブリッドコスト
                            total_cost = (labor_cost * 0.01) + rank_penalty + priority_bonus
                            penalty += x[(sid, d, oi)] * total_cost

                # --- 勤務日数の公平性 (スタッフ個別のmax_days_weekに応じた公平配分) ---
                hourly_staff = [s for s in self.staff_list
                                if str(s.get("salary_type", "hourly")).lower() == "hourly"
                                and int(s.get("max_days_week") or 5) > 0]
                if len(hourly_staff) >= 2:
                    total_vars = {}
                    for s in hourly_staff:
                        sid = s["id"]
                        total_vars[sid] = pulp.lpSum(
                            x[(sid, d, oi)]
                            for d in self.dates
                            for oi in range(len(staff_opts.get((sid, d), [])))
                        )
                    work_days_count = len([d for d in self.dates
                                          if self._get_day_type(d) != "closed"])
                    weeks_in_period = max(work_days_count / 7.0, 1.0)
                    for s in hourly_staff:
                        sid = s["id"]
                        tv = total_vars[sid]
                        # 各スタッフのmax_days_weekに応じた個別目標値を計算
                        staff_max_days = int(s.get("max_days_week") or 5)
                        staff_target = staff_max_days * weeks_in_period * 0.5  # max_daysの50%を目標（過剰配置防止）
                        slack_over = pulp.LpVariable("fair_over_{}".format(sid), 0, None)
                        slack_under = pulp.LpVariable("fair_under_{}".format(sid), 0, None)
                        prob += tv - staff_target <= slack_over
                        prob += staff_target - tv <= slack_under
                        penalty += (slack_over + slack_under) * 50000

                    # === 店舗運営者視点：離職防止アルゴリズム（ゼロシフト絶対回避） ===
                    # 1日でも希望を出しているスタッフが「シフト0」になることは、退職の直接的な原因になります。
                    # 過剰配置ペナルティを支払ってでも、全員に最低限のシフト（週1回程度）を保証します。
                    for s in hourly_staff:
                        sid = s["id"]
                        tv = total_vars[sid]
                        # 期間中に提出された希望シフトの日数をカウント
                        submitted_days = len([d for d in self.dates if staff_opts.get((sid, d))])
                        if submitted_days > 0:
                            # 最低保証シフト数：1週間あたり1日（最低でも期間中1日は入れる）
                            target_guarantee = max(1, int(weeks_in_period * 1.0))
                            # 提出日数が保証シフト数より少ない場合は、提出日数すべてを保証する
                            guarantee_shifts = min(submitted_days, target_guarantee)
                            # 数学的エラー（Infeasible）や計算タイムアウトを防ぐため、
                            # 巨大なペナルティ変数ではなく、ソルバーに直接絶対ルール（ハード制約）として命令する。
                            prob += tv >= guarantee_shifts
                # --- min_days_week > 0 のスタッフへの配置ボーナス ---
                # min_days_weekのハード制約で確保済みなので、ボーナスは補助的に軽めに
                for s in self.staff_list:
                    sid = s["id"]
                    min_dw = int(s.get("min_days_week") or 0)
                    if min_dw > 0:
                        for d in self.dates:
                            for oi in range(len(staff_opts.get((sid, d), []))):
                                # 軽いボーナスで配置を促進（過剰配置ペナルティとバランス）
                                penalty -= x[(sid, d, oi)] * 5000

                # --- ピーク時スキルミックス制約 ---
                # ピーク時間帯（ランチ帯等）に最低1名のA/B評価スタッフを確保する
                peak_rules = self.config.get("peak_skill_rules", [])
                if not peak_rules:
                    # デフォルト: 11:00-14:00にB以上を1名確保
                    peak_rules = [
                        {"start": "11:00", "end": "14:00", "min_rank": "B", "count": 1},
                    ]
                
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    for rule in peak_rules:
                        rs = self._to_minutes(rule.get("start", "11:00"))
                        re_peak = self._to_minutes(rule.get("end", "14:00"))
                        min_rank = rule.get("min_rank", "B")
                        min_rank_score = self.POWER_SCORE.get(min_rank, 2.0)
                        req_count = int(rule.get("count", 1))
                        
                        # ピーク全スロットをカバーできるスタッフの変数を集める
                        qualified = []
                        for s in self.staff_list:
                            sid_q = s["id"]
                            rank = self._eval_rank.get(sid_q, "B")
                            if self.POWER_SCORE.get(rank, 0) >= min_rank_score:
                                for oi, opt in enumerate(staff_opts.get((sid_q, d), [])):
                                    # ピーク帯の開始をカバーしていればOK
                                    if opt["start_min"] <= rs and opt["end_min"] >= re_peak:
                                        qualified.append(x[(sid_q, d, oi)])
                                    elif opt["start_min"] <= rs and opt["end_min"] > rs:
                                        # 部分カバーでも加点
                                        qualified.append(x[(sid_q, d, oi)])
                        
                        if qualified:
                            slack = pulp.LpVariable(
                                "peak_{}_{}".format(d, rs), 0, None, pulp.LpInteger)
                            prob += pulp.lpSum(qualified) + slack >= req_count
                            penalty += slack * 50000

                print("[Tier3] Peak skill mix constraints applied ({} rules)".format(len(peak_rules)))

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
                                bonus = -500  # 基本ボーナス（希望通りにすると報酬）
                                
                                # 希望時間帯との一致度でボーナス増額
                                if req_start and req_end:
                                    rs_m = self._to_minutes(req_start)
                                    re_m = self._to_minutes(req_end)
                                    diff = abs(opt["start_min"] - rs_m) + abs(opt["end_min"] - re_m)
                                    if diff == 0:
                                        bonus = -1000  # 完全一致で2倍ボーナス
                                    elif diff <= 60:
                                        bonus = -700   # ±1時間以内で1.4倍
                                
                                penalty += x[(rsid, rd, oi)] * bonus
                                preference_count += 1

                print("[Tier3] Preference fulfillment: {} shift preferences processed".format(preference_count))

            # ====================================================
            # 目的関数: コスト最小化
            # ====================================================

            # 月給スタッフは出勤させないとペナルティ (固定費なので働かせた方が得)
            for sid in self._monthly_ids:
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    opts = staff_opts.get((sid, d), [])
                    if opts:
                        not_working = 1 - pulp.lpSum(
                            x[(sid, d, oi)] for oi in range(len(opts)))
                        penalty += not_working * 30000

            # 時給スタッフのコスト
            for s in self.staff_list:
                if str(s.get("salary_type", "hourly")).lower() != "hourly":
                    continue
                wage = float(s.get("hourly_wage", 1100))
                sid = s["id"]
                for d in self.dates:
                    for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                        penalty += x[(sid, d, oi)] * wage * opt["hours"] * 0.01

            # 強行モード時: 超過時間へのペナルティ
            if force:
                for s in self.staff_list:
                    mh = float(s.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
                    sid = s["id"]
                    for d in self.dates:
                        for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                            if opt["work_hours"] > mh:
                                penalty += x[(sid, d, oi)] * (opt["work_hours"] - mh) * 50000

            prob += penalty
            # Tierごとにタイムリミットを段階化（合計最大110秒でRailway制限内に収める）
            tier_time_limits = {3: 60, 2: 30, 1: 20}
            solver = pulp.PULP_CBC_CMD(msg=0, timeLimit=tier_time_limits.get(tier, 60))
            prob.solve(solver)

            status = pulp.LpStatus[prob.status]
            print("[MILP] Status: {} (tier={}, force={})".format(
                status, tier, force))

            if status not in ("Optimal", "Not Solved"):
                return None

            # ====================================================
            # 結果抽出
            # ====================================================
            shifts = []
            warnings = []
            for s in self.staff_list:
                sid = s["id"]
                for d in self.dates:
                    for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                        if (sid, d, oi) in x and pulp.value(x[(sid, d, oi)]) == 1:
                            hrs = opt["hours"]
                            brk = self._get_break_minutes(hrs)
                            mh = float(s.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
                            entry = {
                                "staff_id": sid,
                                "date": d,
                                "start_time": opt["start"],
                                "end_time": opt["end"],
                                "break_minutes": brk,
                            }
                            if opt["work_hours"] > mh:
                                warnings.append("{} {}: {:.1f}h over".format(
                                    s.get("name", ""), d, opt["work_hours"] - mh))
                            shifts.append(entry)

            self._validate(shifts)
            if warnings:
                print("[OVERTIME]")
                for w in warnings:
                    print("  " + w)

            print("[Result] {} shifts".format(len(shifts)))
            return shifts if shifts else None

        except Exception as e:
            print("[MILP Error] {}".format(e))
            import traceback
            traceback.print_exc()
            return None

    # ===========================================================
    # バリデーション
    # ===========================================================

    def _validate(self, shifts):
        violations = 0

        # カバレッジ検証
        for d in self.dates:
            reqs = self._build_slot_requirements(d)
            day_s = [s for s in shifts if s["date"] == d]
            for slot_min, req in reqs.items():
                cov = sum(1 for s in day_s
                          if self._to_minutes(s["start_time"]) <= slot_min
                          < self._to_minutes(s["end_time"]))
                if cov < req:
                    print("  VIOLATION: {} {} need={} got={}".format(
                        d, self._from_minutes(slot_min), req, cov))
                    violations += 1

        # 連勤検証
        sorted_d = sorted(self.dates)
        for s in self.staff_list:
            sid = s["id"]
            consec = 0
            for d in sorted_d:
                if any(sh["staff_id"] == sid and sh["date"] == d for sh in shifts):
                    consec += 1
                    if consec > self.LEGAL_MAX_CONSECUTIVE_DAYS:
                        print("  VIOLATION: {} consec={} days at {}".format(
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
                    print("  VIOLATION: {} week {} hours={:.1f} > {}".format(
                        s.get("name", sid), week[0], total_hours,
                        self.LEGAL_MAX_HOURS_WEEK))
                    violations += 1

        # NG日検証
        for s in self.staff_list:
            sid = s["id"]
            ng = self._get_staff_ng_dates(s)
            for sh in shifts:
                if sh["staff_id"] == sid and sh["date"] in ng:
                    print("  VIOLATION: {} assigned on NG date {}".format(
                        s.get("name", sid), sh["date"]))
                    violations += 1

        if violations == 0:
            print("  VALIDATION: All constraints satisfied!")
        else:
            print("  VALIDATION: {} violations".format(violations))

    # ===========================================================
    # グリーディ解法 (MILP失敗時のフォールバック)
    # ===========================================================

    def _solve_greedy(self):
        shifts = []
        weekly_count = {}     # {staff_id: {week_key: count}}
        weekly_hours = {}     # {staff_id: {week_key: hours}}
        consecutive = {}      # {staff_id: current_consecutive_days}
        last_work_date = {}   # {staff_id: last_date_str}

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

            # 不足スロットを埋める
            for _ in range(30):
                deficit = {}
                for slot_min, req in slot_reqs.items():
                    cov = sum(1 for s in day_shifts
                              if self._to_minutes(s["start_time"]) <= slot_min
                              < self._to_minutes(s["end_time"]))
                    if cov < req:
                        deficit[slot_min] = req - cov
                if not deficit:
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
                    if self._greedy_check_limits(sid, wk, weekly_count,
                                                 weekly_hours, consecutive, s):
                        continue
                    max_hours = float(s.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
                    for opt in self._build_shift_options(s, d, force=False):
                        if opt["hours"] > max_hours:
                            continue
                        if opt["start_min"] <= worst < opt["end_min"]:
                            c = sum(1 for sm in deficit
                                    if opt["start_min"] <= sm < opt["end_min"])
                            if c > best_cov:
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

        print("[Greedy] {} shifts".format(len(shifts)))
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
