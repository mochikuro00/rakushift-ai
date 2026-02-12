import pulp
import random
from datetime import datetime, timedelta


class ShiftScheduler:
    def __init__(self, staff_list, config, dates, requests=[]):
        self.staff_list = staff_list
        self.config = config
        self.dates = dates
        self.requests = requests

        raw_patterns = config.get('custom_shifts', [])
        self.shift_patterns = []
        for p in raw_patterns:
            st = p.get('start', '09:00')
            en = p.get('end', '18:00')
            self.shift_patterns.append({
                'start': st, 'end': en, 'name': p.get('name', '')
            })

        if not self.shift_patterns:
            self.shift_patterns = [
                {'start': '09:00', 'end': '17:00', 'name': 'early'},
                {'start': '14:00', 'end': '22:00', 'name': 'late'},
            ]

        self.op_limit = config.get('opening_time', '09:00')
        self.cl_limit = config.get('closing_time', '22:00')

        raw_ot = config.get('opening_times', {})
        if not raw_ot or not raw_ot.get('weekday'):
            self.opening_times = {
                'weekday': {'start': self.op_limit, 'end': self.cl_limit},
                'weekend': {'start': self.op_limit, 'end': self.cl_limit},
                'holiday': {'start': self.op_limit, 'end': self.cl_limit}
            }
        else:
            self.opening_times = raw_ot

        self.staff_req = config.get('staff_req', {})
        self.min_weekday = int(self.staff_req.get('min_weekday', 2))
        self.min_weekend = int(self.staff_req.get('min_weekend', 3))
        self.min_holiday = int(self.staff_req.get('min_holiday', 3))
        self.min_manager = int(self.staff_req.get('min_manager', 1))

        self.time_staff_req = config.get('time_staff_req', [])

        self.break_rules = config.get('break_rules', [
            {'min_hours': 6, 'break_minutes': 45},
            {'min_hours': 8, 'break_minutes': 60}
        ])

        self.closed_days = config.get('closed_days', [])
        self.special_holidays = config.get('special_holidays', [])

        print("[Init] Staff: {}, Dates: {}".format(
            len(self.staff_list), len(self.dates)))
        print("[Init] Patterns: {}".format(self.shift_patterns))
        print("[Init] Requirements: weekday={}, weekend={}, holiday={}".format(
            self.min_weekday, self.min_weekend, self.min_holiday))

    # =========================================================
    # Helper functions
    # =========================================================
    def _to_minutes(self, time_str):
        try:
            parts = str(time_str).split(':')
            return int(parts[0]) * 60 + int(parts[1])
        except:
            return 0

    def _from_minutes(self, mins):
        h = int(mins) // 60
        m = int(mins) % 60
        return "{:02d}:{:02d}".format(h, m)

    def _get_day_type(self, date_str):
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        dow = dt.weekday()
        if date_str in self.special_holidays:
            return 'closed'
        js_dow = (dow + 1) % 7
        if js_dow in self.closed_days:
            return 'closed'
        if dow == 6:
            return 'holiday'
        if dow == 5:
            return 'weekend'
        return 'weekday'

    def _get_required_staff(self, date_str):
        day_type = self._get_day_type(date_str)
        if day_type == 'closed':
            return 0
        elif day_type == 'holiday':
            return self.min_holiday
        elif day_type == 'weekend':
            return self.min_weekend
        else:
            return self.min_weekday

    def _get_opening_hours(self, date_str):
        special_days = self.config.get('special_days', {})
        if date_str in special_days:
            sd = special_days[date_str]
            return sd.get('start', self.op_limit), sd.get('end', self.cl_limit)
        day_type = self._get_day_type(date_str)
        if day_type == 'holiday':
            t = self.opening_times.get('holiday', {})
        elif day_type == 'weekend':
            t = self.opening_times.get('weekend', {})
        else:
            t = self.opening_times.get('weekday', {})
        return t.get('start', self.op_limit), t.get('end', self.cl_limit)

    def _get_break_minutes(self, duration_hours):
        brk = 0
        sorted_rules = sorted(
            self.break_rules, key=lambda r: r.get('min_hours', 0))
        for rule in sorted_rules:
            if duration_hours > rule.get('min_hours', 0):
                brk = rule.get('break_minutes', 0)
        return brk

    def _get_ng_dates(self, staff):
        raw = staff.get('unavailable_dates')
        if not raw:
            return []
        if isinstance(raw, list):
            return [str(d).strip() for d in raw]
        return [str(d).strip() for d in str(raw).split(',')]

    def _get_staff_ng_dates(self, staff):
        ng = self._get_ng_dates(staff)
        for req in self.requests:
            if (req.get('staff_id') == staff['id'] and
                req.get('type') in ['off', 'holiday'] and
                    req.get('status') == 'approved'):
                rd = str(req.get('dates', ''))
                if rd and rd not in ng:
                    ng.append(rd)
        return ng

    def _group_dates_by_week(self):
        if not self.dates:
            return []
        weeks = []
        current_week = []
        for d in sorted(self.dates):
            dt = datetime.strptime(d, '%Y-%m-%d')
            if not current_week:
                current_week.append(d)
            else:
                prev_dt = datetime.strptime(current_week[-1], '%Y-%m-%d')
                if (dt.isocalendar()[1] == prev_dt.isocalendar()[1] and
                        dt.year == prev_dt.year):
                    current_week.append(d)
                else:
                    weeks.append(current_week)
                    current_week = [d]
        if current_week:
            weeks.append(current_week)
        return weeks

    def _build_shift_options(self, staff, date_str, force=False):
        day_open, day_close = self._get_opening_hours(date_str)
        open_min = self._to_minutes(day_open)
        close_min = self._to_minutes(day_close)

        salary_type = str(staff.get('salary_type', 'hourly')).lower()
        max_hours = float(staff.get('max_hours_day') or 8)

        if not force and max_hours <= 0:
            return []

        if force and max_hours <= 0:
            max_hours = 8

        options = []
        for pattern in self.shift_patterns:
            p_start = self._to_minutes(pattern['start'])
            p_end = self._to_minutes(pattern['end'])

            if p_start < open_min or p_end > close_min:
                p_start = max(p_start, open_min)
                p_end = min(p_end, close_min)

            if p_start >= p_end:
                continue

            actual_hours = (p_end - p_start) / 60

            if actual_hours < 1:
                continue

            if force:
                pass
            else:
                if actual_hours > max_hours + 0.01:
                    continue

            options.append({
                'start': self._from_minutes(p_start),
                'end': self._from_minutes(p_end),
                'start_min': p_start,
                'end_min': p_end,
                'hours': actual_hours
            })

        return options

    def _build_slot_requirements(self, date_str):
        req_num = self._get_required_staff(date_str)
        if req_num <= 0:
            return {}
        day_open, day_close = self._get_opening_hours(date_str)
        op_min = self._to_minutes(day_open)
        cl_min = self._to_minutes(day_close)

        slots = {}
        for t in range(op_min, cl_min, 15):
            slots[t] = req_num

        dt = datetime.strptime(date_str, '%Y-%m-%d')
        js_dow = (dt.weekday() + 1) % 7

        for rule in self.time_staff_req:
            rule_days = rule.get('days', [])
            if js_dow not in rule_days:
                continue
            r_start = self._to_minutes(rule.get('start', '00:00'))
            r_end = self._to_minutes(rule.get('end', '24:00'))
            r_count = int(rule.get('count', 0))
            for t in range(op_min, cl_min, 15):
                if r_start <= r_end:
                    in_range = (t >= r_start and t < r_end)
                else:
                    in_range = (t >= r_start or t < r_end)
                if in_range and t in slots:
                    slots[t] = max(slots[t], r_count)
        return slots

    # =========================================================
    # Pre-check: analyze staffing feasibility
    # =========================================================
    def pre_check(self):
        warnings = []
        daily_details = []
        total_shortage_hours = 0

        usable_staff = [
            s for s in self.staff_list
            if int(s.get('max_days_week') or 5) > 0
        ]
        unusable_staff = [
            s for s in self.staff_list
            if int(s.get('max_days_week') or 5) <= 0
        ]

        if unusable_staff:
            names = [s.get('name', s['id']) for s in unusable_staff]
            warnings.append({
                'type': 'unusable_staff',
                'message': '{}名が出勤不可（max_days=0）: {}'.format(
                    len(names), ', '.join(names)),
                'severity': 'info'
            })

        weekly_capacity = sum(
            int(s.get('max_days_week') or 5) for s in usable_staff)

        for d in sorted(self.dates):
            day_type = self._get_day_type(d)
            if day_type == 'closed':
                continue

            slot_reqs = self._build_slot_requirements(d)
            if not slot_reqs:
                continue

            day_open, day_close = self._get_opening_hours(d)

            available_staff = []
            for s in usable_staff:
                ng = self._get_staff_ng_dates(s)
                if d not in ng:
                    available_staff.append(s)

            slot_coverage = {}
            for slot_min, req_count in slot_reqs.items():
                can_cover = 0
                for s in available_staff:
                    options = self._build_shift_options(s, d, force=False)
                    for opt in options:
                        if opt['start_min'] <= slot_min < opt['end_min']:
                            can_cover += 1
                            break
                slot_coverage[slot_min] = {
                    'required': req_count,
                    'available': can_cover,
                    'shortage': max(0, req_count - can_cover)
                }

            shortage_slots = {
                k: v for k, v in slot_coverage.items() if v['shortage'] > 0
            }

            if shortage_slots:
                shortage_ranges = []
                current_start = None
                current_short = 0
                prev_slot = None

                for slot_min in sorted(shortage_slots.keys()):
                    info = shortage_slots[slot_min]
                    if current_start is None:
                        current_start = slot_min
                        current_short = info['shortage']
                    elif slot_min == prev_slot + 15 and info['shortage'] == current_short:
                        pass
                    else:
                        shortage_ranges.append({
                            'start': self._from_minutes(current_start),
                            'end': self._from_minutes(prev_slot + 15),
                            'shortage': current_short
                        })
                        current_start = slot_min
                        current_short = info['shortage']
                    prev_slot = slot_min

                if current_start is not None:
                    shortage_ranges.append({
                        'start': self._from_minutes(current_start),
                        'end': self._from_minutes(prev_slot + 15),
                        'shortage': current_short
                    })

                shortage_hours = sum(
                    s['shortage'] * 0.25 for s in shortage_slots.values())
                total_shortage_hours += shortage_hours

                daily_details.append({
                    'date': d,
                    'day_type': day_type,
                    'available_staff': len(available_staff),
                    'required_per_slot': self._get_required_staff(d),
                    'shortage_ranges': shortage_ranges,
                    'shortage_hours': round(shortage_hours, 1)
                })

        if total_shortage_hours > 0:
            warnings.append({
                'type': 'staff_shortage',
                'message': '合計 {:.1f} 人時の人員不足があります'.format(
                    total_shortage_hours),
                'severity': 'critical',
                'total_shortage_hours': round(total_shortage_hours, 1),
                'affected_days': len(daily_details)
            })

        week_groups = self._group_dates_by_week()
        for week_dates in week_groups:
            work_days_needed = sum(
                1 for d in week_dates
                if self._get_day_type(d) != 'closed'
            )
            if work_days_needed > 0:
                needed_person_days = sum(
                    self._get_required_staff(d) for d in week_dates
                    if self._get_day_type(d) != 'closed'
                )
                if needed_person_days > weekly_capacity:
                    warnings.append({
                        'type': 'weekly_capacity',
                        'message': '週 {} ~ {}: 必要{}人日 > 供給可能{}人日'.format(
                            week_dates[0], week_dates[-1],
                            needed_person_days, weekly_capacity),
                        'severity': 'warning'
                    })

        feasible = total_shortage_hours == 0

        return {
            'feasible': feasible,
            'warnings': warnings,
            'daily_details': daily_details,
            'summary': {
                'total_staff': len(self.staff_list),
                'usable_staff': len(usable_staff),
                'total_dates': len(self.dates),
                'work_dates': len([
                    d for d in self.dates
                    if self._get_day_type(d) != 'closed'
                ]),
                'total_shortage_hours': round(total_shortage_hours, 1),
                'affected_days': len(daily_details)
            }
        }

    # =========================================================
    # Main solver
    # =========================================================
    def solve(self, force=False):
        result = self._solve_optimized(force=force)
        if not result:
            print("Optimized solver failed. Trying fallback...")
            result = self._solve_fallback(force=force)
        return result

    def _solve_optimized(self, force=False):
        try:
            problem = pulp.LpProblem("Shift_Optimization", pulp.LpMinimize)

            monthly_ids = []
            managers = []
            eval_score = {}

            for s in self.staff_list:
                sid = s['id']
                if str(s.get('salary_type', 'hourly')).lower() == 'monthly':
                    monthly_ids.append(sid)
                if str(s.get('role', 'staff')).lower() in ['manager', 'leader']:
                    managers.append(sid)
                score_map = {'A': 4, 'B': 3, 'C': 2, 'D': 1}
                eval_score[sid] = score_map.get(
                    str(s.get('evaluation', 'B')).upper(), 3)

            x = {}
            staff_options = {}

            for s in self.staff_list:
                ng_dates = self._get_staff_ng_dates(s)

                for d in self.dates:
                    if d in ng_dates or self._get_day_type(d) == 'closed':
                        staff_options[(s['id'], d)] = []
                        continue

                    options = self._build_shift_options(s, d, force=force)
                    staff_options[(s['id'], d)] = options

                    for oi, opt in enumerate(options):
                        x[(s['id'], d, oi)] = pulp.LpVariable(
                            "x_{}_{}_{}" .format(s['id'], d, oi),
                            0, 1, pulp.LpBinary
                        )

            for s in self.staff_list:
                d0 = self.dates[0] if self.dates else ''
                opts = staff_options.get((s['id'], d0), [])
                opt_list = [o['start'] + '-' + o['end'] for o in opts]
                print("  Staff '{}' options on {}: {}".format(
                    s.get('name', ''), d0, opt_list))

            penalty = pulp.LpAffineExpression()

            # Constraint 1: max 1 shift per day
            for s in self.staff_list:
                for d in self.dates:
                    opts = staff_options.get((s['id'], d), [])
                    if opts:
                        problem += pulp.lpSum(
                            [x[(s['id'], d, oi)]
                             for oi in range(len(opts))]
                        ) <= 1

            # Constraint 2: cover all time slots
            for d in self.dates:
                slot_reqs = self._build_slot_requirements(d)
                for slot_min, req_count in slot_reqs.items():
                    workers = []
                    for s in self.staff_list:
                        opts = staff_options.get((s['id'], d), [])
                        for oi, opt in enumerate(opts):
                            if opt['start_min'] <= slot_min < opt['end_min']:
                                workers.append(x[(s['id'], d, oi)])
                    if workers:
                        slack = pulp.LpVariable(
                            "slot_{}_{}".format(d, slot_min),
                            0, None, pulp.LpInteger
                        )
                        problem += pulp.lpSum(workers) + slack >= req_count
                        penalty += slack * 1000000
                    else:
                        time_str = self._from_minutes(slot_min)
                        print("  CRITICAL: No staff can cover {} {} (need {})".format(
                            d, time_str, req_count))

            # Constraint 3: manager minimum
            for d in self.dates:
                if self._get_day_type(d) == 'closed':
                    continue
                slot_reqs = self._build_slot_requirements(d)
                if not slot_reqs:
                    continue
                for slot_min in slot_reqs.keys():
                    mgr_vars = []
                    for mid in managers:
                        opts = staff_options.get((mid, d), [])
                        for oi, opt in enumerate(opts):
                            if opt['start_min'] <= slot_min < opt['end_min']:
                                mgr_vars.append(x[(mid, d, oi)])
                    if mgr_vars:
                        slack = pulp.LpVariable(
                            "mgr_{}_{}".format(d, slot_min),
                            0, None, pulp.LpInteger
                        )
                        problem += pulp.lpSum(mgr_vars) + slack >= self.min_manager
                        penalty += slack * 500000

            # Constraint 4: weekly day limit
            week_groups = self._group_dates_by_week()
            for s in self.staff_list:
                max_days = int(s.get('max_days_week') or 5)
                if not force and max_days <= 0:
                    for d in self.dates:
                        opts = staff_options.get((s['id'], d), [])
                        for oi in range(len(opts)):
                            problem += x[(s['id'], d, oi)] == 0
                    continue

                effective_max = max_days if not force else max(max_days, 6)

                for week_dates in week_groups:
                    week_vars = []
                    for d in week_dates:
                        opts = staff_options.get((s['id'], d), [])
                        for oi in range(len(opts)):
                            week_vars.append(x[(s['id'], d, oi)])
                    if week_vars:
                        problem += pulp.lpSum(week_vars) <= effective_max

            # Constraint 5: max 6 consecutive days
            if not force:
                for s in self.staff_list:
                    sorted_dates = sorted(self.dates)
                    for idx in range(len(sorted_dates) - 6):
                        span = sorted_dates[idx:idx + 7]
                        span_vars = []
                        for d in span:
                            opts = staff_options.get((s['id'], d), [])
                            for oi in range(len(opts)):
                                span_vars.append(x[(s['id'], d, oi)])
                        if span_vars:
                            problem += pulp.lpSum(span_vars) <= 6

            # Objective: monthly staff should work
            for sid in monthly_ids:
                for d in self.dates:
                    if self._get_day_type(d) == 'closed':
                        continue
                    opts = staff_options.get((sid, d), [])
                    if opts:
                        not_working = 1 - pulp.lpSum(
                            [x[(sid, d, oi)] for oi in range(len(opts))]
                        )
                        penalty += not_working * 30000

            # Objective: evaluation score cost
            for s in self.staff_list:
                sid = s['id']
                score = eval_score.get(sid, 3)
                cost_map = {4: 0, 3: 50, 2: 300, 1: 1500}
                cost = cost_map.get(score, 50)
                for d in self.dates:
                    opts = staff_options.get((sid, d), [])
                    for oi in range(len(opts)):
                        penalty += x[(sid, d, oi)] * cost

            # Objective: minimize labor cost
            for s in self.staff_list:
                if str(s.get('salary_type', 'hourly')).lower() != 'hourly':
                    continue
                wage = float(s.get('hourly_wage', 1100))
                for d in self.dates:
                    opts = staff_options.get((s['id'], d), [])
                    for oi, opt in enumerate(opts):
                        penalty += x[(s['id'], d, oi)] * wage * opt['hours'] * 0.01

            # Objective: in force mode, penalize overtime
            if force:
                for s in self.staff_list:
                    max_hours = float(s.get('max_hours_day') or 8)
                    for d in self.dates:
                        opts = staff_options.get((s['id'], d), [])
                        for oi, opt in enumerate(opts):
                            if opt['hours'] > max_hours:
                                overtime = opt['hours'] - max_hours
                                penalty += x[(s['id'], d, oi)] * overtime * 50000

            problem += penalty
            solver = pulp.PULP_CBC_CMD(msg=0, timeLimit=120)
            problem.solve(solver)

            status = pulp.LpStatus[problem.status]
            print("Solver status: {}".format(status))

            if status in ['Optimal', 'Not Solved']:
                shifts = []
                overtime_warnings = []
                for s in self.staff_list:
                    for d in self.dates:
                        opts = staff_options.get((s['id'], d), [])
                        for oi, opt in enumerate(opts):
                            if ((s['id'], d, oi) in x and
                                    pulp.value(x[(s['id'], d, oi)]) == 1):
                                dur = opt['hours']
                                brk = self._get_break_minutes(dur)
                                max_h = float(s.get('max_hours_day') or 8)
                                shift_entry = {
                                    "staff_id": s['id'],
                                    "date": d,
                                    "start_time": opt['start'],
                                    "end_time": opt['end'],
                                    "break_minutes": brk
                                }
                                if dur > max_h:
                                    shift_entry["overtime"] = True
                                    shift_entry["overtime_hours"] = round(
                                        dur - max_h, 1)
                                    overtime_warnings.append(
                                        "{} {}: {:.1f}h超過".format(
                                            s.get('name', ''), d,
                                            dur - max_h))
                                shifts.append(shift_entry)

                self._validate_result(shifts)

                if overtime_warnings:
                    print("OVERTIME WARNINGS:")
                    for w in overtime_warnings:
                        print("  " + w)

                print("Generated {} shifts".format(len(shifts)))
                return shifts if shifts else None

            return None

        except Exception as e:
            print("Solver Error: {}".format(e))
            import traceback
            traceback.print_exc()
            return None

    def _validate_result(self, shifts):
        violations = 0
        for d in self.dates:
            slot_reqs = self._build_slot_requirements(d)
            day_shifts = [s for s in shifts if s['date'] == d]
            for slot_min, req_count in slot_reqs.items():
                coverage = 0
                for s in day_shifts:
                    s_start = self._to_minutes(s['start_time'])
                    s_end = self._to_minutes(s['end_time'])
                    if s_start <= slot_min < s_end:
                        coverage += 1
                if coverage < req_count:
                    time_str = self._from_minutes(slot_min)
                    print("  WARNING: {} {} - Need {}, got {}".format(
                        d, time_str, req_count, coverage))
                    violations += 1
        if violations == 0:
            print("  VALIDATION: All time slots fully covered!")
        else:
            print("  VALIDATION: {} slot violations found".format(violations))

    def _solve_fallback(self, force=False):
        shifts = []
        weekly_count = {}
        for d in sorted(self.dates):
            if self._get_day_type(d) == 'closed':
                continue
            slot_reqs = self._build_slot_requirements(d)
            if not slot_reqs:
                continue
            dt = datetime.strptime(d, '%Y-%m-%d')
            week_key = "{}-W{}".format(dt.year, dt.isocalendar()[1])
            day_shifts = []
            assigned_staff = set()
            max_passes = 20
            for _ in range(max_passes):
                deficit_slots = {}
                for slot_min, req_count in slot_reqs.items():
                    coverage = 0
                    for s in day_shifts:
                        s_start = self._to_minutes(s['start_time'])
                        s_end = self._to_minutes(s['end_time'])
                        if s_start <= slot_min < s_end:
                            coverage += 1
                    if coverage < req_count:
                        deficit_slots[slot_min] = req_count - coverage
                if not deficit_slots:
                    break
                worst_slot = max(deficit_slots, key=deficit_slots.get)
                best_staff = None
                best_option = None
                best_coverage = 0
                for s in self.staff_list:
                    if s['id'] in assigned_staff:
                        continue
                    ng = self._get_staff_ng_dates(s)
                    if d in ng:
                        continue
                    max_days = int(s.get('max_days_week') or 5)
                    if not force and max_days <= 0:
                        continue
                    effective_max = max_days if not force else max(max_days, 6)
                    current = weekly_count.get(
                        s['id'], {}).get(week_key, 0)
                    if current >= effective_max:
                        continue
                    options = self._build_shift_options(s, d, force=force)
                    for opt in options:
                        if opt['start_min'] <= worst_slot < opt['end_min']:
                            cov = sum(
                                1 for sm in deficit_slots
                                if opt['start_min'] <= sm < opt['end_min'])
                            if cov > best_coverage:
                                best_coverage = cov
                                best_staff = s
                                best_option = opt
                if best_staff and best_option:
                    brk = self._get_break_minutes(best_option['hours'])
                    shift = {
                        "staff_id": best_staff['id'],
                        "date": d,
                        "start_time": best_option['start'],
                        "end_time": best_option['end'],
                        "break_minutes": brk
                    }
                    day_shifts.append(shift)
                    assigned_staff.add(best_staff['id'])
                    if best_staff['id'] not in weekly_count:
                        weekly_count[best_staff['id']] = {}
                    weekly_count[best_staff['id']][week_key] = (
                        weekly_count[best_staff['id']].get(week_key, 0) + 1)
                else:
                    break
            shifts.extend(day_shifts)
        return shifts
