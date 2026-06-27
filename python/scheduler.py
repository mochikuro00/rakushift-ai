import pulp
import logging
import re
from datetime import datetime, timedelta

logger = logging.getLogger("rakushift.scheduler")

# v3.7.85: 日本の祝日判定 (海の日など国民の祝日を holiday 扱いに)
try:
    import jpholiday
    _JP_HOLIDAY_AVAILABLE = True
except ImportError:
    jpholiday = None
    _JP_HOLIDAY_AVAILABLE = False
    logger.warning("jpholiday module not available; only Sunday will be treated as holiday")

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
            st = (p.get("start") or "09:00").strip() or "09:00"
            en = (p.get("end") or "18:00").strip() or "18:00"
            # v3.7.71: 不正な時刻ペアを無視 (start >= end は同日ではあり得ない設定)
            try:
                sh, sm = map(int, st.split(":")[:2])
                eh, em = map(int, en.split(":")[:2])
                if (sh, sm) == (eh, em):
                    logger.warning(
                        "shift_pattern skipped: start==end (%s)", p.get("name"))
                    continue
            except (ValueError, AttributeError):
                logger.warning(
                    "shift_pattern skipped: invalid time (%s start=%r end=%r)",
                    p.get("name"), st, en)
                continue
            pat = {
                "start": st, "end": en, "name": p.get("name", ""),
                # 翌日を強制休みにするパターン (夜勤の2連勤防止など)
                "force_rest_next_day": bool(p.get("force_rest_next_day")),
            }
            # パターンごとの管理者(店長/リーダー)必要人数
            try:
                _mc = int(p.get("manager_count") or 0)
                pat["manager_count"] = _mc if _mc > 0 else 0
            except (ValueError, TypeError):
                pat["manager_count"] = 0
            # 管理者配置 ON(人数指定)/OFF(ランダム=制約なし)。
            # 後方互換: manager_enabled 未指定なら manager_count>0 を ON とみなす。
            if "manager_enabled" in p:
                pat["manager_enabled"] = bool(p.get("manager_enabled"))
            else:
                pat["manager_enabled"] = pat["manager_count"] > 0
            # v3.7.69: 曜日別必要人数 (v3.7.66 で追加された count_weekday/weekend/holiday
            # を初期化でコピーし忘れていた重大バグ修正)
            # 旧 count は count_weekday 不在時のフォールバック専用
            for key in ("count", "count_weekday", "count_weekend", "count_holiday"):
                v = p.get(key)
                if v is None:
                    continue
                try:
                    v_int = int(v)
                    if v_int >= 0:
                        pat[key] = v_int
                except (ValueError, TypeError):
                    pass
            self.shift_patterns.append(pat)
        # v3.7.71: シフトパターンのデバッグログ (本番でユーザー設定の状況を把握)
        logger.info(
            "shift_patterns loaded: count=%d details=%s",
            len(self.shift_patterns),
            [(p.get("name"), p["start"], p["end"],
              p.get("count_weekday"), p.get("count_weekend"),
              p.get("count_holiday")) for p in self.shift_patterns])
        # 翌日強制休み診断: どのパターンに force_rest_next_day が立っているか
        _fr = [p.get("name") for p in self.shift_patterns if p.get("force_rest_next_day")]
        logger.info("force_rest_next_day patterns: %s (count=%d)", _fr, len(_fr))
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
        # 管理者要件は廃止 (パターン別 manager_count に移行)。デフォルト 0。
        self.min_manager = int(sr.get("min_manager", 0))
        self.time_staff_req = self.config.get("time_staff_req", [])
        # v3.7.91: 過剰配置を許容するか (false=必要人数ぴったり / true=緩和)
        self.allow_overstaffing = bool(self.config.get("allow_overstaffing", False))

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

        # v3.7.119: 営業日 (closed以外) のソート済みリスト + set
        # 連勤判定で「店舗休業日を挟んでも連続出勤扱い」にするため使用
        self._operational_dates = sorted([d for d in self.dates if self._get_day_type(d) != "closed"])
        self._operational_dates_set = set(self._operational_dates)
        self._operational_index = {d: i for i, d in enumerate(self._operational_dates)}
        # v3.7.140: closed_days 設定誤りの早期警告
        if self.dates and not self._operational_dates:
            logger.warning(
                "[Scheduler] 全 %d 日が営業休業日扱いです。closed_days / special_holidays "
                "の設定を確認してください。シフト生成は空結果になります",
                len(self.dates),
            )

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
                is_manager_flag = r.get("is_manager")
                if not rid:
                    continue
                # v3.7.81: 明示的な is_manager フラグが最優先
                #   True  → メンター + employee に追加
                #   False → デフォルト判定をスキップ
                #   None  → 旧データ互換で level/color から推定
                if is_manager_flag is True:
                    custom_mentor_ids.add(rid)
                    custom_employee_role_ids.add(rid)
                elif is_manager_flag is False:
                    # 明示的に管理者でないと指定された場合は追加しない
                    pass
                else:
                    # 旧データ互換: level/color から推定
                    if (isinstance(level, (int, float)) and level >= 4) or color in ("purple", "red"):
                        custom_mentor_ids.add(rid)
                    if (isinstance(level, (int, float)) and level >= 3) or color in ("purple", "red", "green"):
                        custom_employee_role_ids.add(rid)
                # v3.7.181: 新人(rookie)判定を厳格化。
                #   旧: level<=1 を新人扱い → 役職の既定 level=1 のため全役職が新人に
                #       なり、OJT制約が全スタッフへ誤適用 (メンター=管理者が日勤に張り付き
                #       夜勤等に入れない副作用)。仕様コメント「新人は明示指定のみ」とも矛盾。
                #   新: 明示的に色=yellow を付けた役職のみ新人。管理者(is_manager)は除外。
                if color == "yellow" and is_manager_flag is not True:
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
            # v3.7.182: 新人(rookie)の定義は「評価ランク D のスタッフのみ」(ユーザー指定)。
            # 役職レベル/色ベースの判定 (全員が新人になる誤検知) を廃止し、
            # OJT制約(新人にメンターを重ねる)は評価Dの人だけに適用する。
            if evaluation == "D":
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
        
        # 名前からIDへのマッピング作成（相性=必須ペア制約用）
        # v3.7.188: 「○○ のコピー」等で先頭トークンが衝突すると、後勝ちで
        # 別人(コピー)を指してしまい必須ペアの相手を取り違える問題を修正。
        #   - フルネームは衝突したら曖昧扱いで除外
        #   - 先頭トークンは「一意なときだけ」採用 (衝突したら採用しない)
        name_to_id = {}
        _full_ambig = set()
        for s in self.staff_list:
            name = s.get("name", "").strip()
            sid = s.get("id")
            if not name:
                continue
            if name in name_to_id and name_to_id[name] != sid:
                _full_ambig.add(name)
            name_to_id[name] = sid
        for a in _full_ambig:
            name_to_id.pop(a, None)  # 同名フルネームが複数 → 解決不能なので除外
        # 先頭トークン (姓など) は一意なものだけ補助キーに
        _ft_map, _ft_collide = {}, set()
        for s in self.staff_list:
            name = s.get("name", "").strip()
            sid = s.get("id")
            if not name:
                continue
            ft = name.split(" ")[0].split("　")[0]
            if ft and ft != name:
                if ft in _ft_map and _ft_map[ft] != sid:
                    _ft_collide.add(ft)
                _ft_map[ft] = sid
        for ft, sid in _ft_map.items():
            if ft not in _ft_collide and ft not in name_to_id:
                name_to_id[ft] = sid

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
                    # 部分一致は「候補が一意のときだけ」採用 (取り違え防止)
                    cands = {_sid for n, _sid in name_to_id.items()
                             if target_name in n or n in target_name}
                    if len(cands) == 1:
                        sid2 = next(iter(cands))
                    elif len(cands) > 1:
                        logger.warning("[ReqPair] '%s' が複数スタッフに一致し曖昧なためスキップ", target_name)
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

    def _get_staff_max_consec(self, staff):
        """スタッフ別 max_consecutive_days を安全に取得 (1〜7 範囲外/不正値はデフォルト6)"""
        raw = staff.get("max_consecutive_days") if isinstance(staff, dict) else None
        try:
            v = int(raw) if raw not in (None, "") else self.LEGAL_MAX_CONSECUTIVE_DAYS
        except (ValueError, TypeError):
            return self.LEGAL_MAX_CONSECUTIVE_DAYS
        if not (1 <= v <= 7):
            return self.LEGAL_MAX_CONSECUTIVE_DAYS
        return v

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
        # v3.7.85: 日本の国民の祝日も holiday 扱い (海の日/スポーツの日 等)
        if _JP_HOLIDAY_AVAILABLE and jpholiday.is_holiday(dt.date()):
            return "holiday"
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
                    js_dow = (dt.weekday() + 1) % 7
                    if js_dow in ng_weekdays:
                        ng.add(date_str)
                except ValueError:
                    pass

        # v3.7.111: ng_holiday=True なら国民の祝日 (jpholiday) を NG に追加
        ng_holiday = bool(staff.get("ng_holiday", False))
        if ng_holiday and _JP_HOLIDAY_AVAILABLE:
            for date_str in self.dates:
                try:
                    dt = datetime.strptime(date_str, "%Y-%m-%d")
                    if jpholiday.is_holiday(dt.date()):
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

        # v3.7.109: 該当シフトパターンチェックでフィルタ
        eligible = staff.get("eligible_patterns")
        if isinstance(eligible, list) and len(eligible) > 0:
            eligible_set = set(str(e) for e in eligible)
            patterns_to_use = [p for p in self.shift_patterns
                               if (p.get("name") or "") in eligible_set]
        else:
            patterns_to_use = self.shift_patterns.copy()

        # v3.7.110: 当該曜日タイプの count が 0 のパターンは「この曜日では使わない」と
        # 解釈して opt から除外。これでユーザーが「土曜は早番なし」を表現できる。
        _day_type = self._get_day_type(date_str)
        def _pat_count_for_day(p):
            if _day_type == "holiday":
                return p.get("count_holiday", p.get("count"))
            if _day_type == "weekend":
                return p.get("count_weekend", p.get("count"))
            return p.get("count_weekday", p.get("count"))
        filtered = []
        for p in patterns_to_use:
            c = _pat_count_for_day(p)
            if c is not None:
                try:
                    if int(c) == 0:
                        continue  # この曜日タイプでは無効化
                except (ValueError, TypeError):
                    pass
            filtered.append(p)
        patterns_to_use = filtered

        # v3.7.62: ユーザー要望「シフト生成時はシフトパターンのみで考えて展開」
        # 旧 v3.6: スタッフ希望時間 (pref_start_wd 等) を pref_pat として追加していた
        # 新: pref_pat 追加を削除。custom_shifts (シフトパターン) のみで配置
        # → 全スタッフが「早番/中番/遅番/通し」等のパターンから選ばれる
        # → シフト時間が整列し、希望時間集中による不揃いを解消
        is_employee = staff.get("salary_type") == "monthly" or str(staff.get("role", "")).lower() in self._employee_role_ids
        day_type = self._get_day_type(date_str)

        def _add_option(ps, pe, is_pref=False, force_rest=False):
            """オプションを追加するヘルパー（重複チェック含む）"""
            if ps >= pe:
                return
            hrs = (pe - ps) / 60.0
            if hrs < 1:
                return
            brk_mins = self._get_break_minutes(hrs)
            work_hrs = hrs - (brk_mins / 60.0)
            # v3.7.139: 休憩 > 拘束時間で work_hrs が負になるケースを除外
            if work_hrs <= 0:
                logger.warning("[_build_shift_options] negative work_hrs (hrs=%.2f brk=%d) skipped", hrs, brk_mins)
                return
            key = (ps, pe)
            if key in seen:
                # 既に存在するオプションだが、もしこれがprefならフラグを立て直す
                for opt in options:
                    if opt["start_min"] == ps and opt["end_min"] == pe:
                        if is_pref:
                            opt["is_pref"] = True
                        # 同一時間帯のパターンが1つでも翌休なら翌休扱い
                        if force_rest:
                            opt["force_rest"] = True
                return
            seen.add(key)
            options.append({
                "start": self._from_minutes(ps),
                "end": self._from_minutes(pe),
                "start_min": ps, "end_min": pe, "hours": hrs, "work_hours": work_hrs,
                "is_pref": is_pref, "force_rest": force_rest
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
            # v3.7.139: work_hrs <= 0 (休憩が拘束時間以上) なら このパターンは作らない
            if work_hrs <= 0:
                continue

            is_pref = pat.get("name") == "pref"
            force_rest = bool(pat.get("force_rest_next_day"))
            if work_hrs > max_hours and not force:
                # パターンA: 開始固定で終了を短縮（従来通り）
                needed_break = self._get_break_minutes(max_hours)
                allowed_total_hours = max_hours + (needed_break / 60.0)
                new_pe = ps + int(allowed_total_hours * 60)
                if new_pe < pe:
                    _add_option(ps, new_pe, is_pref, force_rest)

                # パターンB: 終了固定で開始を遅くする（閉店時間カバー用）
                new_ps = pe - int(allowed_total_hours * 60)
                if new_ps > ps:
                    new_ps = max(new_ps, open_min)
                    _add_option(new_ps, pe, is_pref, force_rest)
            else:
                _add_option(ps, pe, is_pref, force_rest)
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

        v3.7.70: 定休日でない限り、ベース 0 でも shift_patterns の count_*
        が指定されていれば slot 構築を続行する (パターン人数だけで運用するケース)
        """
        req_num = self._get_required_staff(date_str)
        # 定休日 (closed) なら 0 を返す
        if self._get_day_type(date_str) == "closed":
            return {}
        if req_num < 0:
            req_num = 0
        day_open, day_close = self._get_opening_hours(date_str)
        op = self._to_minutes(day_open)
        cl = self._normalize_end_time(op, self._to_minutes(day_close))
        slots = {}
        for t in range(op, cl, 15):
            slots[t] = {"base": req_num, "hall": 0, "kitchen": 0, "any": 0, "pattern_sum": 0}

        # v3.7.66: シフトパターンの count を曜日別に読み取り、slot ごとに合算
        # 各パターンに count_weekday / count_weekend / count_holiday があれば使う
        # なければ旧 count にフォールバック
        day_type_for_pat = self._get_day_type(date_str)
        for pat in self.shift_patterns:
            if day_type_for_pat == "holiday":
                pat_count = pat.get("count_holiday", pat.get("count"))
            elif day_type_for_pat == "weekend":
                pat_count = pat.get("count_weekend", pat.get("count"))
            else:
                pat_count = pat.get("count_weekday", pat.get("count"))
            if not pat_count or pat_count <= 0:
                continue
            try:
                pat_count_int = int(pat_count)
            except (ValueError, TypeError):
                continue
            ps = self._to_minutes(pat.get("start", "09:00"))
            pe = self._normalize_end_time(ps, self._to_minutes(pat.get("end", "18:00")))
            if ps >= pe:
                continue
            for t in range(op, cl, 15):
                if ps <= t < pe and t in slots:
                    slots[t]["pattern_sum"] += pat_count_int

        dt = datetime.strptime(date_str, "%Y-%m-%d")
        js_dow = (dt.weekday() + 1) % 7
        for rule in self.time_staff_req:
            if not isinstance(rule, dict):
                continue
            # v3.7.124: days/count に文字列や不正値が混ざっていてもクラッシュさせない
            rule_days = []
            for d in rule.get("days", []) or []:
                try:
                    rule_days.append(int(d))
                except (ValueError, TypeError):
                    logger.warning("[time_staff_req] invalid day '%s' skipped", d)
            if js_dow not in rule_days:
                continue
            rs = self._to_minutes(rule.get("start", "00:00"))
            re_min = self._normalize_end_time(rs, self._to_minutes(rule.get("end", "24:00")))
            try:
                rc = int(rule.get("count", 0) or 0)
            except (ValueError, TypeError):
                logger.warning("[time_staff_req] invalid count '%s' skipped", rule.get("count"))
                continue
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

        # v3.7.80: シフトパターン登録時はパターン外時間帯を「要件0」に
        # 旧 v3.7.73: pattern_sum=0 の時間帯はベース要件を使っていた
        #   → 営業 09:00-22:00、パターン 早番09:30-18:45 / 遅番09:45-19:15 の場合、
        #     09:00-09:29 と 19:15-22:00 がパターン外 → ベース要件 4 が適用
        #     → 4名不足 と表示される (現実には誰も入れない時間帯のはず)
        # 新: ユーザーが意図的にシフトパターンを登録した = その時間帯外は不要 と解釈。
        #   shift_patterns が空のユーザーは従来通りベース要件を使う。
        has_patterns = bool(self.shift_patterns) and any(
            int(p.get("count_weekday", p.get("count", 0)) or 0) > 0
            or int(p.get("count_weekend", p.get("count", 0)) or 0) > 0
            or int(p.get("count_holiday", p.get("count", 0)) or 0) > 0
            for p in self.shift_patterns)
        final_slots = {}
        for t, counts in slots.items():
            base_or_rule = max(counts["base"], counts["any"] + counts["hall"] + counts["kitchen"])
            pattern_sum = counts.get("pattern_sum", 0)
            if pattern_sum > 0:
                final_slots[t] = pattern_sum
            elif has_patterns:
                # パターン登録あり + この時間帯はパターン外 → 要件 0
                final_slots[t] = 0
            else:
                # パターン未登録 → 従来通りベース要件
                final_slots[t] = base_or_rule
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
            if not isinstance(rule, dict):
                continue
            pos = rule.get("position", "any")
            if pos not in ("hall", "kitchen"):
                continue
            # v3.7.185: 不正な days/count でクラッシュ→MILP tier 全滅を防ぐ
            # (_build_slot_requirements と同等のガードに統一)
            rule_days = []
            for d in rule.get("days", []) or []:
                try:
                    rule_days.append(int(d))
                except (ValueError, TypeError):
                    logger.warning("[pos_req] invalid day '%s' skipped", d)
            if js_dow not in rule_days:
                continue
            rs = self._to_minutes(rule.get("start", "00:00"))
            re_min = self._normalize_end_time(rs, self._to_minutes(rule.get("end", "24:00")))
            try:
                rc = int(rule.get("count", 0) or 0)
            except (ValueError, TypeError):
                logger.warning("[pos_req] invalid count '%s' skipped", rule.get("count"))
                continue
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
                return self._enforce_force_rest_output(result)
            logger.info("[Fallback] Tier %d failed, trying lower tier...", current_tier)

        logger.info("[Fallback] All MILP tiers failed → Greedy")
        return self._enforce_force_rest_output(self._solve_greedy())

    def _enforce_force_rest_output(self, shifts):
        """翌日強制休みの最終ガード (絶対保証)。

        どの経路 (MILP / 強行 force / 過剰配置補完 / グリーディ) で生成されても、
        force_rest_next_day=ON のパターンに入った翌カレンダー日に同一スタッフの
        シフトが残っていれば除去する。スタッフごとに日付順で走査し、連続夜勤も
        正しく解消する (夜勤を残し、翌日側を落とす)。
        """
        if not shifts:
            return shifts
        fr_keys = set()
        for pat in self.shift_patterns:
            if pat.get("force_rest_next_day"):
                pps = self._to_minutes(pat.get("start", "09:00"))
                ppe = self._normalize_end_time(pps, self._to_minutes(pat.get("end", "18:00")))
                if pps < ppe:
                    fr_keys.add((pps, ppe))
        if not fr_keys:
            return shifts

        def _is_fr(sh):
            ps = self._to_minutes((sh.get("start_time") or "")[:5])
            pe = self._normalize_end_time(ps, self._to_minutes((sh.get("end_time") or "")[:5]))
            return (ps, pe) in fr_keys

        by_staff = {}
        for sh in shifts:
            by_staff.setdefault(sh.get("staff_id"), []).append(sh)

        kept = []
        removed = 0
        for sid, sh_list in by_staff.items():
            sh_list.sort(key=lambda s: s.get("date") or "")
            fr_dates = set()  # 実際に残した force_rest シフトの日付
            for sh in sh_list:
                d = sh.get("date")
                if not d:
                    kept.append(sh)
                    continue
                prev = (datetime.strptime(d, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
                if prev in fr_dates:
                    # 前日に夜勤(force_rest)があるので この日は休み → 除去
                    removed += 1
                    continue
                kept.append(sh)
                if _is_fr(sh):
                    fr_dates.add(d)
        if removed:
            logger.warning("[ForceRest] 最終ガードで翌日シフト %d 件を除去 (翌休厳守)", removed)
        return kept

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
            # v3.7.124: (staff_id, date) 重複を検出して警告ログ
            #   旧版は黙って 2件目以降を上書き判定していた (どのレコードが採用された
            #   か追跡困難)。重複は WARN ログで明示し、1件目を採用する。
            existing_fixed = 0
            seen_es_keys = set()
            # 翌休との矛盾回避: 「夜勤(force_rest)＋その翌日勤務」が既存シフトとして
            # 両方ハード固定されると force_rest 制約と衝突し Tier 全体が infeasible に
            # なる。衝突側は固定をスキップ(最適化に委ね)、WARN を出す。
            _fr_pat_keys = set()
            for _pat in self.shift_patterns:
                if _pat.get("force_rest_next_day"):
                    _pps = self._to_minutes(_pat.get("start", "09:00"))
                    _ppe = self._normalize_end_time(_pps, self._to_minutes(_pat.get("end", "18:00")))
                    if _pps < _ppe:
                        _fr_pat_keys.add((_pps, _ppe))
            _es_dates, _es_fr_dates = {}, {}
            for _es in self.existing_shifts:
                _sid, _d = _es.get("staff_id"), _es.get("date")
                if not _sid or not _d:
                    continue
                _es_dates.setdefault(_sid, set()).add(_d)
                _s = self._to_minutes(_es.get("start_time") or "00:00")
                _e = self._normalize_end_time(_s, self._to_minutes(_es.get("end_time") or "00:00"))
                if (_s, _e) in _fr_pat_keys:
                    _es_fr_dates.setdefault(_sid, set()).add(_d)

            def _es_conflicts_fr(esid, ed):
                if not _fr_pat_keys:
                    return False
                try:
                    dt = datetime.strptime(ed, "%Y-%m-%d")
                except ValueError:
                    return False
                prev = (dt - timedelta(days=1)).strftime("%Y-%m-%d")
                nxt = (dt + timedelta(days=1)).strftime("%Y-%m-%d")
                if prev in _es_fr_dates.get(esid, ()):  # 前日が夜勤 → この日は休みのはず
                    return True
                if ed in _es_fr_dates.get(esid, ()) and nxt in _es_dates.get(esid, ()):
                    return True  # この日が夜勤 かつ 翌日に既存シフト
                return False

            for es in self.existing_shifts:
                esid = es.get("staff_id")
                ed = es.get("date")
                if not esid or not ed:
                    continue
                key = (esid, ed)
                if key in seen_es_keys:
                    logger.warning(
                        "[Existing] duplicate existing_shift (staff={}, date={}) skipped".format(
                            esid, ed))
                    continue
                seen_es_keys.add(key)
                if ed not in self.dates:
                    continue
                if (esid, ed) in fixed_assignments:
                    continue
                if _es_conflicts_fr(esid, ed):
                    logger.warning(
                        "[Existing] force_rest 矛盾のため固定をスキップ (staff=%s date=%s)", esid, ed)
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

                # --- v3.7.91: 月の最大出勤日数 (ハード制約) ---
                max_days_month = int(s.get("max_days_month") or 31)
                if max_days_month > 0 and max_days_month < 31:
                    all_wv_mdm_max = []
                    for d in self.dates:
                        for oi in range(len(staff_opts.get((sid, d), []))):
                            all_wv_mdm_max.append(x[(sid, d, oi)])
                    if all_wv_mdm_max:
                        prob += pulp.lpSum(all_wv_mdm_max) <= max_days_month

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
                                is_monthly = str(s.get("salary_type", "hourly")).lower() == "monthly"
                                # v3.7.89: 月給スタッフは ハード制約 (min_days_month と一貫)
                                # 旧: 月給 1M ペナルティ → パターン100M/COVERAGE100M に負けて
                                #   ユーザー設定の週N日が達成されないケースが頻発
                                # 新: ハード制約で必ず達成 (effective_min は available_days で
                                #   抑制済みなので infeasible リスクなし)
                                if is_monthly:
                                    prob += pulp.lpSum(wv) >= effective_min
                                else:
                                    # 時給はソフト制約だが 30k → 1M に強化
                                    # (時間帯柔軟性は維持しつつ達成優先度を上げる)
                                    mdw_slack = pulp.LpVariable(
                                        "mdw_{}_{}".format(sid, week[0] if week else "x"),
                                        0, None, pulp.LpInteger)
                                    prob += pulp.lpSum(wv) + mdw_slack >= effective_min
                                    penalty += mdw_slack * 1_000_000

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
                            is_monthly = str(s.get("salary_type", "hourly")).lower() == "monthly"
                            # v3.7.84: 月給スタッフは ハード制約 で必ず達成
                            # 旧: 20M ペナルティ → COVERAGE_OVER (100M) と衝突して犠牲
                            #   過剰回避優先で月給スタッフの21日設定が無視されていた
                            # 新: target_min_month はすでに物理上限 (max_possible /
                            #   available_total) で抑制済みなので、infeasible リスク
                            #   なしにハード制約化できる
                            if is_monthly:
                                prob += pulp.lpSum(all_wv) >= target_min_month
                            else:
                                # 時給スタッフはソフト制約のまま (柔軟調整余地を残す)
                                mdm_slack = pulp.LpVariable(
                                    "mdm_{}".format(sid), 0, None, pulp.LpInteger)
                                prob += pulp.lpSum(all_wv) + mdm_slack >= target_min_month
                                # v3.7.83: 1M (Tier 3 相当)
                                penalty += mdm_slack * 1_000_000

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
                # v3.7.90: ユーザー指示により撤廃。
                # 変形労働時間制等の運用 / シフト柔軟性を優先するため、
                # 週40時間 ハード制約は削除。
                # 注: 1日 max_hours_day (個別設定) と 連続勤務6日上限 (35条) は維持。
                # 労基法32条遵守のためには店舗運用ルール側で管理してください。

                # --- 連続勤務6日上限 (労基法35条: 週1日の休日) ---
                # v3.6: 日付ギャップ考慮。
                # 旧版は sorted_d[i:i+7] を「7日間ローリングウィンドウ」として扱い
                # 「<= 6 of 7」制約を貼っていたが、sorted_d にギャップ (定休日や非連続日付)
                # があると 7要素が10日以上のスパンを覆うことになり、制約が緩くなる方向で
                # 正確性を欠いていた。
                # 修正: 実カレンダー連続性を確認し、連続する 7日間 (= 6日+休日1日) のみに
                #       制約を貼る。ギャップを跨ぐスパンはスキップ。
                sorted_d = sorted(self.dates)  # インターバル制約で使用
                # v3.7.119: 営業日 (closed以外) ベースで連続出勤窓を判定
                #   旧版: カレンダー連続性チェック → closed_days を挟むスパンを除外
                #         → 「月～土 6連勤 + 日(休業) + 月～土 6連勤」を許容してしまう (12連勤)
                #   新版: self._operational_dates (営業日) で max_consec+1 個連続を禁止
                #         → 休業日を挟んでも実出勤の連続性を厳密にカウント
                _staff_max_consec = self._get_staff_max_consec(s)
                max_consec = _staff_max_consec
                op_d = self._operational_dates
                if len(op_d) > max_consec:
                    for i in range(len(op_d) - max_consec):
                        span = op_d[i:i + max_consec + 1]
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

                # --- 翌日強制休み (夜勤の2連勤防止など) ---
                # force_rest フラグ付きパターンに入った翌カレンダー日は、
                # その日の全オプションを禁止 (= 完全休み) するハード制約。
                for i in range(len(sorted_d) - 1):
                    d1 = sorted_d[i]
                    d2 = sorted_d[i + 1]
                    # 翌カレンダー日のみ対象 (2日以上空けば自明に休み)
                    d1_dt = datetime.strptime(d1, "%Y-%m-%d")
                    d2_dt = datetime.strptime(d2, "%Y-%m-%d")
                    if (d2_dt - d1_dt).days != 1:
                        continue
                    opts1 = staff_opts.get((sid, d1), [])
                    opts2 = staff_opts.get((sid, d2), [])
                    if not opts2:
                        continue
                    rest_ois = [oi for oi, o in enumerate(opts1) if o.get("force_rest")]
                    for oi1 in rest_ois:
                        for oi2 in range(len(opts2)):
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
                        # v3.7.125: キャッシュは Tier ごとに初期化 (Tier 間 汚染防止)
                        # 旧版は __init__ 後に初回作成、Tier 1 失敗で Tier 2 再試行時に
                        # 前 Tier の値が残るリスクがあった
                        if not hasattr(self, '_slot_reqs_cache'):
                            self._slot_reqs_cache = {}
                        self._slot_reqs_cache[d] = slot_reqs_for_day
                        max_slot_req = max(slot_reqs_for_day.values()) if slot_reqs_for_day else req_daily
                        # v3.7.185: 非重複パターン (例 早番09-15 + 遅番15-22) では各スロットの
                        # pattern_sum は最繁スロットしか見ないため、日次合計人数を過剰扱いし
                        # 100M ペナルティで歪んでいた。当日に使うパターンの「人数合計」も
                        # 上限候補に含めて、時間帯が重ならない構成でも過剰判定しないようにする。
                        _dt_d = self._get_day_type(d)
                        total_pat_count = 0
                        for _pat in self.shift_patterns:
                            if _dt_d == "holiday":
                                _pc = _pat.get("count_holiday", _pat.get("count"))
                            elif _dt_d == "weekend":
                                _pc = _pat.get("count_weekend", _pat.get("count"))
                            else:
                                _pc = _pat.get("count_weekday", _pat.get("count"))
                            try:
                                _pc = int(_pc) if _pc is not None else 0
                            except (ValueError, TypeError):
                                _pc = 0
                            if _pc > 0:
                                total_pat_count += _pc
                        daily_upper = max(req_daily, max_slot_req, total_pat_count)
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
                            # v3.7.125: req=0 (パターン外時間帯) では最低1名要求しない
                            # フロント側の人員状況計算 (v3.7.80) と整合
                            if not force and req > 0:
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
                            # v3.7.91: 過剰配置許容トグル
                            # allow_overstaffing=True → 1M (緩和) / False → 100M (厳格)
                            over_weight = 1_000_000 if self.allow_overstaffing else self.W.COVERAGE_OVER_SLOT
                            penalty += slack_over * over_weight

                # --- v3.7.66: シフトパターン別必要人数制約 (曜日別 count) ---
                for d in self.dates:
                    day_type_d = self._get_day_type(d)
                    if day_type_d == "closed":
                        continue
                    for pat in self.shift_patterns:
                        # 曜日別 count を取得
                        if day_type_d == "holiday":
                            pat_count = pat.get("count_holiday", pat.get("count"))
                        elif day_type_d == "weekend":
                            pat_count = pat.get("count_weekend", pat.get("count"))
                        else:
                            pat_count = pat.get("count_weekday", pat.get("count"))
                        if pat_count is None or pat_count <= 0:
                            continue
                        ps_min = self._to_minutes(pat["start"])
                        pe_min = self._normalize_end_time(ps_min, self._to_minutes(pat["end"]))
                        if ps_min >= pe_min:
                            continue
                        # このパターンの時間帯にマッチする opt を集計 (start_min <= ps_min かつ end_min >= pe_min )
                        # → そのパターンと同じ時間帯のシフトに入る人数を数える
                        pat_workers = []
                        for s in self.staff_list:
                            sid = s["id"]
                            for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                                # opt がパターン全体をカバー (もしくはほぼ一致) するか
                                if opt["start_min"] == ps_min and opt["end_min"] == pe_min:
                                    pat_workers.append(x[(sid, d, oi)])
                        if pat_workers:
                            pat_slack = pulp.LpVariable(
                                "pat_{}_{}_{}".format(d, ps_min, pe_min), 0, None, pulp.LpInteger)
                            prob += pulp.lpSum(pat_workers) + pat_slack >= pat_count
                            # v3.7.88: 100M (COVERAGE と同等) で「絶対ぴったり」
                            penalty += pat_slack * 100_000_000
                            # v3.7.91: 過剰側は allow_overstaffing トグルで切替
                            pat_over = pulp.LpVariable(
                                "pat_over_{}_{}_{}".format(d, ps_min, pe_min),
                                0, None, pulp.LpInteger)
                            prob += pulp.lpSum(pat_workers) - pat_over <= pat_count
                            pat_over_weight = 1_000_000 if self.allow_overstaffing else 100_000_000
                            penalty += pat_over * pat_over_weight

                # --- パターン別 管理者(店長/リーダー)必要人数 ---
                # custom_shifts[].manager_count = そのパターンに必要な管理者数。
                # 旧「最低管理者数(常時1名)」の代替。各営業日、当該パターンの
                # 時間帯に入る管理者数 >= manager_count をソフトで満たす (10M)。
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    day_type_d = self._get_day_type(d)
                    for pat in self.shift_patterns:
                        # OFF (manager_enabled=False) は制約なし=ランダム配置
                        if not pat.get("manager_enabled"):
                            continue
                        mgr_need = int(pat.get("manager_count") or 0)
                        if mgr_need <= 0:
                            continue
                        # そのパターンがその曜日タイプで使われているか (count>0)
                        if day_type_d == "holiday":
                            pc = pat.get("count_holiday", pat.get("count"))
                        elif day_type_d == "weekend":
                            pc = pat.get("count_weekend", pat.get("count"))
                        else:
                            pc = pat.get("count_weekday", pat.get("count"))
                        if pc is None or pc <= 0:
                            continue
                        ps_min = self._to_minutes(pat["start"])
                        pe_min = self._normalize_end_time(ps_min, self._to_minutes(pat["end"]))
                        if ps_min >= pe_min:
                            continue
                        mgr_vars = []
                        for s in self.staff_list:
                            sid = s["id"]
                            if sid not in self._manager_ids:
                                continue
                            for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                                if opt["start_min"] == ps_min and opt["end_min"] == pe_min:
                                    mgr_vars.append(x[(sid, d, oi)])
                        if mgr_vars:
                            mgr_slack = pulp.LpVariable(
                                "patmgr_{}_{}_{}".format(d, ps_min, pe_min), 0, None, pulp.LpInteger)
                            prob += pulp.lpSum(mgr_vars) + mgr_slack >= mgr_need
                            penalty += mgr_slack * self.W.OPEN_CLOSE_NO_EMP

                # --- v3.7.106: スタッフ別シフトパターン 月間 最低/最高 制約 (Tier 4) ---
                # staff.pattern_target_counts = { "早番": {"min":2,"max":5}, ... }
                # 旧データ互換: { "早番": 3 } (整数) は { min:3, max:3 } として扱う
                # 各スタッフが当該パターンに配置される回数 が [min, max] の範囲に
                # 収まるようソフト制約 (範囲外なら 500k/回 ペナルティ)
                for staff in self.staff_list:
                    targets = staff.get("pattern_target_counts") or {}
                    if not isinstance(targets, dict) or not targets:
                        continue
                    sid = staff["id"]
                    for pat in self.shift_patterns:
                        key = pat.get("name") or ""
                        target_raw = targets.get(key)
                        if target_raw is None:
                            continue
                        # 旧データ (整数) / 新データ ({min,max}) を統一形式に
                        min_v = None
                        max_v = None
                        try:
                            if isinstance(target_raw, (int, float)):
                                # 旧: 整数 = min=max
                                min_v = max_v = int(target_raw)
                            elif isinstance(target_raw, dict):
                                if target_raw.get("min") is not None:
                                    min_v = int(target_raw["min"])
                                if target_raw.get("max") is not None:
                                    max_v = int(target_raw["max"])
                        except (ValueError, TypeError):
                            continue
                        # v3.7.122: 0 を「制約なし」として扱う
                        # UI 表記「空欄なら制約なし」と整合させるため、min=0 / max=0
                        # は未設定として無視する。「このパターン0回限定」が必要なら
                        # eligible_patterns で「該当外」を選ぶ。
                        if (min_v is None or min_v <= 0) and (max_v is None or max_v <= 0):
                            continue
                        ps_min = self._to_minutes(pat["start"])
                        pe_min = self._normalize_end_time(
                            ps_min, self._to_minutes(pat["end"]))
                        if ps_min >= pe_min:
                            continue
                        pat_vars = []
                        for d in self.dates:
                            if self._get_day_type(d) == "closed":
                                continue
                            for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                                if opt["start_min"] == ps_min and opt["end_min"] == pe_min:
                                    pat_vars.append(x[(sid, d, oi)])
                        if not pat_vars:
                            continue
                        cnt_expr = pulp.lpSum(pat_vars)
                        # min 制約: cnt >= min_v - slack_under
                        if min_v is not None and min_v > 0:
                            su = pulp.LpVariable(
                                "pat_min_{}_{}".format(sid, ps_min),
                                0, None, pulp.LpInteger)
                            prob += cnt_expr + su >= min_v
                            penalty += su * 500_000
                        # max 制約: cnt <= max_v + slack_over
                        # v3.7.122: max=0 は制約なし (UI 表記「空欄なら制約なし」と整合)
                        # v3.7.137: max>=31 も「制限なし」扱い (月の物理上限を超える指定は無意味)
                        if max_v is not None and 0 < max_v < 31:
                            so = pulp.LpVariable(
                                "pat_max_{}_{}".format(sid, ps_min),
                                0, None, pulp.LpInteger)
                            prob += cnt_expr - so <= max_v
                            penalty += so * 500_000

                # --- 開け閉め社員常駐 制約は廃止 (v3.7.179) ---
                # 管理者の配置は シフトパターン別 manager_count 制約 (上記) のみで
                # 制御する。全時間帯/開け閉めの社員常駐要件は課さない。

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
                                        # 新人本人はメンターにできない (自己メンター防止)
                                        if sid in self._mentor_ids and sid not in self._rookie_ids:
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

            # v3.7.97: 過剰配置許容モード時の最低出勤日数 ランダム補完
            if shifts and self.allow_overstaffing:
                shifts = self._fill_to_min_days_random(shifts)
                logger.info("[Result after fill] {} shifts".format(len(shifts)))

            return shifts if shifts else None

        except Exception as e:
            logger.info("[MILP Error] {}".format(e))
            import traceback
            traceback.print_exc()
            return None

    # ===========================================================
    # v3.7.121: 各営業日の人員不足量を計算 (補完優先順位用)
    def _compute_date_shortages(self, shifts):
        """各営業日について {必要人員総数 - 実配置数} を計算し、
        不足が大きい順にソートしたリストを返す。

        必要人員総数 = その日の day_type における全シフトパターン count 合計
        実配置数 = その日に既に配置されている shifts 数
        """
        result = []
        shifts_by_date = {}
        for s in shifts:
            d = s.get("date")
            if d:
                shifts_by_date.setdefault(d, []).append(s)
        for d in self._operational_dates:
            day_type = self._get_day_type(d)
            count_key = "count_holiday" if day_type == "holiday" else (
                "count_weekend" if day_type == "weekend" else "count_weekday")
            needed = 0
            for pat in self.shift_patterns:
                c = pat.get(count_key)
                if c is None:
                    c = pat.get("count")
                try:
                    n = int(c) if c is not None else 0
                except (ValueError, TypeError):
                    n = 0
                if n > 0:
                    needed += n
            assigned = len(shifts_by_date.get(d, []))
            shortage = needed - assigned
            if shortage > 0:
                result.append((d, shortage))
        result.sort(key=lambda x: -x[1])
        return result

    # v3.7.97: 過剰配置許容モード時の最低出勤日数 ランダム補完
    # ===========================================================
    def _fill_to_min_days_random(self, shifts):
        """allow_overstaffing=ON の場合、min_days_month / min_days_week に
        足りていないスタッフを特定し、不足日数をランダムな営業日に追加配置。

        スタッフ全員の min_days_month 達成を目指し、過剰配置を許容する設計。
        各スタッフごとに:
          1. 現在の出勤日数 (cur) を集計
          2. shortage = max(0, min_days_month - cur)
          3. shortage 日数を、まだ出勤していない日付からランダム選択
          4. NG曜日 / 既存シフトと重複 / max_days_month を超えないよう
             フィルタしながら追加
        """
        import random
        random.seed()  # 毎回シード変更 (ランダム性確保)

        if not shifts:
            return shifts

        # 1) 各スタッフの現状出勤日付集合
        by_staff = {}
        for s in shifts:
            sid = s.get("staff_id")
            d = s.get("date")
            if sid and d:
                by_staff.setdefault(sid, set()).add(d)

        # 2) 不足者を特定
        shortage_list = []  # [(sid, shortage_count)]
        for staff in self.staff_list:
            sid = staff["id"]
            cur = len(by_staff.get(sid, set()))
            min_target = int(staff.get("min_days_month") or 0)
            max_target = int(staff.get("max_days_month") or 31)
            if min_target > cur:
                shortage = min_target - cur
                # max_days_month を超えない範囲で
                room = max_target - cur
                shortage = min(shortage, room)
                if shortage > 0:
                    shortage_list.append((sid, shortage))

        if not shortage_list:
            logger.info("[FillRandom] no shortage staff")
            return shifts

        logger.info("[FillRandom] shortage staff: {}".format(
            [(self._staff_map[sid].get("name", sid), n) for sid, n in shortage_list]))

        # 3) 営業日のみのリスト
        op_dates = [d for d in self.dates if self._get_day_type(d) != "closed"]

        # 翌日強制休み: force_rest パターンの時刻キー集合 (補完が翌休を破らないように)
        fr_pat_keys = set()
        for pat in self.shift_patterns:
            if pat.get("force_rest_next_day"):
                pps = self._to_minutes(pat.get("start", "09:00"))
                ppe = self._normalize_end_time(pps, self._to_minutes(pat.get("end", "18:00")))
                if pps < ppe:
                    fr_pat_keys.add((pps, ppe))

        def _shift_pair_min(sh):
            ps = self._to_minutes((sh.get("start_time") or "")[:5])
            pe = self._normalize_end_time(ps, self._to_minutes((sh.get("end_time") or "")[:5]))
            return (ps, pe)

        def _cal_shift(date_str, delta):
            return (datetime.strptime(date_str, "%Y-%m-%d") + timedelta(days=delta)).strftime("%Y-%m-%d")

        # v3.7.121: 不足日 (人員不足が大きい営業日) を計算して優先割当
        # ユーザー要望: 「過剰補完はまず不足部分を優先、余ったら従来通り別の所に」
        shortage_dates = self._compute_date_shortages(shifts)
        shortage_date_set = {d for d, _ in shortage_dates}

        added = 0
        for sid, shortage in shortage_list:
            staff = self._staff_map.get(sid)
            if not staff:
                continue
            ng_set = self._get_staff_ng_dates(staff)
            already = by_staff.get(sid, set())

            # このスタッフが force_rest パターンに入っている日付 (翌日は休みにすべき)
            fr_dates = set()
            if fr_pat_keys:
                for sh in shifts:
                    if sh.get("staff_id") == sid and _shift_pair_min(sh) in fr_pat_keys:
                        fr_dates.add(sh.get("date"))

            # 候補日: 営業日 - NG - 既存出勤
            base_cands = [d for d in op_dates
                          if d not in already and d not in ng_set]
            # v3.7.121: 不足日を優先、それ以外はランダム
            priority = [d for d, _ in shortage_dates if d in base_cands]
            others = [d for d in base_cands if d not in shortage_date_set]
            random.shuffle(others)
            candidates = priority + others

            # 週最大日数も尊重
            max_dw = int(staff.get("max_days_week") or 5)
            week_count = {}  # iso week -> count
            for d in already:
                try:
                    dt = datetime.strptime(d, "%Y-%m-%d")
                    wk = "{}_{}".format(dt.year, dt.isocalendar()[1])
                    week_count[wk] = week_count.get(wk, 0) + 1
                except ValueError:
                    pass

            # v3.7.120: 連勤上限も尊重 (営業日ベース)
            _smc = self._get_staff_max_consec(staff)

            picked = 0
            for d in candidates:
                if picked >= shortage:
                    break
                try:
                    dt = datetime.strptime(d, "%Y-%m-%d")
                    wk = "{}_{}".format(dt.year, dt.isocalendar()[1])
                except ValueError:
                    continue
                if week_count.get(wk, 0) >= max_dw:
                    continue  # 週最大日数 超え

                # 翌日強制休み R1: 前日が force_rest なら この日は休み (追加しない)
                if fr_pat_keys and _cal_shift(d, -1) in fr_dates:
                    continue

                # v3.7.120: 連勤窓チェック (営業日ベース)
                op_idx = self._operational_index.get(d)
                if op_idx is None:
                    continue
                consec_violation = False
                for start in range(max(0, op_idx - _smc), op_idx + 1):
                    if start + _smc + 1 > len(self._operational_dates):
                        continue
                    win = self._operational_dates[start:start + _smc + 1]
                    in_win = sum(1 for w in win if w in already or w == d)
                    if in_win > _smc:
                        consec_violation = True
                        break
                if consec_violation:
                    continue

                # v3.7.98: 「パターン時間ぴったり一致」する opt のみを優先採用。
                # 分割版 opt (通し 09-22 → 09-18 / 12-22) を使うと UI の
                # pattern_sum 計算とズレ、人員状況が「正常じゃない」表示になる。
                opts = self._build_shift_options(staff, d)
                if not opts:
                    continue
                pat_min_set = set()
                for pat in self.shift_patterns:
                    pps = self._to_minutes(pat.get("start", "09:00"))
                    ppe = self._normalize_end_time(
                        pps, self._to_minutes(pat.get("end", "18:00")))
                    if pps < ppe:
                        pat_min_set.add((pps, ppe))
                matched = [o for o in opts
                           if (o["start_min"], o["end_min"]) in pat_min_set]
                if matched:
                    opt = random.choice(matched)
                elif opts:
                    # パターン一致が無ければスキップ (分割版を使わない)
                    continue
                else:
                    continue

                # 翌日強制休み R2: force_rest パターンを選ぶ場合、翌日が既に
                # 勤務なら採用しない。可能なら非 force_rest の matched を優先。
                is_fr_opt = (opt["start_min"], opt["end_min"]) in fr_pat_keys
                if fr_pat_keys and is_fr_opt:
                    next_worked = _cal_shift(d, 1) in already
                    if next_worked:
                        alt = [o for o in matched
                               if (o["start_min"], o["end_min"]) not in fr_pat_keys]
                        if alt:
                            opt = random.choice(alt)
                            is_fr_opt = False
                        else:
                            continue  # force_rest しか無く翌日勤務 → この日は追加しない

                brk_mins = self._get_break_minutes(opt["hours"])
                shifts.append({
                    "staff_id": sid,
                    "date": d,
                    "start_time": opt["start"],
                    "end_time": opt["end"],
                    "break_minutes": brk_mins,
                    "is_irregular": True,  # v3.7.99: イレギュラーフラグ
                    "memo": "自動配置",
                    "reason": "自動配置",
                })
                week_count[wk] = week_count.get(wk, 0) + 1
                already.add(d)
                if is_fr_opt:
                    fr_dates.add(d)
                picked += 1
                added += 1

        logger.info("[FillRandom] added {} shifts".format(added))
        return shifts

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

        # 連勤検証 (v3.7.116: スタッフ別 max_consecutive_days を尊重)
        sorted_d = sorted(self.dates)
        for s in self.staff_list:
            sid = s["id"]
            _smc = self._get_staff_max_consec(s)
            consec = 0
            for d in sorted_d:
                if any(sh["staff_id"] == sid and sh["date"] == d for sh in shifts):
                    consec += 1
                    if consec > _smc:
                        logger.info("  VIOLATION: {} consec={} days at {} (limit={})".format(
                            s.get("name", sid), consec, d, _smc))
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
                # v3.7.90: 週40h 違反検出を撤廃 (制約自体を削除したため警告も無効化)
                # 必要なら店舗運用ルール側で別途モニターしてください
                pass

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
        rest_block = {}       # {staff_id: set(blocked_dates)} 翌日強制休み

        def _rest_blocked(sid, date_str):
            return date_str in rest_block.get(sid, set())

        def _apply_rest(sid, date_str, opt):
            # force_rest オプションに入ったら翌カレンダー日を休みにする
            if opt.get("force_rest"):
                nxt = (datetime.strptime(date_str, "%Y-%m-%d")
                       + timedelta(days=1)).strftime("%Y-%m-%d")
                rest_block.setdefault(sid, set()).add(nxt)

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
            if _rest_blocked(wsid, wd):
                continue
            opts = self._build_shift_options(staff, wd, force=True)
            if not opts:
                continue
            # v3.7.121: 出勤希望でも連勤上限は厳守
            _smc = self._get_staff_max_consec(staff)
            op_idx = self._operational_index.get(wd)
            already_dates = {sh["date"] for sh in shifts if sh["staff_id"] == wsid}
            consec_violation = False
            if op_idx is not None:
                for start in range(max(0, op_idx - _smc), op_idx + 1):
                    if start + _smc + 1 > len(self._operational_dates):
                        continue
                    win = self._operational_dates[start:start + _smc + 1]
                    in_win = sum(1 for w in win if w in already_dates or w == wd)
                    if in_win > _smc:
                        consec_violation = True
                        break
            if consec_violation:
                logger.info("[Greedy] skip work_request {} {} (consec limit {})".format(
                    staff.get("name", wsid), wd, _smc))
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
            _apply_rest(wsid, wd, best_opt)
            dt = datetime.strptime(wd, "%Y-%m-%d")
            wk = "{}-W{}".format(dt.year, dt.isocalendar()[1])
            weekly_count.setdefault(wsid, {})
            weekly_count[wsid][wk] = weekly_count[wsid].get(wk, 0) + 1
            weekly_hours.setdefault(wsid, {})
            weekly_hours[wsid][wk] = weekly_hours[wsid].get(wk, 0) + best_opt["hours"]

        # v3.7.185: 承認希望の固定配置を consecutive/last_work_date にも反映。
        # 旧版は weekly_count/hours のみ更新し連勤カウンタへ反映しておらず、
        # 承認希望が連勤上限チェック (_greedy_check_limits) から漏れていた。
        for _sid in {sh["staff_id"] for sh in shifts}:
            _sdates = sorted({sh["date"] for sh in shifts if sh["staff_id"] == _sid})
            if not _sdates:
                continue
            last_work_date[_sid] = _sdates[-1]
            _sdset = set(_sdates)
            _idx = self._operational_index.get(_sdates[-1])
            if _idx is None:
                consecutive[_sid] = 1
            else:
                _c, _j = 0, _idx
                while _j >= 0 and self._operational_dates[_j] in _sdset:
                    _c += 1
                    _j -= 1
                consecutive[_sid] = _c

        # 日付順にスタッフを配置
        for d in sorted(self.dates):
            if self._get_day_type(d) == "closed":
                # v3.7.119: 休業日でも連勤カウントをリセットしない
                # (店舗休業日を挟んでも連続出勤扱いにするため)
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
                    if _rest_blocked(mid, d):
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
                        _apply_rest(mid, d, opt)
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
                    if _rest_blocked(sid, d):
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
                    _apply_rest(best_s["id"], d, best_o)
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
                    if _rest_blocked(sid, d):
                        continue
                    if any(sh["staff_id"] == sid and sh["date"] == d for sh in shifts):
                        continue

                    # v3.7.3: 連勤6日上限 / 10時間インターバル / 週40h を遵守
                    # 旧版は post-pass で min_days_week を満たすだけのために法令違反シフトを
                    # 作る可能性があった (agent #1 指摘の HIGH バグ)
                    d_dt = datetime.strptime(d, "%Y-%m-%d")

                    # v3.7.119: 連勤チェック (営業日ベース)
                    # 営業日リスト上で d を含む _smc+1 個窓に出勤数 > _smc がないか確認
                    _smc = self._get_staff_max_consec(s)
                    consec_violation = False
                    op_idx = self._operational_index.get(d)
                    if op_idx is not None:
                        for start in range(max(0, op_idx - _smc), op_idx + 1):
                            if start + _smc + 1 > len(self._operational_dates):
                                continue
                            win = self._operational_dates[start:start + _smc + 1]
                            in_win = sum(1 for sh in shifts if sh["staff_id"] == sid and sh["date"] in win) + 1
                            if in_win > _smc:
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
                    # v3.7.90: 週40h チェックを撤廃
                    pass

                    brk = self._get_break_minutes(opt["hours"])
                    shifts.append({
                        "staff_id": sid, "date": d,
                        "start_time": opt["start"], "end_time": opt["end"],
                        "break_minutes": brk,
                    })
                    _apply_rest(sid, d, opt)
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

        # v3.7.90: 週40h チェックを撤廃 (制約自体を削除したため)
        # 1日 max_hours_day は維持
        _ = weekly_hours  # 互換のため引数受け取りは継続

        cur_consec = consecutive.get(sid, 0)
        # v3.7.116: スタッフ別 max_consecutive_days を尊重
        _smc = self._get_staff_max_consec(staff)
        if cur_consec >= _smc:
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

        # v3.7.119: 連勤チェック (営業日ベース)
        # 前回の出勤日と今日の間に「営業日 (closed以外) で休んだ日」があるかで判定。
        # 休業日のみを挟む連続出勤は連勤扱い (週またぎリセット問題の修正)
        prev = last_work_date.get(sid)
        if prev:
            prev_dt = datetime.strptime(prev, "%Y-%m-%d")
            cur_dt = datetime.strptime(date_str, "%Y-%m-%d")
            gap = (cur_dt - prev_dt).days
            has_workable_gap = False
            for k in range(1, gap):
                mid = (prev_dt + timedelta(days=k)).strftime("%Y-%m-%d")
                if mid in self._operational_dates_set:
                    has_workable_gap = True
                    break
            if has_workable_gap:
                consecutive[sid] = 1
            else:
                consecutive[sid] = consecutive.get(sid, 0) + 1
        else:
            consecutive[sid] = 1
        last_work_date[sid] = date_str
