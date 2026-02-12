import pulp
from datetime import datetime, timedelta


class ShiftScheduler:

    DEFAULT_BREAK_RULES = [
        {"min_hours": 6, "break_minutes": 45},
        {"min_hours": 8, "break_minutes": 60},
    ]

    MENTOR_ROLES = {"manager", "leader"}
    ROOKIE_ROLES = {"rookie"}
    POWER_SCORE = {"A": 3.0, "B": 2.0, "C": 1.0, "D": 0.5}

    def __init__(self, staff_list, config, dates, requests=None):
        self.staff_list = staff_list or []
        self.config = config or {}
        self.dates = sorted(dates or [])
        self.requests = requests or []

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

        sr = self.config.get("staff_req", {})
        self.min_weekday = int(sr.get("min_weekday", 2))
        self.min_weekend = int(sr.get("min_weekend", 3))
        self.min_holiday = int(sr.get("min_holiday", 3))
        self.min_manager = int(sr.get("min_manager", 1))
        self.time_staff_req = self.config.get("time_staff_req", [])

        self.break_rules = self.config.get("break_rules", [])
        if not self.break_rules:
            self.break_rules = self.DEFAULT_BREAK_RULES

        self.closed_days = self.config.get("closed_days", [])
        self.special_holidays = self.config.get("special_holidays", [])
        self.special_days = self.config.get("special_days", {})

        self._mentor_ids = set()
        self._rookie_ids = set()
        self._monthly_ids = set()
        self._manager_ids = set()
        self._eval_rank = {}

        for s in self.staff_list:
            sid = s["id"]
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

        print("[Init] Staff:{} Dates:{} Patterns:{}".format(
            len(self.staff_list), len(self.dates), len(self.shift_patterns)))
        print("[Init] Req: wd={} we={} hol={} mgr={}".format(
            self.min_weekday, self.min_weekend,
            self.min_holiday, self.min_manager))
        print("[Init] Mentors:{} Rookies:{} Monthly:{}".format(
            len(self._mentor_ids), len(self._rookie_ids),
            len(self._monthly_ids)))

    def _to_minutes(self, time_str):
        try:
            parts = str(time_str).split(":")
            return int(parts[0]) * 60 + int(parts[1])
        except Exception:
            return 0

    def _from_minutes(self, mins):
        return "{:02d}:{:02d}".format(int(mins) // 60, int(mins) % 60)

    def _get_day_type(self, date_str):
        if date_str in self.special_holidays:
            return "closed"
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        js_dow = (dt.weekday() + 1) % 7
        if js_dow in self.closed_days:
            return "closed"
        if dt.weekday() == 6:
            return "holiday"
        if dt.weekday() == 5:
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
        brk = 0
        for rule in sorted(self.break_rules, key=lambda r: r.get("min_hours", 0)):
            if hours > rule.get("min_hours", 0):
                brk = rule.get("break_minutes", 0)
        return brk

    def _get_staff_ng_dates(self, staff):
        raw = staff.get("unavailable_dates")
        ng = []
        if raw:
            if isinstance(raw, list):
                ng = [str(d).strip() for d in raw]
            else:
                ng = [str(d).strip() for d in str(raw).split(",")]
        for req in self.requests:
            if (req.get("staff_id") == staff["id"]
                    and req.get("type") in ("off", "holiday")
                    and req.get("status") == "approved"):
                rd = str(req.get("dates", ""))
                if rd and rd not in ng:
                    ng.append(rd)
        return ng

    def _group_dates_by_week(self):
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
        day_open, day_close = self._get_opening_hours(date_str)
        open_min = self._to_minutes(day_open)
        close_min = self._to_minutes(day_close)
        if open_min >= close_min:
            return []

        max_hours = float(staff.get("max_hours_day") or 8)
        if not force and max_hours <= 0:
            return []
        if force and max_hours <= 0:
            max_hours = 8

        options = []
        seen = set()
        for pat in self.shift_patterns:
            ps = max(self._to_minutes(pat["start"]), open_min)
            pe = min(self._to_minutes(pat["end"]), close_min)
            if ps >= pe:
                continue
            hrs = (pe - ps) / 60.0
            if hrs < 1:
                continue
            key = (ps, pe)
            if key in seen:
                continue
            seen.add(key)
            options.append({
                "start": self._from_minutes(ps),
                "end": self._from_minutes(pe),
                "start_min": ps, "end_min": pe, "hours": hrs,
            })
        return options

    def _build_slot_requirements(self, date_str):
        req_num = self._get_required_staff(date_str)
        if req_num <= 0:
            return {}
        day_open, day_close = self._get_opening_hours(date_str)
        op = self._to_minutes(day_open)
        cl = self._to_minutes(day_close)
        if op >= cl:
            return {}
        slots = {}
        for t in range(op, cl, 15):
            slots[t] = req_num

        dt = datetime.strptime(date_str, "%Y-%m-%d")
        js_dow = (dt.weekday() + 1) % 7
        for rule in self.time_staff_req:
            if js_dow not in rule.get("days", []):
                continue
            rs = self._to_minutes(rule.get("start", "00:00"))
            re = self._to_minutes(rule.get("end", "24:00"))
            rc = int(rule.get("count", 0))
            for t in range(op, cl, 15):
                in_range = (rs <= t < re) if rs <= re else (t >= rs or t < re)
                if in_range and t in slots:
                    slots[t] = max(slots[t], rc)
        return slots

    def _is_mentor(self, staff):
        return staff["id"] in self._mentor_ids

    def _is_rookie(self, staff):
        return staff["id"] in self._rookie_ids

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
            prob = pulp.LpProblem("RakuShift_v2", pulp.LpMinimize)
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

            # ========== TIER 1: Legal / Contract ==========

            for s in self.staff_list:
                sid = s["id"]
                for d in self.dates:
                    opts = staff_opts.get((sid, d), [])
                    if opts:
                        prob += pulp.lpSum(
                            x[(sid, d, oi)] for oi in range(len(opts))
                        ) <= 1

            week_groups = self._group_dates_by_week()
            for s in self.staff_list:
                sid = s["id"]
                max_days = int(s.get("max_days_week") or 5)
                if not force and max_days <= 0:
                    for d in self.dates:
                        for oi in range(len(staff_opts.get((sid, d), []))):
                            prob += x[(sid, d, oi)] == 0
                    continue
                effective = max_days if not force else max(max_days, 6)
                for week in week_groups:
                    wv = []
                    for d in week:
                        for oi in range(len(staff_opts.get((sid, d), []))):
                            wv.append(x[(sid, d, oi)])
                    if wv:
                        prob += pulp.lpSum(wv) <= effective

            if not force:
                sorted_d = sorted(self.dates)
                for s in self.staff_list:
                    sid = s["id"]
                    for i in range(len(sorted_d) - 6):
                        span = sorted_d[i:i + 7]
                        sv = []
                        for d in span:
                            for oi in range(len(staff_opts.get((sid, d), []))):
                                sv.append(x[(sid, d, oi)])
                        if sv:
                            prob += pulp.lpSum(sv) <= 6

            # ========== TIER 2: Coverage ==========

            if tier >= 2:
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
                            slack = pulp.LpVariable(
                                "cov_{}_{}".format(d, slot_min),
                                0, None, pulp.LpInteger)
                            prob += pulp.lpSum(workers) + slack >= req
                            penalty += slack * 1000000

                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    slot_reqs = self._build_slot_requirements(d)
                    if not slot_reqs:
                        continue
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

            # ========== TIER 3: OJT / Power Balance ==========

            if tier >= 3:
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

                for s in self.staff_list:
                    sid = s["id"]
                    rank = self._eval_rank.get(sid, "B")
                    cost = {"A": 0, "B": 50, "C": 500, "D": 2000}.get(rank, 50)
                    for d in self.dates:
                        for oi in range(len(staff_opts.get((sid, d), []))):
                            penalty += x[(sid, d, oi)] * cost

            # ========== OBJECTIVES ==========

            for sid in self._monthly_ids:
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    opts = staff_opts.get((sid, d), [])
                    if opts:
                        not_working = 1 - pulp.lpSum(
                            x[(sid, d, oi)] for oi in range(len(opts)))
                        penalty += not_working * 30000

            for s in self.staff_list:
                if str(s.get("salary_type", "hourly")).lower() != "hourly":
                    continue
                wage = float(s.get("hourly_wage", 1100))
                sid = s["id"]
                for d in self.dates:
                    for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                        penalty += x[(sid, d, oi)] * wage * opt["hours"] * 0.01

            if force:
                for s in self.staff_list:
                    mh = float(s.get("max_hours_day") or 8)
                    sid = s["id"]
                    for d in self.dates:
                        for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                            if opt["hours"] > mh:
                                penalty += x[(sid, d, oi)] * (opt["hours"] - mh) * 50000

            prob += penalty
            solver = pulp.PULP_CBC_CMD(msg=0, timeLimit=120)
            prob.solve(solver)

            status = pulp.LpStatus[prob.status]
            print("[MILP] Status: {} (tier={}, force={})".format(
                status, tier, force))

            if status not in ("Optimal", "Not Solved"):
                return None

            shifts = []
            warnings = []
            for s in self.staff_list:
                sid = s["id"]
                for d in self.dates:
                    for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                        if (sid, d, oi) in x and pulp.value(x[(sid, d, oi)]) == 1:
                            hrs = opt["hours"]
                            brk = self._get_break_minutes(hrs)
                            mh = float(s.get("max_hours_day") or 8)
                            entry = {
                                "staff_id": sid,
                                "date": d,
                                "start_time": opt["start"],
                                "end_time": opt["end"],
                                "break_minutes": brk,
                            }
                            if hrs > mh:
                                entry["overtime"] = True
                                entry["overtime_hours"] = round(hrs - mh, 1)
                                warnings.append("{} {}: {:.1f}h over".format(
                                    s.get("name", ""), d, hrs - mh))
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

    def _validate(self, shifts):
        violations = 0
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
        if violations == 0:
            print("  VALIDATION: All slots covered!")
        else:
            print("  VALIDATION: {} violations".format(violations))

    def _solve_greedy(self):
        shifts = []
        weekly_count = {}
        for d in sorted(self.dates):
            if self._get_day_type(d) == "closed":
                continue
            slot_reqs = self._build_slot_requirements(d)
            if not slot_reqs:
                continue
            dt = datetime.strptime(d, "%Y-%m-%d")
            wk = "{}-W{}".format(dt.year, dt.isocalendar()[1])
            day_shifts = []
            assigned = set()

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

                sorted_staff = sorted(
                    self.staff_list,
                    key=lambda s: (
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
                    md = int(s.get("max_days_week") or 5)
                    if md <= 0:
                        md = 6
                    cur = weekly_count.get(sid, {}).get(wk, 0)
                    if cur >= md:
                        continue
                    for opt in self._build_shift_options(s, d, force=True):
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
                    day_shifts.append({
                        "staff_id": best_s["id"],
                        "date": d,
                        "start_time": best_o["start"],
                        "end_time": best_o["end"],
                        "break_minutes": brk,
                    })
                    assigned.add(best_s["id"])
                    weekly_count.setdefault(best_s["id"], {})
                    weekly_count[best_s["id"]][wk] = (
                        weekly_count[best_s["id"]].get(wk, 0) + 1)
                else:
                    break
            shifts.extend(day_shifts)

        print("[Greedy] {} shifts".format(len(shifts)))
        self._validate(shifts)
        return shifts if shifts else None
