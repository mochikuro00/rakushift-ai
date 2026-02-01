    // --- 自動作成 (Python + Gemini) ---
    async runAutoFill() {
        if (!confirm('AIシフト生成を開始しますか？\n（現在のシフトは上書きされます）')) return;

        this.showLoading(true);
        try {
            // 1. 期間の日付リストを作成 (ここが重要！)
            const year = this.state.currentDate.getFullYear();
            const month = this.state.currentDate.getMonth();
            const lastDay = new Date(year, month + 1, 0).getDate();
            const dates = [];
            
            for (let d = 1; d <= lastDay; d++) {
                const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                dates.push(dateStr);
            }
            
            console.log(`Generating shifts for ${dates.length} days:`, dates); // ログで確認

            if (dates.length === 0) {
                throw new Error("日付リストの生成に失敗しました。");
            }

            // 2. ペイロード作成
            const payload = {
                staff_list: this.state.staff,
                config: this.state.config,
                dates: dates, // 生成した日付リスト
                mode: 'auto'
            };

            console.log("Sending request to Calculation Engine...", payload); // データの中身を確認

            // 3. API呼び出し
            const result = await API.generateShifts(payload);

            if (result.status === 'error') {
                throw new Error(result.message || '生成に失敗しました');
            }

            // 4. 結果の反映
            console.log("Server Response:", result);
            
            // 既存シフトをクリア（対象期間のみ）
            this.state.shifts = this.state.shifts.filter(s => !dates.includes(s.date));
            
            // 新しいシフトを追加
            if (result.shifts && result.shifts.length > 0) {
                result.shifts.forEach(s => {
                    // IDがない場合は付与
                    if (!s.id) s.id = 'gen_' + Math.random().toString(36).substr(2, 9);
                    this.state.shifts.push(s);
                });
                
                // 画面更新
                this.renderCurrentView();
                this.calculateMonthlyStats();
                this.showToast('シフトを生成しました', 'success');
                
                // バックグラウンド保存
                this.saveAllShifts(result.shifts);
            } else {
                this.showToast('条件を満たすシフトが作れませんでした', 'warning');
            }

        } catch (e) {
            console.error(e);
            this.showToast('エラー: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },
